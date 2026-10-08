import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockOf, renderRoute, renderWithProviders } from './helpers.js';

/**
 * 0.15 mount points (T6): each new surface is reachable from the page that
 * owns it — database shells, the Terminals card in Settings → Security, the
 * node terminal capability and host shells on Servers, and the Traffic tab on
 * the Traefik page. A removed mount fails here.
 */

vi.mock('../src/lib/api.js', async () => ({ ...(await import('./apiMock.js')).createFakeApiModule(), authedFetch: vi.fn() }));

const authState = vi.hoisted(() => ({ user: { id: 1, email: 'op@x.test', isOperator: true } as { id: number; email: string; isOperator: boolean } | null }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: authState.user, loading: false, logout: vi.fn() }),
}));

vi.mock('../src/components/terminal/TerminalPanel.js', () => ({
  TerminalPanel: ({ target, title, onClose }: { target: unknown; title: string; onClose?: () => void }) => (
    <div data-testid="terminal-panel" data-target={JSON.stringify(target)}>
      {title}
      <button type="button" onClick={onClose}>
        close terminal
      </button>
    </div>
  ),
}));
vi.mock('../src/routes/traefik/TrafficAnalyticsCard.js', () => ({ TrafficAnalyticsCard: () => <div>traffic analytics card</div> }));
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

import { api } from '../src/lib/api.js';
import { DatabaseDetail } from '../src/routes/DatabaseDetail.js';
import { SecuritySection } from '../src/routes/settings/SecuritySection.js';
import { Servers, TerminalCapabilityBadges } from '../src/routes/Servers.js';
import { Traefik } from '../src/routes/Traefik.js';

const db = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'prod-pg',
  slug: 'prod-pg',
  engine: 'postgres',
  version: '16',
  status: 'running',
  host: 'nd-db-prod-pg',
  port: 5432,
  containerName: 'nd-db-prod-pg',
  attachedServices: [],
  createdAt: '2026-08-17T12:00:00.000Z',
  updatedAt: '2026-08-17T12:00:00.000Z',
  ...over,
});

const panel = () => screen.getByTestId('terminal-panel');

describe('0.15 wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, email: 'op@x.test', isOperator: true };
    mockOf(api.terminals.settings.get).mockResolvedValue({
      hostTerminalEnabled: false,
      hostTerminalForbiddenByEnv: false,
      idleTimeoutMinutes: 15,
      maxSessionMinutes: 240,
      maxConcurrent: 10,
      retentionDays: 180,
    });
  });

  it('database page: operators open a shell or the engine client', async () => {
    mockOf(api.databases.get).mockResolvedValue(db());
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Shell' }));
    expect(JSON.parse(panel().dataset.target!)).toEqual({ kind: 'database', databaseId: 1, mode: 'shell' });
    expect(panel()).toHaveTextContent('prod-pg · shell');
    fireEvent.click(screen.getByRole('button', { name: 'Client' }));
    expect(JSON.parse(panel().dataset.target!)).toEqual({ kind: 'database', databaseId: 1, mode: 'client' });
    fireEvent.click(screen.getByRole('button', { name: 'close terminal' }));
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
  });

  it('database page: no client for engines without one, nothing for a stopped database or a member', async () => {
    mockOf(api.databases.get).mockResolvedValue(db({ engine: 'mongo' }));
    const first = renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    expect(await screen.findByRole('button', { name: 'Shell' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Client' })).toBeNull();
    first.unmount();
    mockOf(api.databases.get).mockResolvedValue(db({ status: 'stopped' }));
    const second = renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    expect(await screen.findByText('prod-pg')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shell' })).toBeNull();
    second.unmount();
    authState.user = { id: 2, email: 'm@x.test', isOperator: false };
    mockOf(api.databases.get).mockResolvedValue(db());
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    expect(await screen.findByText('prod-pg')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shell' })).toBeNull();
  });

  it('settings → security: the Terminals card is for operators', async () => {
    mockOf(api.settings.get).mockResolvedValue({});
    const first = renderWithProviders(<SecuritySection />);
    expect(await screen.findByRole('switch', { name: 'Host shells' })).toBeInTheDocument();
    first.unmount();
    authState.user = { id: 2, email: 'm@x.test', isOperator: false };
    renderWithProviders(<SecuritySection />);
    await waitFor(() => expect(api.settings.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('switch', { name: 'Host shells' })).toBeNull();
  });

  it('servers: shows each node terminal capability; host shells appear only while enabled', async () => {
    mockOf(api.servers.list).mockResolvedValue([
      { id: 1, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: null, terminal: { host: true, container: true } },
      { id: 2, name: 'edge-2', host: '10.0.0.6', port: 4600, status: 'online', lastSeenAt: null, terminal: { host: false, container: false, reason: 'The agent is older.' } },
      { id: 3, name: 'edge-3', host: '10.0.0.7', port: 4600, status: 'online', lastSeenAt: null },
    ]);
    const first = renderWithProviders(<Servers />);
    expect(await screen.findByText('edge-1')).toBeInTheDocument();
    expect(screen.getByText(/The agent is older\. Update the agent to v0\.15\.0/)).toBeInTheDocument();
    expect(screen.getByText('host shell')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Panel host shell/ })).toBeNull();
    first.unmount();

    mockOf(api.terminals.settings.get).mockResolvedValue({
      hostTerminalEnabled: true,
      hostTerminalForbiddenByEnv: false,
      idleTimeoutMinutes: 15,
      maxSessionMinutes: 240,
      maxConcurrent: 10,
      retentionDays: 180,
    });
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: /Panel host shell/ }));
    expect(JSON.parse(panel().dataset.target!)).toEqual({ kind: 'host', serverId: null });
    expect(panel()).toHaveTextContent('panel host · host shell');
    // only edge-1 advertises a host shell
    const nodeShells = await screen.findAllByTitle('Open a root shell on this node');
    expect(nodeShells).toHaveLength(1);
    fireEvent.click(nodeShells[0]!);
    expect(JSON.parse(panel().dataset.target!)).toEqual({ kind: 'host', serverId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'close terminal' }));
    expect(screen.queryByTestId('terminal-panel')).toBeNull();
  });

  it('servers: capability badges without a host shell, and without the field (0.14 panel)', () => {
    const { container, rerender } = render(<TerminalCapabilityBadges cap={{ host: false, container: true }} />);
    expect(container).toHaveTextContent('host shell off');
    rerender(<TerminalCapabilityBadges cap={{ host: false, container: false }} />);
    expect(container).toHaveTextContent('The node agent does not offer terminals.');
    rerender(<TerminalCapabilityBadges cap={undefined} />);
    expect(container).toHaveTextContent('—');
  });

  it('traefik: operators get the Traffic tab', async () => {
    mockOf(api.traefik.get).mockResolvedValue({
      status: { running: true, version: '3.0.0', uptime: '1h', ports: { http: 80, https: 443 }, configDir: '/data/traefik' },
      certificates: [],
      routers: [],
      services: [],
      middlewares: [],
    });
    mockOf(api.traefik.logs).mockResolvedValue({ logs: [] });
    const first = renderWithProviders(<Traefik />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Traffic' }));
    expect(screen.getByText('traffic analytics card')).toBeInTheDocument();
    first.unmount();
    authState.user = { id: 2, email: 'm@x.test', isOperator: false };
    renderWithProviders(<Traefik />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Traffic' })).toBeNull();
  });
});
