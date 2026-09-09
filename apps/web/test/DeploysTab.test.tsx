import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeploysTab } from '../src/routes/service/DeploysTab.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';
import type { Deployment } from '@ninedeploy/sdk';

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
    ToastProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

const baseDeploy = (over: Partial<Deployment> = {}): Deployment => ({
  id: 1,
  status: 'running',
  commitSha: 'abcdef1',
  message: 'commit',
  author: 'alice',
  trigger: 'user',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('DeploysTab (per-service)', () => {
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

  it('shows the per-service queue position on every queued row', async () => {
    // id desc (newest first) — the DeploysTab renders top-to-bottom in
    // that order, but the position is computed from id-asc so the
    // earliest queued is #1, not the latest.
    const deploys: Deployment[] = [
      baseDeploy({ id: 13, status: 'queued' }),
      baseDeploy({ id: 12, status: 'queued' }),
      baseDeploy({ id: 11, status: 'queued' }),
    ];
    renderWithProviders(
      <DeploysTab serviceId={1} repoUrl={null} deploys={deploys} loading={false} activeId={null} onSelect={() => {}} />,
    );
    // All three position badges render, in id-desc order on screen.
    expect(await screen.findByText('#1 of 3')).toBeInTheDocument();
    expect(screen.getByText('#2 of 3')).toBeInTheDocument();
    expect(screen.getByText('#3 of 3')).toBeInTheDocument();
  });

  it('does not show a queue position on a running row', async () => {
    const deploys: Deployment[] = [baseDeploy({ id: 1, status: 'running' })];
    renderWithProviders(
      <DeploysTab serviceId={1} repoUrl={null} deploys={deploys} loading={false} activeId={null} onSelect={() => {}} />,
    );
    // The status badge shows, but no position marker — only queued rows
    // carry it.
    expect(await screen.findByText('running')).toBeInTheDocument();
    expect(screen.queryByText(/#\d+ of \d+/)).not.toBeInTheDocument();
  });

  it('cancels a queued row without leaving the panel', async () => {
    const cancelSpy = vi.fn().mockResolvedValue({ ok: true, status: 'cancelled' });
    mockOf(api.deploys.cancel).mockImplementation(cancelSpy);
    const deploys: Deployment[] = [baseDeploy({ id: 21, status: 'queued' })];
    renderWithProviders(
      <DeploysTab serviceId={1} repoUrl={null} deploys={deploys} loading={false} activeId={null} onSelect={() => {}} />,
    );
    const user = userEvent.setup();
    const card = await screen.findByText('#21');
    await user.hover(card.parentElement!.parentElement!);
    const cancelBtn = await screen.findByTitle('Cancel deployment #21');
    await user.click(cancelBtn);
    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledWith(1, 21);
    });
  });

  it('offers promotion only to same-repo services and queues it', async () => {
    const REPO = 'https://github.com/acme/web.git';
    mockOf(api.services.list).mockResolvedValue([
      { id: 1, name: 'web-staging', repoUrl: REPO },
      { id: 2, name: 'web-prod', repoUrl: REPO },
      { id: 3, name: 'api', repoUrl: 'https://github.com/acme/api.git' },
    ] as never);
    const promoteSpy = vi.fn().mockResolvedValue({ ok: true, deploymentId: 30, commitSha: 'abcdef12345', promotedFrom: 'web-staging' });
    mockOf(api.deploys.promote).mockImplementation(promoteSpy);
    renderWithProviders(
      <DeploysTab
        serviceId={1}
        repoUrl={REPO}
        deploys={[baseDeploy({ id: 7, status: 'running' })]}
        loading={false}
        activeId={null}
        onSelect={() => {}}
      />,
    );
    const user = userEvent.setup();
    // Card renders only because a running pinned commit + same-repo siblings exist.
    await screen.findByText('Promote this commit');
    const select = screen.getByLabelText('Promotion target service');
    // Same-repo sibling is offered; the self and cross-repo services are not.
    expect(select).toHaveTextContent('web-prod');
    expect(select).not.toHaveTextContent('web-staging');
    expect(select).not.toHaveTextContent('api');
    await user.selectOptions(select, '2');
    await user.click(screen.getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(promoteSpy).toHaveBeenCalledWith(1, 2));
  });

  it('hides the promote card without a running pinned commit', async () => {
    mockOf(api.services.list).mockResolvedValue([{ id: 2, name: 'web-prod' }] as never);
    renderWithProviders(
      <DeploysTab
        serviceId={1}
        repoUrl="https://github.com/acme/web.git"
        deploys={[baseDeploy({ id: 7, status: 'failed' })]}
        loading={false}
        activeId={null}
        onSelect={() => {}}
      />,
    );
    await screen.findByText('#7');
    expect(screen.queryByText('Promote this commit')).not.toBeInTheDocument();
  });
});
