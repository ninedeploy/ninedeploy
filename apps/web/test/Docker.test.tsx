import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DockerDashboard } from '../src/routes/Docker.js';

const apiMock = vi.hoisted(() => ({
  api: {
    system: {
      resources: vi.fn(),
      dockerEvents: vi.fn(),
    },
    stats: {
      snapshot: vi.fn(),
    },
    containers: {
      compose: vi.fn(),
      inspect: vi.fn(),
    },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

// The inspector section is admin-gated; the role is mutable per test.
const authState = vi.hoisted(() => ({
  user: { id: 1, isOperator: true, email: 'admin@test', name: 'Admin' },
}));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => children,
  useAuth: () => ({ user: authState.user }),
}));

const resources = {
  containers: 7,
  volumes: 3,
  imagesSummary: { total: 12, active: 9, reclaimable: 3 },
  network: 'ninedeploy',
  images: [
    { repo: 'nginx', tag: 'latest', size: '190 MB' },
    { repo: 'postgres', tag: '16', size: '430 MB' },
  ],
};

const events = {
  events: [
    { time: '1786000000', type: 'container', action: 'start', name: 'nd-web-3', actor: 'ninedeploy' },
    { time: 'not-a-number', type: 'image', action: 'pull', name: 'nginx:latest', actor: '' },
  ],
};

const stats = {
  host: null,
  containers: [
    { name: 'nd-web-1', kind: 'service' as const, refId: 1, refName: 'Web', cpuPct: 1.5, memMb: 50, memLimitMb: 512 },
  ],
};

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DockerDashboard />
    </QueryClientProvider>,
  );
}

describe('DockerDashboard', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, isOperator: true, email: 'admin@test', name: 'Admin' };
    apiMock.api.system.resources.mockResolvedValue(resources as never);
    apiMock.api.system.dockerEvents.mockResolvedValue(events as never);
    apiMock.api.stats.snapshot.mockResolvedValue(stats as never);
    apiMock.api.containers.inspect.mockResolvedValue({
      id: 'c1',
      name: 'nd-web-1',
      state: { status: 'running', running: true },
      traefikTags: { 'traefik.enable': 'true' },
      raw: { Id: 'c1' },
    } as never);
    apiMock.api.containers.compose.mockResolvedValue({
      yaml: 'services:\n  nd-web-1:\n    image: node:20',
      inspect: {
        id: 'c1',
        name: 'nd-web-1',
        state: { status: 'running', running: true },
        traefikTags: { 'traefik.enable': 'true' },
        raw: { Id: 'c1' },
      },
    } as never);
  });

  it('renders the resource cards, image list and event feed', async () => {
    renderDashboard();
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/9 active · 3 reclaimable/)).toBeInTheDocument();
    expect(screen.getByText('ninedeploy')).toBeInTheDocument();
    expect(screen.getAllByText('nginx').length).toBeGreaterThan(0);
    expect(await screen.findByText('nd-web-3')).toBeInTheDocument();
    // Non-numeric event timestamps fall back to the raw string.
    expect(screen.getByText('not-a-number')).toBeInTheDocument();
    expect(apiMock.api.system.dockerEvents).toHaveBeenCalledWith(60);
  });

  it('inspects a container from the live containers list and tests tabs, copy and close', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDashboard();
    expect(await screen.findByText('nd-web-1')).toBeInTheDocument();
    expect(screen.getByText(/CPU: 1\.5%/)).toBeInTheDocument();

    const allInspectBtns = await screen.findAllByRole('button', { name: /inspect/i });
    // allInspectBtns[0] is form submit, allInspectBtns[1] is the container row button
    const rowInspectBtn = allInspectBtns[allInspectBtns.length - 1]!;
    fireEvent.click(rowInspectBtn);

    expect(await screen.findByText('docker-compose.runtime.yml')).toBeInTheDocument();
    expect(await screen.findByText(/image: node:20/)).toBeInTheDocument();

    // Test Copy Compose
    fireEvent.click(screen.getByRole('button', { name: /copy compose/i }));
    expect(writeText).toHaveBeenCalledWith('services:\n  nd-web-1:\n    image: node:20');

    // Switch to Traefik tags
    fireEvent.click(screen.getByRole('button', { name: /traefik tags/i }));
    expect(await screen.findByText('traefik.enable')).toBeInTheDocument();

    // Switch to Docker Inspect
    fireEvent.click(screen.getByRole('button', { name: /docker inspect/i }));
    expect(await screen.findByText('docker-inspect.json')).toBeInTheDocument();

    // Test Copy JSON
    fireEvent.click(screen.getByRole('button', { name: /copy json/i }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ Id: 'c1' }, null, 2));

    // Switch back to the compose subtab
    fireEvent.click(screen.getByRole('button', { name: /compose/i }));
    expect(await screen.findByText(/image: node:20/)).toBeInTheDocument();

    // Test Refresh button
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => {
      expect(apiMock.api.containers.compose).toHaveBeenCalled();
    });

    // Test Close button
    const closeBtns = screen.getAllByRole('button');
    const xBtn = closeBtns.find((b) => b.querySelector('svg.lucide-x'));
    if (xBtn) fireEvent.click(xBtn);
  });

  it('submits manual container name to inspect', async () => {
    renderDashboard();
    const input = screen.getByPlaceholderText('Inspect container name…');
    fireEvent.change(input, { target: { value: 'custom-db-1' } });
    const allInspectBtns = screen.getAllByRole('button', { name: /inspect/i });
    const formSubmitBtn = allInspectBtns[0]!;
    fireEvent.click(formSubmitBtn);
    await waitFor(() => {
      expect(apiMock.api.containers.compose).toHaveBeenCalledWith('custom-db-1');
    });
  });

  it('shows skeletons while loading and empty states without data', async () => {
    apiMock.api.system.resources.mockReturnValue(new Promise(() => {}));
    apiMock.api.system.dockerEvents.mockReturnValue(new Promise(() => {}));
    apiMock.api.stats.snapshot.mockReturnValue(new Promise(() => {}));
    renderDashboard();
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('renders empty-state variants', async () => {
    apiMock.api.system.resources.mockResolvedValue({
      containers: 0,
      volumes: 0,
      imagesSummary: { total: 0, active: 0, reclaimable: 0 },
      network: '',
      images: [],
    } as never);
    apiMock.api.system.dockerEvents.mockResolvedValue({ events: [] } as never);
    apiMock.api.stats.snapshot.mockResolvedValue({ containers: [] } as never);
    renderDashboard();
    expect(await screen.findByText('No images.')).toBeInTheDocument();
    expect(await screen.findByText('No recent events')).toBeInTheDocument();
    expect(await screen.findByText('No active containers found on host daemon.')).toBeInTheDocument();
  });

  it('shows the no-tags and no-raw fallbacks for a bare container', async () => {
    // A container without traefik tags / raw inspect shows the fallbacks.
    const bare = {
      id: 'c1',
      name: 'nd-web-1',
      state: { status: 'running', running: true },
      traefikTags: {},
      raw: undefined,
    };
    apiMock.api.containers.inspect.mockResolvedValue(bare as never);
    apiMock.api.containers.compose.mockResolvedValue({
      yaml: 'services:\n  nd-web-1:\n    image: node:20',
      inspect: bare,
    } as never);
    renderDashboard();
    await screen.findByText('nd-web-1');
    const allInspectBtns = screen.getAllByRole('button', { name: /inspect/i });
    fireEvent.click(allInspectBtns[allInspectBtns.length - 1]!);
    expect(await screen.findByText('docker-compose.runtime.yml')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /traefik tags/i }));
    expect(await screen.findByText(/No Traefik tags discovered/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /docker inspect/i }));
    expect(await screen.findByText('// Loading or unavailable')).toBeInTheDocument();
  });

  it('hides the inspector behind an admin gate for members', async () => {
    authState.user = { id: 5, isOperator: false, email: 'm@test', name: 'Member' };
    renderDashboard();
    expect(await screen.findByText('nd-web-1')).toBeInTheDocument();
    expect(screen.getByText(/Admin access required for the inspector/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Inspect container name…')).not.toBeInTheDocument();
  });

  it('ignores an inspector submit with an empty container name', async () => {
    renderDashboard();
    await screen.findByText('nd-web-1');
    const formSubmitBtn = screen.getAllByRole('button', { name: /inspect/i })[0]!;
    fireEvent.click(formSubmitBtn);
    // No selection happens — the compose endpoint is not called.
    expect(apiMock.api.containers.compose).not.toHaveBeenCalled();
  });
});
