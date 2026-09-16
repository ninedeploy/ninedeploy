import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import { FanoutTargetsCard } from '../src/routes/service/SettingsTab.js';
import type { Service } from '@ninedeploy/sdk';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const svc = {
  id: 1, name: 'web', slug: 'web', type: 'docker', status: 'running', image: 'nginx:1.25',
  repoUrl: null, serverId: null, port: 3000, replicas: 1, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0,
} as unknown as Service;

describe('FanoutTargetsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.servers.list).mockResolvedValue([
      { id: 5, name: 'edge-1', host: '5.5.5.5', status: 'online' },
      { id: 6, name: 'edge-2', host: '6.6.6.6', status: 'online' },
    ] as never);
    mockOf(api.fanout.get).mockResolvedValue([
      { serverId: 5, runtimeId: 'web-t5-9', status: 'running' },
    ] as never);
  });

  it('lists candidate nodes with the live target status', async () => {
    renderWithProviders(<FanoutTargetsCard svc={svc} />);
    await screen.findByText('edge-1');
    expect(screen.getByText('edge-2')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    // The save button only appears once an edit diverges from the server.
    expect(screen.queryByRole('button', { name: /Save fan-out targets/ })).not.toBeInTheDocument();
  });

  it('renders nothing when there are no candidate nodes and no targets', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.fanout.get).mockResolvedValue([] as never);
    const view = renderWithProviders(<FanoutTargetsCard svc={svc} />);
    await waitFor(() => expect(api.fanout.get).toHaveBeenCalled());
    expect(view.container.querySelector('.rounded-xl')).toBeNull();
    view.unmount();
  });

  it('saves a new target set after ticking a node', async () => {
    mockOf(api.fanout.set).mockResolvedValue({ targets: [] } as never);
    renderWithProviders(<FanoutTargetsCard svc={svc} />);
    await screen.findByText('edge-1');
    fireEvent.click(screen.getByLabelText('Fan out to edge-2'));
    const save = await screen.findByRole('button', { name: /Save fan-out targets/ });
    fireEvent.click(save);
    await waitFor(() => expect(api.fanout.set).toHaveBeenCalledWith(1, [5, 6]));
  });
});
