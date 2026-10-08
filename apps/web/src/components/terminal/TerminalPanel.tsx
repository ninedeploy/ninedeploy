import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { KeyRound, Maximize2, Minimize2, RefreshCw, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import type { TerminalConnection, TerminalTargetInput } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Button, Input, cn } from '../ui.js';

/**
 * An interactive terminal over `/v1/terminals` (0.15, protocol v1).
 *
 * The session is created over HTTP (`POST /v1/terminals`, operator only) and
 * attached over a WebSocket with its single-use ticket. Input typed before the
 * server's `ready` is held by the SDK connection; the terminal size follows
 * the panel (resize messages). Close codes are explained in the terminal.
 *
 * Host shells (`target.kind === 'host'`) need a password re-check for every
 * session, so the panel asks for it before opening one.
 */

export type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'failed';

interface TerminalPanelProps {
  target: TerminalTargetInput;
  /** Title bar label, e.g. "web · shell". */
  title: string;
  onClose?: () => void;
}

const activeTerminals = new WeakMap<HTMLDivElement, Terminal>();

const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n || min)));

export function TerminalPanel({ target, title, onClose }: TerminalPanelProps) {
  // The raw xterm host is an IMPERATIVE node, deliberately outside React's
  // tree: toggling fullscreen MOVES this node between the inline host and the
  // overlay host, so the terminal, its socket and its scrollback survive.
  const inlineHostRef = useRef<HTMLDivElement>(null);
  const overlayScreenRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [fullscreen, setFullscreen] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const isHost = target.kind === 'host';
  // Host shells: the password re-check for the next session (null = ask).
  const [stepUp, setStepUp] = useState<{ password: string } | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const awaitingPassword = isHost && stepUp === null;
  const targetKey = JSON.stringify(target);

  // biome-ignore lint/correctness/useExhaustiveDependencies: targetKey stands for `target`; sessionKey re-runs the effect for a reconnect
  useEffect(() => {
    if (awaitingPassword) return;
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
    activeTerminals.set(termHost, term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    term.open(termHost);
    fit.fit();
    term.writeln(`Opening ${title}…`);
    setStatus('connecting');

    let disposed = false;
    let conn: TerminalConnection | null = null;
    let exit: { code: number | null; reason: string } | null = null;
    const password = stepUp?.password;

    api.terminals
      .create({
        target,
        cols: clamp(term.cols, 10, 500),
        rows: clamp(term.rows, 5, 200),
        ...(password ? { password } : {}),
      })
      .then((created) => {
        if (disposed) {
          // Unmounted while the session was being created: revoke its ticket.
          api.terminals.terminate(created.session.id).catch(() => undefined);
          return;
        }
        conn = api.terminals.connect(created, {
          onReady: () => {
            term.clear();
            setStatus('connected');
          },
          onData: (bytes) => term.write(bytes),
          onNotice: (message) => term.writeln(`\r\n${YELLOW(message)}`),
          onExit: (e) => {
            exit = e;
          },
          onClose: ({ code, message }) => {
            if (disposed) return;
            setStatus('closed');
            const detail = code === 1000 && exit?.code != null ? `The shell exited with code ${exit.code}.` : message;
            term.write(`\r\n${RED(`*** ${detail} ***`)}\r\n`);
          },
        });
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setStatus('failed');
        term.writeln(RED(err instanceof Error ? err.message : String(err)));
      });

    term.onData((data) => conn?.write(data));
    term.onResize(({ cols, rows }) => conn?.resize(cols, rows));

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      conn?.close();
      term.dispose();
      activeTerminals.delete(termHost);
      termHost.remove();
      termHostRef.current = null;
      fitRef.current = null;
    };
  }, [targetKey, sessionKey, stepUp, awaitingPassword]);

  // Move the imperative node between hosts when fullscreen toggles (and after
  // a reconnect created a new node), then re-fit once layout settled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionKey/stepUp re-run the move for the node a new session created
  useEffect(() => {
    const host = termHostRef.current;
    if (!host) return;
    const destination = fullscreen ? overlayScreenRef.current : inlineHostRef.current;
    if (destination && host.parentElement !== destination) destination.appendChild(host);
    const raf = requestAnimationFrame(() => fitRef.current?.fit());
    return () => cancelAnimationFrame(raf);
  }, [fullscreen, sessionKey, stepUp]);

  const handleReconnect = () => {
    // Every host session needs its own password re-check.
    if (isHost) setStepUp(null);
    else setSessionKey((k) => k + 1);
  };

  const handleClear = () => {
    const host = termHostRef.current;
    if (host) activeTerminals.get(host)?.clear();
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    setStepUp({ password: passwordDraft });
    setPasswordDraft('');
  };

  const statusLabel =
    status === 'connected' ? (
      <span className="text-emerald-300">● connected</span>
    ) : status === 'closed' || status === 'failed' ? (
      <span className="text-rose-300">× {status}</span>
    ) : awaitingPassword ? (
      <span className="text-amber-300">○ password required</span>
    ) : (
      <span className="text-slate-400">○ connecting</span>
    );

  const titlebar = (
    <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-[#0f172a]/95 px-4 py-2.5 select-none backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-rose-500/80 ring-1 ring-inset ring-rose-500/30" />
          <span className="h-3 w-3 rounded-full bg-amber-500/80 ring-1 ring-inset ring-amber-500/30" />
          <span className="h-3 w-3 rounded-full bg-emerald-500/80 ring-1 ring-inset ring-emerald-500/30" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon size={14} className="text-slate-400" />
          <span className="truncate font-mono text-xs font-semibold text-slate-200">{title}</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-0.5 font-mono text-[11px] font-medium">
          {statusLabel}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleReconnect}
          title="Open a new session"
          className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200"
        >
          <RefreshCw size={12} className={cn(status === 'connecting' && 'animate-spin')} />
          <span className="hidden sm:inline">Reconnect</span>
        </Button>
        <Button size="sm" variant="ghost" onClick={handleClear} title="Clear terminal output" className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200">
          <Trash2 size={12} />
          <span className="hidden sm:inline">Clear</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFullscreen((v) => !v)}
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

  const passwordForm = (
    <form onSubmit={submitPassword} className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <KeyRound size={22} className="text-amber-300" />
      <p className="max-w-md text-xs text-slate-300">
        A host shell is a root shell on the server. Confirm your password to open one. Accounts that sign in only
        through SSO: leave it empty within 10 minutes of signing in.
      </p>
      <Input
        type="password"
        aria-label="Your password"
        autoComplete="current-password"
        value={passwordDraft}
        onChange={(e) => setPasswordDraft(e.target.value)}
        className="max-w-xs"
      />
      <Button type="submit" size="sm">
        Open host shell
      </Button>
    </form>
  );

  return (
    <>
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0a101b] shadow-2xl transition-all duration-200',
          fullscreen ? 'hidden' : 'h-[520px] max-h-[70vh] w-full',
        )}
      >
        {titlebar}
        {awaitingPassword ? passwordForm : <div ref={inlineHostRef} className={screenClassName} />}
      </div>
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            className={cn(
              'fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md',
              (!fullscreen || awaitingPassword) && 'hidden',
            )}
          >
            <div className="flex h-[92vh] w-[95vw] max-w-7xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0a101b] shadow-2xl">
              {titlebar}
              <div ref={overlayScreenRef} className={screenClassName} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
