import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Maximize2, Minimize2, RefreshCw, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import { execWsUrl, websocketAuthProtocols } from '../lib/api.js';
import { Button, cn } from './ui.js';

interface ContainerTerminalProps {
  serviceId: number;
  serviceName?: string;
  onClose?: () => void;
}

const activeTerminals = new WeakMap<HTMLDivElement, Terminal>();

export function ContainerTerminal({ serviceId, serviceName, onClose }: ContainerTerminalProps) {
  // The raw xterm host is an IMPERATIVE node, deliberately outside React's
  // tree. Toggling fullscreen MOVES this one node between the inline host and
  // the overlay host (appendChild), so the terminal, its WebSocket session and
  // its scrollback all survive the toggle. The previous implementation swapped
  // the returned tree between inline and portal, which remounted the container
  // div and left the live terminal writing into a detached node until the
  // user clicked Reconnect.
  const inlineHostRef = useRef<HTMLDivElement>(null);
  const overlayScreenRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [connected, setConnected] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionKey is intentionally used to re-trigger the effect for reconnect
  useEffect(() => {
    const termHost = document.createElement('div');
    termHost.className = 'relative h-full w-full overflow-hidden focus:outline-none';
    termHostRef.current = termHost;
    inlineHostRef.current?.appendChild(termHost);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      theme: { background: '#0a0a10', foreground: '#cbd5e1', cursor: '#6366f1' },
    });
    if (termHost instanceof HTMLDivElement) activeTerminals.set(termHost, term);

    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    term.open(termHost);
    fit.fit();

    term.writeln('Connecting to container shell…');

    const ws = new WebSocket(execWsUrl(serviceId), websocketAuthProtocols());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setConnected(true);
      term.clear();
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else {
        term.write(e.data as string);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      term.write('\r\n\x1b[31m*** Connection closed ***\x1b[0m\r\n');
    };

    ws.onerror = () => {
      setConnected(false);
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const onResize = () => {
      fit.fit();
    };
    window.addEventListener('resize', onResize);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      ws.close();
      term.dispose();
      if (activeTerminals.get(termHost) === term) activeTerminals.delete(termHost);
      termHost.remove();
      termHostRef.current = null;
      fitRef.current = null;
    };
  }, [serviceId, sessionKey]);

  // Move the imperative terminal node between hosts when fullscreen toggles,
  // then re-fit once the destination layout has settled. appendChild of an
  // existing node RE-PARENTS it — xterm keeps rendering, the socket stays up.
  // r210: also after a reconnect (a NEW node, attached inline by the session
  // effect above): Reconnect sits in the fullscreen title bar, and the fresh
  // session used to render into the hidden inline card, leaving the overlay
  // blank. Declared after the session effect, so it runs after it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: serviceId/sessionKey re-run the move for the node a new session created
  useEffect(() => {
    const host = termHostRef.current;
    if (!host) return;
    const destination = fullscreen ? overlayScreenRef.current : inlineHostRef.current;
    if (destination && host.parentElement !== destination) {
      destination.appendChild(host);
    }
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit();
    });
    return () => cancelAnimationFrame(raf);
  }, [fullscreen, serviceId, sessionKey]);

  const handleReconnect = () => {
    setSessionKey((k) => k + 1);
  };

  const handleClear = () => {
    const host = termHostRef.current;
    if (host) activeTerminals.get(host)?.clear();
  };

  const toggleFullscreen = () => {
    setFullscreen((v) => !v);
  };

  const titlebar = (
    <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-[#0f172a]/95 px-4 py-2.5 select-none backdrop-blur-md">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-rose-500/80 ring-1 ring-inset ring-rose-500/30" />
          <span className="h-3 w-3 rounded-full bg-amber-500/80 ring-1 ring-inset ring-amber-500/30" />
          <span className="h-3 w-3 rounded-full bg-emerald-500/80 ring-1 ring-inset ring-emerald-500/30" />
        </div>

        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-slate-400" />
          <span className="font-mono text-xs font-semibold text-slate-200">
            {serviceName ? `${serviceName} · sh` : 'container shell'}
          </span>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium font-mono">
          {connected ? (
            <span className="text-emerald-300">● connected</span>
          ) : (
            <span className="text-slate-400">○ connecting</span>
          )}
        </div>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleReconnect}
          title="Reconnect shell session"
          className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200"
        >
          <RefreshCw size={12} className={cn(!connected && 'animate-spin')} />
          <span className="hidden sm:inline">Reconnect</span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={handleClear}
          title="Clear terminal output"
          className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200"
        >
          <Trash2 size={12} />
          <span className="hidden sm:inline">Clear</span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={toggleFullscreen}
          title={fullscreen ? 'Restore window size (Esc)' : 'Expand full screen'}
          className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200"
        >
          {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </Button>

        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            title="Close terminal"
            className="ml-1 h-7 px-2 text-xs text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
          >
            <X size={13} />
            <span>close</span>
          </Button>
        )}
      </div>
    </div>
  );

  const screenClassName = 'terminal-container relative flex-1 min-h-0 w-full overflow-hidden focus:outline-none';

  return (
    <>
      {/* Inline terminal card — the xterm node lives here by default. */}
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0a101b] shadow-2xl transition-all duration-200',
          fullscreen ? 'hidden' : 'h-[520px] max-h-[70vh] w-full',
        )}
      >
        {titlebar}
        <div ref={inlineHostRef} className={screenClassName} />
      </div>

      {/* Fullscreen overlay — stable portal target; the xterm node moves in. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            className={cn(
              'fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md',
              !fullscreen && 'hidden',
            )}
          >
            <div
              className={cn(
                'flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0a101b] shadow-2xl transition-all duration-200',
                fullscreen ? 'h-[92vh] w-[95vw] max-w-7xl' : 'h-[520px] w-full',
              )}
            >
              {titlebar}
              <div ref={overlayScreenRef} className={screenClassName} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
