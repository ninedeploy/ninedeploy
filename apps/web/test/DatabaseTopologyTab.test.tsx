import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { DatabaseTopologyTab } from '../src/routes/database/DatabaseTopologyTab.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import type { DatabaseDetail as IDatabaseDetail } from '@ninedeploy/sdk';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, nodeTypes, children }: { nodes: Array<{ id: string; type: string; data: unknown }>; edges: unknown[]; nodeTypes?: Record<string, React.ComponentType<{ id: string; data: unknown }>>; children: React.ReactNode }) => (
    <div data-testid="react-flow" data-nodes={nodes.length} data-edges={edges.length}>
      {nodes.map((n) => {
        const NodeComp = nodeTypes?.[n.type];
        return NodeComp ? <NodeComp key={n.id} id={n.id} data={n.data} /> : null;
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
      {['dbCenter', 'dbConsumer', 'dbVolume', 'dbBackup', 'other'].map((t) => nodeColor?.({ type: t })).filter(Boolean).join(',')}
    </div>
  ),
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const mockDb: IDatabaseDetail = {
  id: 1,
  projectId: 1,
  name: 'prod-pg',
  slug: 'prod-pg',
  engine: 'postgres',
  version: '16',
  status: 'running',
  host: 'nd-db-prod-pg',
  port: 5432,
  username: 'postgres',
  database: 'main',
  connectionString: 'postgres://postgres:pwd@nd-db-prod-pg:5432/main',
  containerName: 'nd-db-prod-pg',
  volumeName: 'nd-db-prod-pg-data',
  cpuShares: 1024,
  memLimitMb: 512,
  attachedServices: [
    { id: 10, name: 'api-service', slug: 'api-service' },
    { id: 11, name: 'worker-service', slug: 'worker-service' },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('DatabaseTopologyTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders consumers, database center node, volume, and backup snapshot count', async () => {
    mockOf(api.backups.list).mockResolvedValue([
      { id: 1, databaseId: 1, status: 'completed', sizeBytes: 1024, createdAt: '2026-01-01T00:00:00Z' },
      { id: 2, databaseId: 1, status: 'completed', sizeBytes: 2048, createdAt: '2026-01-02T00:00:00Z' },
      { id: 3, databaseId: 99, status: 'completed', sizeBytes: 512, createdAt: '2026-01-02T00:00:00Z' },
    ] as never);

    renderWithProviders(<DatabaseTopologyTab db={mockDb} />);

    expect(await screen.findByText('Database Ecosystem & Mesh Topology')).toBeInTheDocument();
    expect(screen.getByText('api-service')).toBeInTheDocument();
    expect(screen.getByText('worker-service')).toBeInTheDocument();
    expect(screen.getByText('prod-pg')).toBeInTheDocument();
    expect(screen.getByText('nd-db-prod-pg')).toBeInTheDocument();
    expect(screen.getByText(':5432')).toBeInTheDocument();
    expect(screen.getByText('nd-db-prod-pg-data')).toBeInTheDocument();
    expect(await screen.findByText('2 snapshot(s) retained')).toBeInTheDocument();
  });

  it('renders correctly when no services are attached and no volumeName is set', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);

    const emptyDb: IDatabaseDetail = {
      ...mockDb,
      attachedServices: undefined as unknown as any,
      volumeName: null as unknown as string,
    };

    renderWithProviders(<DatabaseTopologyTab db={emptyDb} />);

    expect(await screen.findByText('prod-pg')).toBeInTheDocument();
    expect(screen.getByText('nd-db-prod-pg-data')).toBeInTheDocument();
    expect(screen.getByText('0 snapshot(s) retained')).toBeInTheDocument();
  });
});
