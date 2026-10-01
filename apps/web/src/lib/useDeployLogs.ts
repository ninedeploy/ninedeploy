import { useEffect, useRef, useState } from 'react';
import { deployLogsWsUrl, websocketAuthProtocols } from './api.js';

/**
 * Only the tail of the log is rendered. The hook used to re-join the WHOLE
 * accumulated log on every WS message — O(n²) over a deploy's lifetime, which
 * froze the tab on multi-megabyte builds. Chunks now batch in a ref and flush
 * on an interval; the retained text is capped at the tail window below.
 */
const MAX_RETAINED_CHARS = 512 * 1024;
const FLUSH_MS = 200;
/** A proxy idle-timeout silently ends "live" logs mid-deploy; retry a bit. */
const RECONNECT_DELAY_MS = 2000;
const RECONNECT_ATTEMPTS = 2;
/** r565: how much of the received tail a reconnect replay must reproduce. */
const REPLAY_OVERLAP_CHARS = 256;

/** Stream a deployment's logs over WebSocket (backlog + live lines). */
export function useDeployLogs(serviceId: number | null, deploymentId: number | null) {
  const [lines, setLines] = useState('');
  const [open, setOpen] = useState(false);
  const activeId = useRef<number | null>(null);
  const chunksRef = useRef<string[]>([]);
  const linesRef = useRef('');

  useEffect(() => {
    if (serviceId == null || deploymentId == null) return;
    activeId.current = deploymentId;
    chunksRef.current = [];
    linesRef.current = '';
    setLines('');
    setOpen(false);

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let connectedBefore = false;
    let expectReplay = false;
    // r565: everything received for this deployment, measured independently
    // of the display buffer (which is trimmed to MAX_RETAINED_CHARS). The
    // server's stream is the log file byte for byte — backlog, then every
    // published line — so `received` is our offset into that file.
    let received = 0;
    let receivedTail = '';
    const accept = (text: string) => {
      if (text.length === 0) return;
      chunksRef.current.push(text);
      received += text.length;
      receivedTail =
        text.length >= REPLAY_OVERLAP_CHARS
          ? text.slice(-REPLAY_OVERLAP_CHARS)
          : (receivedTail + text).slice(-REPLAY_OVERLAP_CHARS);
    };
    // r299: per-connection teardown flag. activeId is shared across effect
    // runs, so a StrictMode re-mount or an A→B→A switch set it back to this
    // deployment before the old socket's (async) close fired: the orphan kept
    // appending lines, reconnected, and flagged the live stream "closed".
    let disposed = false;

    const flush = () => {
      if (chunksRef.current.length === 0) return;
      const chunk = chunksRef.current.join('');
      chunksRef.current = [];
      let next = linesRef.current + chunk;
      if (next.length > MAX_RETAINED_CHARS) next = next.slice(-MAX_RETAINED_CHARS);
      linesRef.current = next;
      setLines(next);
    };
    const flushTimer = setInterval(flush, FLUSH_MS);

    const connect = () => {
      ws = new WebSocket(deployLogsWsUrl(serviceId, deploymentId), websocketAuthProtocols());
      ws.onopen = () => {
        if (disposed) return;
        setOpen(true);
        attempts = 0; // a healthy connection refills the reconnect budget
        // r209: the server replays the WHOLE backlog on every connect, so the
        // first frame of a reconnection repeats what is already on screen.
        expectReplay = connectedBefore;
        connectedBefore = true;
      };
      ws.onmessage = (event) => {
        if (disposed || activeId.current !== deploymentId) return;
        const data = String(event.data);
        if (expectReplay) {
          expectReplay = false;
          // The replay is the whole log file again; only what lies past the
          // offset we already received is new (appending all of it doubled
          // the log per reconnect, and the Download with it). r565: matched
          // by offset + overlapping tail, not by searching for the HEAD of the
          // held text — that head moves once the buffer is trimmed, and a
          // live first frame that merely contained a short held log was
          // mistaken for a replay and wiped it.
          if (
            received > 0 &&
            data.length >= received &&
            data.slice(received - receivedTail.length, received) === receivedTail
          ) {
            accept(data.slice(received));
            return;
          }
        }
        accept(data);
      };
      ws.onerror = () => {
        if (!disposed) setOpen(false);
      };
      ws.onclose = () => {
        if (disposed) return;
        setOpen(false);
        flush();
        if (activeId.current === deploymentId && attempts < RECONNECT_ATTEMPTS) {
          attempts++;
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    };
    connect();

    return () => {
      // Setting activeId to null first makes the onclose handler below a
      // no-op for reconnects when the teardown is an unmount/switch.
      activeId.current = null;
      disposed = true;
      clearInterval(flushTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [serviceId, deploymentId]);

  return { lines, open };
}
