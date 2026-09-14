import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { ArchitectureTab } from '../src/routes/service/ArchitectureTab.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import type { Service } from '@ninedeploy/sdk';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, nodeTypes, onNodeClick, onPaneClick, children }: any) => (
    <div data-testid="react-flow" data-nodes={nodes.length} data-edges={edges?.length} onClick={onPaneClick}>
      {nodes.map((n: any) => {
        const NodeComp = nodeTypes?.[n.type];
        return NodeComp ? (
          <div key={n.id} data-testid={`node-${n.id}`} onClick={(e) => { e.stopPropagation(); onNodeClick?.(e, n); }}>
            <NodeComp id={n.id} data={n.data} />
          </div>
        ) : null;
      })}
      {children}
    </div>
  ),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="flow-provider">{children}</div>,
  Background: () => <div data-testid="background" />,
  Controls: () => <div data-testid="controls" />,
  Handle: () => <div data-testid="handle" />,
  MiniMap: ({ nodeColor }: { nodeColor?: (n: { type?: string }) => string }) => (
    <div data-testid="minimap">
      {['svcMain', 'svcDb', 'svcGateway', 'svcStorage', 'svcDomain', 'other'].map((t) => nodeColor?.({ type: t })).filter(Boolean).join(',')}
    </div>
  ),
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const mockService: Service = {
  id: 1,
  projectIds: [],
  workspaceIds: [],
  labelIds: [],
  name: 'my-service',
  slug: 'my-service',
  type: 'docker',
  status: 'running',
  image: null,
  repoUrl: 'https://github.com/ninedeploy/demo',
  branch: 'main',
  sourceId: null,
  composeService: null,
  commitSha: 'abcdef1234567890',
  port: 3000,
  publishedPort: 8080,
  runtimeId: 'my-service-rt',
  volumeMount: '/app/data',
  healthPath: '/api/health',
  autoUrl: 'my-service.local',
  cpuShares: 512,
  cpuLimitMilli: 0,
  memLimitMb: 256,
  build: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('ArchitectureTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('renders all architecture nodes including domains, gateway, service, db, volume, and vault', async () => {
    mockOf(api.domains.list).mockResolvedValue([
      { id: 1, hostname: 'app.example.com', ssl: true, serviceId: 1 },
      { id: 2, hostname: 'http.example.com', ssl: false, serviceId: 1 },
    ] as never);
    mockOf(api.attachments.list).mockResolvedValue([
      { id: 10, databaseId: 5, envAlias: 'DATABASE_URL', database: { name: 'main-postgres', engine: 'postgres', status: 'running' } },
      { id: 11, databaseId: 6, envAlias: 'REDIS_URL', database: null },
    ] as never);
    mockOf(api.env.list).mockResolvedValue([
      { id: 1, key: 'PORT', value: '3000', isSecret: false },
      { id: 2, key: 'API_KEY', value: 'secret', isSecret: true },
    ] as never);

    renderWithProviders(<ArchitectureTab service={mockService} />);

    expect(await screen.findByText('app.example.com')).toBeInTheDocument();
    expect(screen.getByText('HTTPS / TLS 1.3')).toBeInTheDocument();
    expect(screen.getByText('http.example.com')).toBeInTheDocument();
    expect(screen.getByText('HTTP / Dynamic Route')).toBeInTheDocument();
    expect(screen.getByText('Traefik Ingress')).toBeInTheDocument();
    expect(screen.getByText('2 route(s)')).toBeInTheDocument();

    expect(screen.getByText('Git Repository')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('abcdef1')).toBeInTheDocument();

    expect(screen.getByText('Health Probe')).toBeInTheDocument();
    expect(screen.getByText('/api/health')).toBeInTheDocument();

    expect(screen.getByText('0.0.0.0:8080')).toBeInTheDocument();
    expect(screen.getByText('Direct TCP :8080')).toBeInTheDocument();

    expect(screen.getByText('my-service')).toBeInTheDocument();
    expect(screen.getByText(':3000')).toBeInTheDocument();
    expect(screen.getByText(':8080')).toBeInTheDocument();
    expect(screen.getByText('my-service-rt')).toBeInTheDocument();
    expect(screen.getByText(/512 cpu/)).toBeInTheDocument();

    expect(screen.getByText('main-postgres')).toBeInTheDocument();
    expect(screen.getByText('Database #6')).toBeInTheDocument();
    expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getByText('REDIS_URL')).toBeInTheDocument();

    expect(screen.getByText('/app/data')).toBeInTheDocument();
    expect(screen.getByText('2 keys (1 encrypted)')).toBeInTheDocument();
  });

  it('renders correctly for registry image without domains, publishedPort, volume, healthPath, or attached databases', async () => {
    mockOf(api.domains.list).mockResolvedValue([] as never);
    mockOf(api.attachments.list).mockResolvedValue([] as never);
    mockOf(api.env.list).mockResolvedValue([] as never);

    const imageService: Service = {
      ...mockService,
      image: 'ghcr.io/org/my-app:v1',
      repoUrl: null,
      commitSha: null,
      healthPath: null as unknown as string,
      port: null,
      publishedPort: null,
      runtimeId: null,
      volumeMount: null,
      cpuShares: null as unknown as number,
      memLimitMb: null as unknown as number,
    };

    renderWithProviders(<ArchitectureTab service={imageService} />);

    expect(await screen.findByText('my-service')).toBeInTheDocument();
    expect(screen.getByText('Container Registry')).toBeInTheDocument();
    expect(screen.getByText('ghcr.io/org/my-app:v1')).toBeInTheDocument();
    expect(screen.getByText(':—')).toBeInTheDocument();
    expect(screen.queryByText('Traefik Ingress')).not.toBeInTheDocument();
    expect(screen.queryByText('/app/data')).not.toBeInTheDocument();
    expect(screen.queryByText('Health Probe')).not.toBeInTheDocument();
    expect(screen.getByText('0 keys (0 encrypted)')).toBeInTheDocument();
  });

  it('renders correctly with cpuShares only, memLimitMb only, and custom buildPack', async () => {
    mockOf(api.domains.list).mockResolvedValue([] as never);
    mockOf(api.attachments.list).mockResolvedValue([] as never);
    mockOf(api.env.list).mockResolvedValue([] as never);

    const cpuOnlyService: Service = {
      ...mockService,
      branch: '',
      build: { buildPack: 'nixpacks' } as never,
      cpuShares: 1024,
      memLimitMb: null as unknown as number,
    };

    const { unmount } = renderWithProviders(<ArchitectureTab service={cpuOnlyService} />);
    expect(await screen.findByText('1024 cpu')).toBeInTheDocument();
    unmount();

    const memOnlyService: Service = {
      ...mockService,
      cpuShares: null as unknown as number,
      memLimitMb: 512,
    };

    renderWithProviders(<ArchitectureTab service={memOnlyService} />);
    expect(await screen.findByText('512MB')).toBeInTheDocument();
  });

  it('allows clicking nodes to open the Inspector Drawer and copy or navigate', async () => {
    mockOf(api.domains.list).mockResolvedValue([
      { id: 1, hostname: 'app.example.com', ssl: true, serviceId: 1 },
    ] as never);
    mockOf(api.attachments.list).mockResolvedValue([
      { id: 10, databaseId: 5, envAlias: 'DATABASE_URL', database: { name: 'main-postgres', engine: 'postgres', status: 'running' } },
    ] as never);
    mockOf(api.env.list).mockResolvedValue([] as never);

    renderWithProviders(<ArchitectureTab service={mockService} />);

    // Click on the Database node
    const dbNode = await screen.findByTestId('node-db-5');
    fireEvent.click(dbNode);

    expect(await screen.findByText('Selected: main-postgres')).toBeInTheDocument();
    expect(screen.getByText('Go to Database →')).toBeInTheDocument();

    // Click on the Domain node
    const domNode = screen.getByTestId('node-dom-1');
    fireEvent.click(domNode);

    expect(await screen.findByText('Selected: app.example.com')).toBeInTheDocument();
    const copyBtn = screen.getByRole('button', { name: /Copy Endpoint/i });
    fireEvent.click(copyBtn);
    expect(await screen.findByText('Copied')).toBeInTheDocument();

    // Click on Direct Port node
    const directNode = screen.getByTestId('node-direct-port');
    fireEvent.click(directNode);
    expect(await screen.findByText('Selected: 0.0.0.0:8080')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Copy Endpoint|Copied/i }));

    // Dismiss inspector
    const dismissBtn = screen.getByTitle('Dismiss inspector');
    fireEvent.click(dismissBtn);
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();

    // Click on Source Origin node (neither name nor hostname present)
    const sourceNode = screen.getByTestId('node-source-origin');
    fireEvent.click(sourceNode);
    expect(await screen.findByText('Selected: source-origin')).toBeInTheDocument();

    // Click on canvas pane to close
    fireEvent.click(domNode);
    expect(await screen.findByText('Selected: app.example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('react-flow'));
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
  });
});
