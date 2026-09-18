import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  getToken: vi.fn((): string | null => 'tok-1'),
  execWsUrl: vi.fn((id: number) => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/v1/services/${id}/exec`),
  websocketAuthProtocols: vi.fn(() => ['ninedeploy.bearer.tok-1']),
}));

vi.mock('../src/lib/api.js', () => apiMock);

const xtermMock = vi.hoisted(() => {
  const terminals: unknown[] = [];
  const fitAddons: unknown[] = [];
  class FakeTerminal {
    opts: unknown;
    loadAddon = vi.fn();
    open = vi.fn();
    writeln = vi.fn();
    clear = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onDataCb: ((data: string) => void) | null = null;
    constructor(opts: unknown) {
      this.opts = opts;
      terminals.push(this);
    }
    onData(cb: (data: string) => void) {
      this.onDataCb = cb;
    }
  }
  class FakeFitAddon {
    fit = vi.fn();
    constructor() {
      fitAddons.push(this);
    }
  }
  return { FakeTerminal, FakeFitAddon, terminals, fitAddons };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xtermMock.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xtermMock.FakeFitAddon }));

import { ContainerTerminal } from '../src/components/ContainerTerminal.js';

type FakeTerm = {
  opts: unknown;
  loadAddon: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  writeln: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onDataCb: ((d: string) => void) | null;
};

/** Let the pending rAF-driven refit (used after host moves) run. */
const settleFrame = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
};

describe('ContainerTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xtermMock.terminals.length = 0;
    xtermMock.fitAddons.length = 0;
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('boots a terminal into a host node, opens the socket and marks connected', async () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);

    expect(xtermMock.terminals).toHaveLength(1);
    const term = xtermMock.terminals[0] as FakeTerm;
    expect(term.opts).toEqual({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      theme: { background: '#0a0a10', foreground: '#cbd5e1', cursor: '#6366f1' },
    });
    expect(xtermMock.fitAddons).toHaveLength(1);
    const fit = xtermMock.fitAddons[0] as { fit: ReturnType<typeof vi.fn> };
    expect(term.loadAddon).toHaveBeenCalledWith(fit);
    // The terminal opens onto the imperative host div (never detached by a
    // React re-render — that was the fullscreen-remount defect).
    expect(term.open).toHaveBeenCalledTimes(1);
    expect(term.open.mock.calls[0]?.[0]).toBeInstanceOf(HTMLDivElement);
    expect(term.writeln).toHaveBeenCalledWith('Connecting to container shell…');

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://localhost/v1/services/1/exec');
    expect(ws?.protocols).toEqual(['ninedeploy.bearer.tok-1']);
    expect(ws?.binaryType).toBe('arraybuffer');

    act(() => ws?.open());
    expect(term.clear).toHaveBeenCalled();
    // Both titlebar copies (inline + overlay) reflect the live state.
    expect(screen.getAllByText(/● connected/).length).toBeGreaterThan(0);
    await settleFrame();
  });

  it('builds a wss URL on an https origin', () => {
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'panel.example.com' },
      addEventListener: realAdd,
      removeEventListener: realRemove,
    } as unknown as Window);
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('wss://panel.example.com/v1/services/1/exec');
  });

  it('uses an empty token when none is stored', () => {
    apiMock.getToken.mockReturnValue(null);
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://localhost/v1/services/1/exec');
  });

  it('writes binary and string messages to the terminal', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const term = xtermMock.terminals[0] as { write: ReturnType<typeof vi.fn> };
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.message(new ArrayBuffer(8)));
    expect(term.write).toHaveBeenCalledWith(new Uint8Array(new ArrayBuffer(8)));
    act(() => ws?.message('hello'));
    expect(term.write).toHaveBeenCalledWith('hello');
  });

  it('sends typed data over the socket while open, but not when closed', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const term = xtermMock.terminals[0] as FakeTerm;
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.open());
    act(() => term.onDataCb?.('abc'));
    expect(ws?.send).toHaveBeenCalledWith('abc');
    act(() => ws?.closeFromServer());
    act(() => term.onDataCb?.('def'));
    expect(ws?.send).toHaveBeenCalledTimes(1);
  });

  it('marks disconnected on close and writes a status line', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const term = xtermMock.terminals[0] as { write: ReturnType<typeof vi.fn> };
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.open());
    expect(screen.getAllByText(/● connected/).length).toBeGreaterThan(0);
    act(() => ws?.closeFromServer());
    expect(term.write).toHaveBeenCalledWith('\r\n\x1b[31m*** Connection closed ***\x1b[0m\r\n');
    expect(screen.getAllByText(/○ connecting/).length).toBeGreaterThan(0);
  });

  it('refits on window resize and cleans up on unmount', async () => {
    const view = render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const fit = xtermMock.fitAddons[0] as { fit: ReturnType<typeof vi.fn> };
    const term = xtermMock.terminals[0] as { dispose: ReturnType<typeof vi.fn> };
    const ws = FakeWebSocket.instances[0];

    await settleFrame();
    const afterBoot = fit.fit.mock.calls.length;
    expect(afterBoot).toBeGreaterThanOrEqual(1);

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(fit.fit.mock.calls.length).toBe(afterBoot + 1);

    view.unmount();
    expect(ws?.close).toHaveBeenCalled();
    expect(term.dispose).toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(fit.fit.mock.calls.length).toBe(afterBoot + 1);
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    render(<ContainerTerminal serviceId={1} onClose={onClose} />);
    act(() => screen.getAllByText('close')[0]!.click());
    expect(onClose).toHaveBeenCalled();
  });

  it('clears the existing terminal without reconnecting the shell', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const term = xtermMock.terminals[0] as { clear: ReturnType<typeof vi.fn> };
    term.clear.mockClear();
    const socketCount = FakeWebSocket.instances.length;
    act(() => screen.getAllByText('Clear')[0]!.click());
    expect(term.clear).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(socketCount);
  });

  it('reconnects the shell session on demand', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => screen.getAllByText('Reconnect')[0]!.click());
    // The real effect re-runs for the new session key: one more terminal+socket.
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(xtermMock.terminals).toHaveLength(2);
  });

  it('moves the terminal into the fullscreen overlay and back on Escape', async () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const term = xtermMock.terminals[0] as FakeTerm;
    const host = term.open.mock.calls[0]?.[0] as HTMLElement;

    act(() => screen.getAllByTitle('Expand full screen')[0]!.click());
    expect(screen.getAllByTitle('Restore window size (Esc)').length).toBeGreaterThan(0);
    // The imperative host was re-parented INTO the overlay — same node, so
    // the session and scrollback survive the toggle.
    const overlayScreen = host.parentElement;
    expect(overlayScreen).not.toBeNull();
    await settleFrame();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.getAllByTitle('Expand full screen').length).toBeGreaterThan(0);
  });

  it('r210: a reconnect while fullscreen renders the new session in the overlay', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const firstHost = (xtermMock.terminals[0] as FakeTerm).open.mock.calls[0]?.[0] as HTMLElement;
    const inlineHost = firstHost.parentElement;
    act(() => screen.getAllByTitle('Expand full screen')[0]!.click());
    const overlayScreen = firstHost.parentElement;
    expect(overlayScreen).not.toBe(inlineHost);
    act(() => screen.getAllByText('Reconnect')[0]!.click());
    const latest = xtermMock.terminals.at(-1) as FakeTerm;
    const newHost = latest.open.mock.calls[0]?.[0] as HTMLElement;
    expect(newHost.parentElement).toBe(overlayScreen);
  });

  it('marks the terminal disconnected when the socket errors', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    const ws = FakeWebSocket.instances[0] as unknown as { onerror?: () => void };
    expect(ws.onerror).toBeTypeOf('function');
    act(() => ws.onerror!());
    expect(screen.getAllByText(/○ connecting/).length).toBeGreaterThan(0);
  });

  it('ignores non-Escape keys in the fullscreen listener', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    act(() => screen.getAllByTitle('Expand full screen')[0]!.click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    // Still fullscreen — only Escape restores.
    expect(screen.getAllByTitle('Restore window size (Esc)').length).toBeGreaterThan(0);
  });

  it('shows the service name in the titlebar when provided', () => {
    render(<ContainerTerminal serviceId={1} serviceName="api" onClose={vi.fn()} />);
    expect(screen.getAllByText('api · sh').length).toBeGreaterThan(0);
  });

  it('clear always targets the LATEST terminal after a reconnect', () => {
    render(<ContainerTerminal serviceId={1} onClose={vi.fn()} />);
    act(() => screen.getAllByText('Reconnect')[0]!.click());
    const latest = xtermMock.terminals[xtermMock.terminals.length - 1] as { clear: ReturnType<typeof vi.fn> };
    latest.clear.mockClear();
    act(() => screen.getAllByText('Clear')[0]!.click());
    expect(latest.clear).toHaveBeenCalledOnce();
  });
});
