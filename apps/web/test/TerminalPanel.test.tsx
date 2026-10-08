import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalHandlers } from '@ninedeploy/sdk';

/**
 * 0.15: the protocol-v1 terminal (`/v1/terminals`). The SDK connection is
 * mocked here (its protocol is covered in packages/sdk); these tests pin what
 * the panel does with it: create → connect, input/resize wiring, the close
 * messages, the host-shell password re-check, fullscreen and reconnect.
 */

const conn = vi.hoisted(() => ({
  handlers: [] as TerminalHandlers[],
  instances: [] as Array<{ write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; ready: boolean }>,
}));

const apiMock = vi.hoisted(() => ({
  api: {
    terminals: {
      create: vi.fn(),
      connect: vi.fn(),
      terminate: vi.fn(),
    },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const xtermMock = vi.hoisted(() => {
  const terminals: unknown[] = [];
  const fitAddons: unknown[] = [];
  const size = { cols: 100, rows: 30 };
  class FakeTerminal {
    opts: unknown;
    cols = size.cols;
    rows = size.rows;
    loadAddon = vi.fn();
    open = vi.fn();
    writeln = vi.fn();
    clear = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onDataCb: ((data: string) => void) | null = null;
    onResizeCb: ((size: { cols: number; rows: number }) => void) | null = null;
    constructor(opts: unknown) {
      this.opts = opts;
      terminals.push(this);
    }
    onData(cb: (data: string) => void) {
      this.onDataCb = cb;
    }
    onResize(cb: (size: { cols: number; rows: number }) => void) {
      this.onResizeCb = cb;
    }
  }
  class FakeFitAddon {
    fit = vi.fn();
    constructor() {
      fitAddons.push(this);
    }
  }
  return { FakeTerminal, FakeFitAddon, terminals, fitAddons, size };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xtermMock.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xtermMock.FakeFitAddon }));

import { TerminalPanel } from '../src/components/terminal/TerminalPanel.js';
import { ContainerTerminal } from '../src/components/ContainerTerminal.js';

type FakeTerm = InstanceType<typeof xtermMock.FakeTerminal>;
const term = (i = -1) => xtermMock.terminals.at(i) as FakeTerm;
const created = (id = 7) => ({ session: { id }, ticket: 'abcdefghijklmnopq', ticketExpiresAt: '', attachPath: `/v1/terminals/${id}/attach` });
const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});
const settleFrame = () => act(async () => {
  await new Promise((r) => setTimeout(r, 25));
});

describe('TerminalPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xtermMock.terminals.length = 0;
    xtermMock.fitAddons.length = 0;
    conn.handlers.length = 0;
    conn.instances.length = 0;
    apiMock.api.terminals.create.mockResolvedValue(created());
    apiMock.api.terminals.terminate.mockResolvedValue({ ok: true, wasLive: false });
    apiMock.api.terminals.connect.mockImplementation((_c: unknown, handlers: TerminalHandlers) => {
      conn.handlers.push(handlers);
      const c = { write: vi.fn(), resize: vi.fn(), close: vi.fn(), ready: false };
      conn.instances.push(c);
      return c;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates a session sized to the terminal, connects with the ticket and goes live on ready', async () => {
    render(<TerminalPanel target={{ kind: 'database', databaseId: 3, mode: 'client' }} title="pg · client" />);
    expect(term().writeln).toHaveBeenCalledWith('Opening pg · client…');
    expect(screen.getAllByText(/○ connecting/).length).toBeGreaterThan(0);
    await settle();
    expect(apiMock.api.terminals.create).toHaveBeenCalledWith({ target: { kind: 'database', databaseId: 3, mode: 'client' }, cols: 100, rows: 30 });
    expect(apiMock.api.terminals.connect.mock.calls[0]?.[0]).toEqual(created());
    act(() => conn.handlers[0]!.onReady!({ sessionId: 7, target: { kind: 'database', label: 'pg', serverId: null } }));
    expect(term().clear).toHaveBeenCalled();
    expect(screen.getAllByText(/● connected/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('pg · client').length).toBeGreaterThan(0);
  });

  it('clamps an unmeasured terminal into the allowed size', async () => {
    xtermMock.size.cols = 0;
    xtermMock.size.rows = 900;
    try {
      render(<TerminalPanel target={{ kind: 'container', name: 'nd-x' }} title="x" />);
      await settle();
    } finally {
      xtermMock.size.cols = 100;
      xtermMock.size.rows = 30;
    }
    expect(apiMock.api.terminals.create.mock.calls[0]?.[0]).toMatchObject({ cols: 10, rows: 200 });
  });

  it('wires input, resize, output and notices to the connection', async () => {
    render(<TerminalPanel target={{ kind: 'service', serviceId: 1 }} title="web" />);
    // input before the connection exists is dropped by the optional chain
    term().onDataCb?.('early');
    term().onResizeCb?.({ cols: 1, rows: 1 });
    await settle();
    term().onDataCb?.('ls\r');
    term().onResizeCb?.({ cols: 132, rows: 40 });
    expect(conn.instances[0]!.write).toHaveBeenCalledWith('ls\r');
    expect(conn.instances[0]!.resize).toHaveBeenCalledWith(132, 40);
    const bytes = new Uint8Array([104, 105]);
    conn.handlers[0]!.onData!(bytes);
    expect(term().write).toHaveBeenCalledWith(bytes);
    conn.handlers[0]!.onNotice!('Ignored a control message');
    expect(term().writeln).toHaveBeenCalledWith(expect.stringContaining('Ignored a control message'));
  });

  it('explains the close: an exit code for a clean exit, else the close-code message', async () => {
    render(<TerminalPanel target={{ kind: 'service', serviceId: 1 }} title="web" />);
    await settle();
    act(() => {
      conn.handlers[0]!.onExit!({ code: 3, reason: 'shell_exited' });
      conn.handlers[0]!.onClose!({ code: 1000, reason: '', message: 'The shell exited.' });
    });
    expect(term().write).toHaveBeenCalledWith(expect.stringContaining('The shell exited with code 3.'));
    expect(screen.getAllByText(/× closed/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByTitle('Open a new session')[0]!);
    await settle();
    act(() => conn.handlers[1]!.onClose!({ code: 4408, reason: 'idle', message: 'The session was closed after being idle too long.' }));
    expect(term().write).toHaveBeenCalledWith(expect.stringContaining('idle too long'));
    act(() => conn.handlers[1]!.onClose!({ code: 1000, reason: '', message: 'The shell exited.' }));
    expect(term().write).toHaveBeenCalledWith(expect.stringContaining('*** The shell exited. ***'));
  });

  it('shows a refused create in the terminal', async () => {
    apiMock.api.terminals.create.mockRejectedValueOnce(new Error('Update the node agent to v0.15.0'));
    render(<TerminalPanel target={{ kind: 'service', serviceId: 1, serverId: 4 }} title="web" />);
    await settle();
    expect(term().writeln).toHaveBeenCalledWith(expect.stringContaining('Update the node agent to v0.15.0'));
    expect(screen.getAllByText(/× failed/).length).toBeGreaterThan(0);
    apiMock.api.terminals.create.mockRejectedValueOnce('plain');
    fireEvent.click(screen.getAllByTitle('Open a new session')[0]!);
    await settle();
    expect(term().writeln).toHaveBeenCalledWith(expect.stringContaining('plain'));
  });

  it('revokes a session that finished creating after unmount, and ignores late failures', async () => {
    let resolve!: (v: unknown) => void;
    apiMock.api.terminals.create.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { unmount } = render(<TerminalPanel target={{ kind: 'service', serviceId: 1 }} title="web" />);
    unmount();
    resolve(created(9));
    await settle();
    expect(apiMock.api.terminals.terminate).toHaveBeenCalledWith(9);
    expect(apiMock.api.terminals.connect).not.toHaveBeenCalled();

    apiMock.api.terminals.terminate.mockRejectedValueOnce(new Error('gone'));
    let reject!: (e: unknown) => void;
    apiMock.api.terminals.create.mockReturnValueOnce(new Promise((_r, j) => (reject = j)));
    const second = render(<TerminalPanel target={{ kind: 'service', serviceId: 1 }} title="web" />);
    const t = term();
    second.unmount();
    reject(new Error('late'));
    await settle();
    expect(t.writeln).not.toHaveBeenCalledWith(expect.stringContaining('late'));
  });

  it('closes the connection and ignores its close event on unmount', async () => {
    const { unmount } = render(<TerminalPanel target={{ kind: 'service', serviceId: 1 }} title="web" />);
    await settle();
    const t = term();
    unmount();
    expect(conn.instances[0]!.close).toHaveBeenCalled();
    expect(t.dispose).toHaveBeenCalled();
    conn.handlers[0]!.onClose!({ code: 1000, reason: '', message: 'x' });
    expect(t.write).not.toHaveBeenCalled();
  });

  it('host shells ask for the password first, send it once, and ask again on reconnect', async () => {
    render(<TerminalPanel target={{ kind: 'host', serverId: null }} title="panel host · host shell" onClose={vi.fn()} />);
    expect(xtermMock.terminals).toHaveLength(0);
    expect(screen.getAllByText(/password required/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open host shell' }));
    await settle();
    expect(apiMock.api.terminals.create).toHaveBeenCalledWith({ target: { kind: 'host', serverId: null }, cols: 100, rows: 30, password: 'pw' });
    fireEvent.click(screen.getAllByTitle('Open a new session')[0]!);
    expect(screen.getByLabelText('Your password')).toHaveValue('');
    // An SSO-only account submits no password (a fresh sign-in is the proof).
    fireEvent.click(screen.getByRole('button', { name: 'Open host shell' }));
    await settle();
    expect(apiMock.api.terminals.create).toHaveBeenLastCalledWith({ target: { kind: 'host', serverId: null }, cols: 100, rows: 30 });
  });

  it('refits on window resize; fullscreen moves the node and Escape restores it', async () => {
    render(<TerminalPanel target={{ kind: 'service', serviceId: 1 }} title="web" onClose={vi.fn()} />);
    await settle();
    const fit = xtermMock.fitAddons[0] as { fit: ReturnType<typeof vi.fn> };
    fit.fit.mockClear();
    act(() => window.dispatchEvent(new Event('resize')));
    expect(fit.fit).toHaveBeenCalled();
    const node = term().open.mock.calls[0]?.[0] as HTMLDivElement;
    fireEvent.click(screen.getAllByTitle('Expand full screen')[0]!);
    await settleFrame();
    expect(node.parentElement?.closest('.fixed')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(node.parentElement?.closest('.fixed')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await settleFrame();
    expect(node.parentElement?.closest('.fixed')).toBeNull();
    fireEvent.click(screen.getAllByTitle('Expand full screen')[0]!);
    fireEvent.click(screen.getAllByTitle('Restore window size (Esc)')[0]!);
    await settleFrame();
  });

  it('clear targets the latest terminal; close calls back', async () => {
    const onClose = vi.fn();
    render(<TerminalPanel target={{ kind: 'service', serviceId: 1 }} title="web" onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getAllByTitle('Open a new session')[0]!);
    await settle();
    fireEvent.click(screen.getAllByTitle('Clear terminal output')[0]!);
    expect(term(-1).clear).toHaveBeenCalled();
    expect(term(0).clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByTitle('Close terminal')[0]!);
    expect(onClose).toHaveBeenCalled();
  });

  it('clear is a no-op while the host-shell password is asked', () => {
    render(<TerminalPanel target={{ kind: 'host', serverId: 2 }} title="node · host shell" />);
    fireEvent.click(screen.getAllByTitle('Clear terminal output')[0]!);
    expect(xtermMock.terminals).toHaveLength(0);
  });
});

describe('ContainerTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xtermMock.terminals.length = 0;
    apiMock.api.terminals.create.mockResolvedValue(created());
    apiMock.api.terminals.connect.mockReturnValue({ write: vi.fn(), resize: vi.fn(), close: vi.fn(), ready: false });
  });

  it('opens a service target, with replica and node when given', async () => {
    const { unmount } = render(<ContainerTerminal serviceId={5} serviceName="api" replica={2} serverId={3} />);
    await waitFor(() => expect(apiMock.api.terminals.create).toHaveBeenCalled());
    expect(apiMock.api.terminals.create.mock.calls[0]?.[0].target).toEqual({ kind: 'service', serviceId: 5, replica: 2, serverId: 3 });
    expect(screen.getAllByText('api · shell').length).toBeGreaterThan(0);
    unmount();
    render(<ContainerTerminal serviceId={5} />);
    await waitFor(() => expect(apiMock.api.terminals.create).toHaveBeenCalledTimes(2));
    expect(apiMock.api.terminals.create.mock.calls[1]?.[0].target).toEqual({ kind: 'service', serviceId: 5 });
    expect(screen.getAllByText('container shell').length).toBeGreaterThan(0);
  });
});
