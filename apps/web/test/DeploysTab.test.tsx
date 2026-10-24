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
    mockOf(api.deploys.releaseInfo).mockResolvedValue({ available: true, mode: 'legacy', imageCount: 0, reason: 'Legacy redeploy: current settings and environment.' });
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'ada@example.com', name: 'Ada', isOperator: true },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('shows the pinned CI candidate and pending workflows, allows cancellation, and offers no rollback or deletion', async () => {
    mockOf(api.deploys.cancel).mockResolvedValue({ ok: true });
    const sha = 'a'.repeat(40);
    const candidate = baseDeploy({ id: 44, status: 'awaiting_ci', commitSha: sha, ciGate: {
      state: 'waiting', reason: 'Waiting for required GitHub workflows on the pinned commit', headSha: sha,
      checkedAt: null, deadlineAt: '2026-10-21T23:00:00.000Z',
      checks: [{ path: '.github/workflows/ci.yml', state: 'pending', runId: 123, attempt: 2 }],
    } });
    renderWithProviders(<DeploysTab serviceId={1} repoUrl={null} deploys={[baseDeploy({ id: 45 }), candidate]} loading={false} activeId={44} onSelect={() => {}} />);
    expect(screen.getByText(sha)).toBeInTheDocument();
    expect(screen.getByText(/run #123, attempt 2/)).toHaveTextContent('pending');
    expect(screen.getAllByText('waiting for CI').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Rollback to #44')).toBeNull();
    expect(screen.queryByLabelText('Remove deployment #44')).toBeNull();
    await userEvent.setup().click(screen.getByLabelText('Cancel deployment #44'));
    await waitFor(() => expect(api.deploys.cancel).toHaveBeenCalledWith(1, 44));
  });

  it('shows recorded recovery limits and confirms a recorded Compose restore', async () => {
    mockOf(api.deploys.releaseInfo).mockResolvedValue({ available: true, mode: 'recorded-compose', imageCount: 2, reason: 'Recorded environment and images. Volume data is not restored.' });
    mockOf(api.deploys.rollback).mockResolvedValue({ deploymentId: 22 });
    const user = userEvent.setup();
    renderWithProviders(<DeploysTab serviceId={1} repoUrl={null} deploys={[baseDeploy({ id: 8 }), baseDeploy({ id: 7, status: 'superseded' })]} loading={false} activeId={7} onSelect={() => {}} />);
    expect(await screen.findByText(/Encrypted release record/)).toHaveTextContent('2 pinned images');
    expect(screen.getByText(/Encrypted release record/)).toHaveTextContent('protected from NineDeploy cleanup');
    await user.click(screen.getByLabelText('Rollback to deployment #7'));
    const confirm = await screen.findByRole('button', { name: 'Rollback' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(api.deploys.rollback).toHaveBeenCalledWith(1, 7));
  });

  it('disables confirmation when no release is restorable', async () => {
    mockOf(api.deploys.releaseInfo).mockResolvedValue({ available: false, mode: 'unavailable', imageCount: 0, reason: 'No recorded images.' });
    const user = userEvent.setup();
    renderWithProviders(<DeploysTab serviceId={1} repoUrl={null} deploys={[baseDeploy({ id: 8 }), baseDeploy({ id: 7, status: 'superseded' })]} loading={false} activeId={null} onSelect={() => {}} />);
    await user.click(screen.getByLabelText('Rollback to deployment #7'));
    expect(await screen.findByText(/No recorded images/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Rollback' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(api.deploys.rollback).not.toHaveBeenCalled();
  });

  it('rechecks a previously eligible release and blocks confirmation when its images disappear', async () => {
    mockOf(api.deploys.releaseInfo).mockResolvedValueOnce({ available: true, mode: 'recorded-compose', imageCount: 1, reason: 'Recorded image is available.' });
    let finish!: (value: Awaited<ReturnType<typeof api.deploys.releaseInfo>>) => void;
    mockOf(api.deploys.releaseInfo).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup();
    renderWithProviders(<DeploysTab serviceId={1} repoUrl={null} deploys={[baseDeploy({ id: 8 }), baseDeploy({ id: 7, status: 'superseded' })]} loading={false} activeId={7} onSelect={() => {}} />);
    await screen.findByText('Recorded image is available.');
    await user.click(screen.getByLabelText('Rollback to deployment #7'));
    const confirm = await screen.findByRole('button', { name: 'Rollback' });
    await waitFor(() => expect(api.deploys.releaseInfo).toHaveBeenCalledTimes(2));
    expect(confirm).toBeDisabled();
    finish({ available: false, mode: 'recorded-compose', imageCount: 1, imageAvailability: 'missing', missingImageCount: 1, reason: '1 recorded image is missing from this host.' });
    await screen.findAllByText(/1 recorded image is missing/);
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(api.deploys.rollback).not.toHaveBeenCalled();
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

  it('offers approve and reject on a waiting deploy to a lane admin', async () => {
    const waiting = baseDeploy({ id: 21, status: 'awaiting_approval', message: 'fix: login', trigger: 'webhook' });
    mockOf(api.deploys.approvals).mockResolvedValue({
      items: [{ ...waiting, serviceId: 1, serviceName: 'web', imageDigest: null, status: 'awaiting_approval', mayReview: true }],
      count: 1,
    });
    const approveSpy = vi.fn().mockResolvedValue({ ok: true, status: 'queued' });
    const rejectSpy = vi.fn().mockRejectedValue(new Error('Only a workspace admin may approve or reject a deploy into this lane'));
    mockOf(api.deploys.approve).mockImplementation(approveSpy);
    mockOf(api.deploys.reject).mockImplementation(rejectSpy);
    renderWithProviders(
      <DeploysTab serviceId={1} repoUrl={null} deploys={[waiting, baseDeploy({ id: 20 })]} loading={false} activeId={null} onSelect={() => {}} />,
    );
    expect(screen.getByText('Deployment #21 is waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('awaiting approval')).toBeInTheDocument();
    // Withdraw is offered; rollback and remove are not.
    expect(screen.getByLabelText('Cancel deployment #21')).toBeInTheDocument();
    expect(screen.queryByLabelText('Rollback to deployment #21')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remove deployment #21')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith(1, 21));
    await user.click(screen.getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(rejectSpy).toHaveBeenCalledWith(1, 21));
  });

  it('tells someone who may not decide who does', async () => {
    const waiting = baseDeploy({ id: 22, status: 'awaiting_approval', commitSha: null, message: null, author: null });
    mockOf(api.deploys.approvals).mockResolvedValue({
      items: [{ ...waiting, serviceId: 1, serviceName: 'web', imageDigest: null, status: 'awaiting_approval', mayReview: false }],
      count: 1,
    });
    renderWithProviders(
      <DeploysTab serviceId={1} repoUrl={null} deploys={[waiting]} loading={false} activeId={null} onSelect={() => {}} />,
    );
    expect(await screen.findByText(/A workspace admin approves deploys into this lane/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
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

  it('confirms the exact artifact and pins the selected source deployment', async () => {
    const repoUrl = 'https://github.com/acme/web.git';
    const imageId = `sha256:${'a'.repeat(64)}`;
    const registryRef = `registry.example.test/team/app@sha256:${'b'.repeat(64)}`;
    mockOf(api.services.list).mockResolvedValue([{ id: 2, name: 'production', repoUrl }] as never);
    const promote = vi.fn().mockResolvedValue({ ok: true, deploymentId: 30, commitSha: 'abcdef12345', promotedFrom: 'staging' });
    mockOf(api.deploys.promote).mockImplementation(promote);
    renderWithProviders(<DeploysTab serviceId={1} repoUrl={repoUrl}
      deploys={[baseDeploy({ id: 7, status: 'running', artifact: { imageId, originDeploymentId: 7, originServerId: 4, promotionSourceDeploymentId: null, registryRef } })]}
      loading={false} activeId={7} onSelect={() => {}} />);
    const user = userEvent.setup();
    await screen.findByText('Promote this artifact');
    await user.selectOptions(screen.getByLabelText('Promotion target service'), '2');
    await user.click(screen.getByRole('button', { name: 'Promote' }));
    expect(promote).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(imageId);
    expect(screen.getByRole('dialog')).toHaveTextContent('Build-time values remain baked');
    expect(screen.getByRole('dialog')).toHaveTextContent('pinned registry digest');
    expect(screen.getByRole('dialog')).toHaveTextContent('Configured additional nodes receive the same image');
    expect(screen.getByRole('dialog')).toHaveTextContent('a failed target keeps its previous release');
    await user.click(screen.getByRole('button', { name: 'Promote artifact' }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith(1, 2, { mode: 'artifact', sourceDeploymentId: 7 }));
    expect(screen.getByText('Immutable Docker artifact')).toBeInTheDocument();
    expect(screen.getByText(`Registry archive: ${registryRef}`)).toBeInTheDocument();
    expect(screen.getByText(/Built on node #4/)).toHaveTextContent('Recoverable image copy retained on the panel');
  });

  it('explains native Swarm rollout and pins the artifact request for a Swarm target', async () => {
    const repoUrl = 'https://github.com/acme/web.git', imageId = 'sha256:' + 'a'.repeat(64);
    mockOf(api.services.list).mockResolvedValue([{ id: 2, name: 'swarm production', repoUrl, orchestrator: 'swarm' }] as never);
    const promote = vi.fn().mockResolvedValue({ ok: true, deploymentId: 30, commitSha: 'abcdef12345', promotedFrom: 'staging' });
    mockOf(api.deploys.promote).mockImplementation(promote);
    renderWithProviders(<DeploysTab serviceId={1} repoUrl={repoUrl} deploys={[baseDeploy({ id: 7, status: 'running', artifact: { imageId, originDeploymentId: 7, promotionSourceDeploymentId: null } })]} loading={false} activeId={7} onSelect={() => {}} />);
    const user = userEvent.setup(); await screen.findByText('Promote this artifact');
    await user.selectOptions(screen.getByLabelText('Promotion target service'), '2');
    await user.click(screen.getByRole('button', { name: 'Promote' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(imageId); expect(dialog).toHaveTextContent('replica count');
    expect(dialog).toHaveTextContent('Swarm rolls the same image across its replicas');
    expect(dialog).toHaveTextContent('HTTP/TCP readiness is not available for Swarm');
    expect(dialog).not.toHaveTextContent('Configured additional nodes');
    await user.click(screen.getByRole('button', { name: 'Promote artifact' }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith(1, 2, { mode: 'artifact', sourceDeploymentId: 7 }));
  });

  it('allows an explicit commit rebuild even when an artifact exists', async () => {
    const repoUrl = 'https://github.com/acme/web.git';
    mockOf(api.services.list).mockResolvedValue([{ id: 2, name: 'production', repoUrl }] as never);
    const promote = vi.fn().mockResolvedValue({ ok: true, deploymentId: 30, commitSha: 'abcdef12345', promotedFrom: 'staging' });
    mockOf(api.deploys.promote).mockImplementation(promote);
    renderWithProviders(<DeploysTab serviceId={1} repoUrl={repoUrl}
      deploys={[baseDeploy({ id: 7, status: 'running', artifact: { imageId: 'sha256:recorded', originDeploymentId: 7, promotionSourceDeploymentId: null } })]}
      loading={false} activeId={null} onSelect={() => {}} />);
    const user = userEvent.setup();
    await screen.findByText('Promote this artifact');
    await user.selectOptions(screen.getByLabelText('Promotion mode'), 'commit');
    await user.selectOptions(screen.getByLabelText('Promotion target service'), '2');
    await user.click(screen.getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith(1, 2));
  });

  it('offers AI diagnosis for a failed deployment when configured', async () => {
    mockOf(api.ai.getConfig).mockResolvedValue({ configured: true, baseUrl: 'https://ai.example.com/v1', model: 'gpt-test', hasApiKey: true });
    const diagnoseSpy = vi.fn().mockResolvedValue({ diagnosis: 'Root cause: bad credentials.', model: 'gpt-test' });
    mockOf(api.ai.diagnose).mockImplementation(diagnoseSpy);
    renderWithProviders(
      <DeploysTab
        serviceId={1}
        repoUrl={null}
        deploys={[baseDeploy({ id: 7, status: 'failed' })]}
        loading={false}
        activeId={7}
        onSelect={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Diagnose failure' }));
    await waitFor(() => expect(diagnoseSpy).toHaveBeenCalledWith(1, 7));
    expect(await screen.findByText(/Root cause: bad credentials\./)).toBeInTheDocument();
  });

  it('0.16.16: shows a proposed settings change next to the current values, applies it and redeploys', async () => {
    mockOf(api.ai.getConfig).mockResolvedValue({ configured: true, provider: 'anthropic', baseUrl: null, model: 'claude-sonnet-5-5', hasApiKey: true });
    mockOf(api.services.get).mockResolvedValue({ id: 1, port: 3000, healthPath: '/', build: { buildPack: 'nixpacks', startCmd: null } } as never);
    mockOf(api.ai.diagnose).mockResolvedValue({
      diagnosis: 'Root cause: wrong port.',
      model: 'claude-sonnet-5-5',
      parts: { rootCause: 'wrong port.', evidence: [], steps: [] },
      proposal: {
        settings: { port: 8080, build: { startCmd: 'node server.js' } },
        files: [{ path: 'package.json', find: '"node": "16"', replace: '"node": "20"', why: 'Node 18+ is required' }],
      },
    });
    const updateSpy = vi.fn().mockResolvedValue({ id: 1 });
    const triggerSpy = vi.fn().mockResolvedValue({ deploymentId: 9 });
    mockOf(api.services.update).mockImplementation(updateSpy);
    mockOf(api.deploys.trigger).mockImplementation(triggerSpy);
    const onSelect = vi.fn();
    renderWithProviders(
      <DeploysTab serviceId={1} repoUrl={null} deploys={[baseDeploy({ id: 7, status: 'failed' })]} loading={false} activeId={7} onSelect={onSelect} />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Diagnose failure' }));
    expect(await screen.findByText('Proposed settings change')).toBeInTheDocument();
    expect(await screen.findByText('3000')).toBeInTheDocument();
    expect(screen.getByText('8080')).toBeInTheDocument();
    expect(screen.getByText('Start command')).toBeInTheDocument();
    expect(screen.getByText('node server.js')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
    expect(screen.getByText('Node 18+ is required')).toBeInTheDocument();
    expect(screen.getByText(/- "node": "16"/)).toBeInTheDocument();
    expect(screen.getByText(/\+ "node": "20"/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Apply and redeploy/ }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(1, { port: 8080, build: { startCmd: 'node server.js' } }));
    await waitFor(() => expect(triggerSpy).toHaveBeenCalledWith(1));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(9));
  });

  it('0.16.16: copies a proposed file edit, and survives a refused apply', async () => {
    mockOf(api.ai.getConfig).mockResolvedValue({ configured: true, baseUrl: null, model: 'm', hasApiKey: true });
    mockOf(api.services.get).mockResolvedValue({ id: 1, port: null, healthPath: '', build: undefined } as never);
    mockOf(api.ai.diagnose).mockResolvedValue({
      diagnosis: 'Root cause: x.',
      model: 'm',
      proposal: { settings: { healthPath: '/health', build: { buildPack: 'dockerfile' } }, files: [{ path: 'Dockerfile', find: 'FROM node:16', replace: 'FROM node:20' }] },
    });
    mockOf(api.services.update).mockRejectedValue(new Error('Only operators may use the static build pack'));
    renderWithProviders(
      <DeploysTab serviceId={1} repoUrl={null} deploys={[baseDeploy({ id: 7, status: 'failed' })]} loading={false} activeId={7} onSelect={() => {}} />,
    );
    const user = userEvent.setup();
    // After setup(): user-event installs its own clipboard stub.
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(await screen.findByRole('button', { name: 'Diagnose failure' }));
    await user.click(await screen.findByLabelText('Copy the replacement for Dockerfile'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('FROM node:20'));
    await user.click(screen.getByLabelText('Copy the replacement for Dockerfile'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /Apply and redeploy/ }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalled());
    expect(api.deploys.trigger).not.toHaveBeenCalled();
  });

  it('hides the AI diagnosis card when no provider is configured', async () => {
    mockOf(api.ai.getConfig).mockResolvedValue({ configured: false, baseUrl: null, model: null, hasApiKey: false });
    renderWithProviders(
      <DeploysTab
        serviceId={1}
        repoUrl={null}
        deploys={[baseDeploy({ id: 7, status: 'failed' })]}
        loading={false}
        activeId={7}
        onSelect={() => {}}
      />,
    );
    await screen.findByText('#7');
    expect(screen.queryByText('AI diagnosis')).not.toBeInTheDocument();
  });
});
