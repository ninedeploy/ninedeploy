import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestTab } from '../src/routes/service/ManifestTab.js';

const apiMock = vi.hoisted(() => ({
  api: {
    containers: {
      compose: vi.fn(),
      inspect: vi.fn(),
    },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

const mockService: any = {
  id: 1,
  name: 'Web App',
  slug: 'web-app',
  type: 'docker',
  status: 'running',
  port: 3000,
  containerName: 'nd-svc-web-app-1',
};

function renderTab(service = mockService) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ManifestTab service={service} />
    </QueryClientProvider>,
  );
}

describe('ManifestTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders compose manifest, switches subtabs and copies YAML & JSON', async () => {
    apiMock.api.containers.compose.mockResolvedValueOnce({
      yaml: 'services:\n  nd-svc-web-app-1:\n    image: node:20\n    labels:\n      - "traefik.enable=true"',
      inspect: {
        id: 'cid1',
        name: 'nd-svc-web-app-1',
        image: 'node:20',
        state: { status: 'running', running: true },
        traefikTags: {
          'traefik.enable': 'true',
          'traefik.http.routers.web.rule': 'Host(`app.dev`)',
        },
        raw: { Id: 'cid1', State: { Running: true } },
      },
    });

    apiMock.api.containers.inspect.mockResolvedValueOnce({
      id: 'cid1',
      name: 'nd-svc-web-app-1',
      image: 'node:20',
      state: { status: 'running', running: true },
      traefikTags: {
        'traefik.enable': 'true',
        'traefik.http.routers.web.rule': 'Host(`app.dev`)',
      },
      raw: { Id: 'cid1', State: { Running: true } },
    });

    renderTab();

    // Verify header and compose manifest
    await waitFor(() => expect(screen.getByText('nd-svc-web-app-1')).toBeInTheDocument());
    expect(screen.getByText(/RUNNING/i)).toBeInTheDocument();
    expect(screen.getByText(/docker-compose\.runtime\.yml/i)).toBeInTheDocument();
    expect(screen.getByText(/image: node:20/i)).toBeInTheDocument();

    // Copy YAML button
    fireEvent.click(screen.getByRole('button', { name: /copy compose/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('services:'));

    // Switch to Traefik subtab
    fireEvent.click(screen.getByRole('button', { name: /traefik dynamic tags/i }));
    expect(screen.getByText('traefik.http.routers.web.rule')).toBeInTheDocument();
    expect(screen.getByText('Host(`app.dev`)')).toBeInTheDocument();

    // Switch to Inspect subtab
    fireEvent.click(screen.getByRole('button', { name: /docker inspect raw/i }));
    expect(screen.getByText(/docker-inspect\.json/i)).toBeInTheDocument();
    expect(screen.getByText(/"Running": true/i)).toBeInTheDocument();

    // Copy JSON button
    fireEvent.click(screen.getByRole('button', { name: /copy json/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('"Id": "cid1"'));
  });

  it('supports direct containerName prop for databases or custom containers', async () => {
    apiMock.api.containers.compose.mockResolvedValueOnce({
      yaml: 'services:\n  nd-db-postgres-1:\n    image: postgres:16',
      inspect: {
        id: 'db-cid',
        name: 'nd-db-postgres-1',
        state: { status: 'running', running: true },
        traefikTags: {},
        raw: { Id: 'db-cid' },
      },
    });
    apiMock.api.containers.inspect.mockResolvedValueOnce({
      id: 'db-cid',
      name: 'nd-db-postgres-1',
      state: { status: 'running', running: true },
      traefikTags: {},
      raw: { Id: 'db-cid' },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ManifestTab containerName="nd-db-postgres-1" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('nd-db-postgres-1')).toBeInTheDocument();
    expect(screen.getByText(/image: postgres:16/i)).toBeInTheDocument();
  });

  it('shows the compose fallback when the container has no manifest', async () => {
    apiMock.api.containers.compose.mockResolvedValue({
      yaml: undefined,
      inspect: { id: 'x', name: 'bare', state: { status: 'created', running: false }, traefikTags: {}, raw: undefined },
    } as never);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ManifestTab containerName="bare" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('# No runtime compose manifest available for container.')).toBeInTheDocument();
  });
});
