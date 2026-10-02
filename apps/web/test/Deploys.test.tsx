import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Deploys } from '../src/routes/Deploys.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { useToast } from '../src/components/Toast.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

vi.mock('../src/lib/workspace.js', async () => {
  const { createWorkspaceMock } = await import('./apiMock.js');
  return createWorkspaceMock();
});

vi.mock('../src/lib/theme.js', async () => {
  const { createThemeMock } = await import('./apiMock.js');
  return createThemeMock();
});

vi.mock('../src/lib/mode.js', async () => {
  const { createModeMock } = await import('./apiMock.js');
  return createModeMock();
});

vi.mock('../src/components/Toast.js', async () => {
  const React = await import('react');
  return {
    useToast: () => ({ toast: vi.fn() }),
    ToastProvider: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});
void useToast; // type-only reference kept for symmetry with sibling tests; not used here.

function queueResponse(items: Array<Partial<{
  id: number;
  serviceId: number;
  serviceName: string;
  status: 'queued' | 'building' | 'deploying';
  commitSha: string | null;
  imageDigest: string | null;
  message: string | null;
  author: string | null;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}>>) {
  const byStatus = { queued: 0, building: 0, deploying: 0 };
  for (const it of items) byStatus[it.status!] += 1;
  return {
    items: items.map((it) => ({
      id: it.id ?? 1,
      serviceId: it.serviceId ?? 1,
      serviceName: it.serviceName ?? 'web',
      status: it.status ?? 'queued',
      commitSha: it.commitSha ?? null,
      imageDigest: it.imageDigest ?? null,
      message: it.message ?? null,
      author: it.author ?? null,
      trigger: it.trigger ?? 'user',
      startedAt: it.startedAt ?? null,
      finishedAt: it.finishedAt ?? null,
      createdAt: it.createdAt ?? new Date().toISOString(),
    })),
    count: items.length,
    byStatus,
  };
}

describe('Deploys (queue page)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'ada@example.com', name: 'Ada', isOperator: true },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('r562: a failed queue load shows an error with retry, not "Nothing in flight"', async () => {
    mockOf(api.deploys.queue).mockRejectedValueOnce(new Error('HTTP 503'));
    renderWithProviders(<Deploys />);
    expect(await screen.findByText('Could not load the deploy queue')).toBeInTheDocument();
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
    expect(screen.queryByText('Nothing in flight')).toBeNull();
    mockOf(api.deploys.queue).mockResolvedValue(queueResponse([]) as never);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing in flight')).toBeInTheDocument();
  });

  it('shows the empty state when the queue is empty', async () => {
    mockOf(api.deploys.queue).mockResolvedValue(queueResponse([]) as never);
    renderWithProviders(<Deploys />);
    expect(await screen.findByText('Nothing in flight')).toBeInTheDocument();
  });

  it('renders every in-flight row with status + service + commit', async () => {
    mockOf(api.deploys.queue).mockResolvedValue(
      queueResponse([
        {
          id: 11,
          serviceId: 1,
          serviceName: 'web',
          status: 'building',
          commitSha: 'abcdef1234567890',
          message: 'Build trigger',
          trigger: 'webhook',
          startedAt: new Date().toISOString(),
        },
        {
          id: 12,
          serviceId: 1,
          serviceName: 'web',
          status: 'queued',
          commitSha: 'fedcba0987654321',
          message: 'Manual trigger',
          trigger: 'user',
        },
        {
          id: 13,
          serviceId: 2,
          serviceName: 'api',
          status: 'queued',
          imageDigest: 'sha256:deadbeefcafebabe',
          message: 'Image update',
          trigger: 'cli',
        },
      ]) as never,
    );
    renderWithProviders(<Deploys />);
    // All three services appear.
    expect((await screen.findAllByText('web')).length).toBe(2);
    expect(await screen.findByText('api')).toBeInTheDocument();
    // Status badges
    expect(screen.getAllByText('Building').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    // Commit short-sha + image digest
    expect(screen.getByText('abcdef1')).toBeInTheDocument();
    expect(screen.getByText('fedcba0')).toBeInTheDocument();
    expect(screen.getByText('sha256:deadbeef')).toBeInTheDocument();
    // The header counters reflect the mocked counts.
    expect(screen.getByText('1 building')).toBeInTheDocument();
    expect(screen.getByText('0 deploying')).toBeInTheDocument();
    expect(screen.getByText('2 queued')).toBeInTheDocument();
  });

  it('shows the per-service queue position on queued rows', async () => {
    mockOf(api.deploys.queue).mockResolvedValue(
      queueResponse([
        { id: 21, serviceId: 1, serviceName: 'web', status: 'queued' },
        { id: 22, serviceId: 1, serviceName: 'web', status: 'queued' },
        { id: 23, serviceId: 1, serviceName: 'web', status: 'queued' },
      ]) as never,
    );
    renderWithProviders(<Deploys />);
    await waitFor(() => {
      expect(screen.getAllByText(/queue #/)).toHaveLength(3);
    });
    expect(screen.getByText('queue #1 of 3')).toBeInTheDocument();
    expect(screen.getByText('queue #2 of 3')).toBeInTheDocument();
    expect(screen.getByText('queue #3 of 3')).toBeInTheDocument();
  });

  it('cancels a deployment when the cancel button is clicked', async () => {
    const cancelSpy = vi.fn().mockResolvedValue({ ok: true, status: 'cancelled' });
    mockOf(api.deploys.queue).mockResolvedValue(
      queueResponse([{ id: 31, serviceId: 1, serviceName: 'web', status: 'building' }]) as never,
    );
    mockOf(api.deploys.cancel).mockImplementation(cancelSpy);
    renderWithProviders(<Deploys />);
    const cancelBtn = await screen.findByRole('button', { name: /Cancel/ });
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledWith(1, 31);
    });
  });

  it('removes a deployment when the remove button is clicked', async () => {
    const removeSpy = vi.fn().mockResolvedValue({ ok: true, id: 41 });
    mockOf(api.deploys.queue).mockResolvedValue(
      queueResponse([{ id: 41, serviceId: 1, serviceName: 'web', status: 'building' }]) as never,
    );
    mockOf(api.deploys.remove).mockImplementation(removeSpy);
    renderWithProviders(<Deploys />);
    const removeBtn = await screen.findByRole('button', { name: /Remove/ });
    fireEvent.click(removeBtn);
    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith(1, 41);
    });
  });
});
