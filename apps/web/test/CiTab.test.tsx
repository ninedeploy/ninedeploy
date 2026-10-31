import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CiTab } from '../src/routes/service/CiTab.js';
import { CiRunnersSection } from '../src/routes/settings/CiRunnersSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const JOB = {
  id: 12,
  serviceId: 7,
  status: 'failed',
  ref: null,
  commitSha: 'a'.repeat(40),
  image: 'node:24-alpine',
  labels: [],
  secretNames: [],
  trigger: 'deploy',
  deploymentId: 40,
  attempts: 1,
  maxAttempts: 2,
  timeoutSeconds: 600,
  error: 'Exited with 1',
  createdBy: null,
  approvedBy: null,
  createdAt: '2026-10-31T09:00:00.000Z',
  startedAt: '2026-10-31T09:00:01.000Z',
  finishedAt: '2026-10-31T09:01:00.000Z',
};
const ATTEMPT = {
  id: 30, number: 1, runnerId: 2, runnerName: 'builder-1', status: 'failed', exitCode: 1, error: null, logBytes: 9,
  startedAt: '2026-10-31T09:00:01.000Z', finishedAt: '2026-10-31T09:01:00.000Z',
};

describe('Service → CI (R5)', () => {
  beforeEach(() => {
    mockOf(api.ci.pipeline).mockResolvedValue({ pipeline: null } as never);
    mockOf(api.ci.jobs.list).mockResolvedValue([] as never);
    mockOf(api.ci.setPipeline).mockReset();
  });

  it('saves a pipeline that gates deploys, with the named variables and labels', async () => {
    mockOf(api.ci.setPipeline).mockResolvedValue({ pipeline: {} } as never);
    renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    expect(await screen.findByText('No job has run yet.')).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('Variables for the job'), 'NPM_TOKEN');
    await userEvent.type(screen.getByLabelText('Runner labels'), 'linux, x64');
    await userEvent.click(screen.getByRole('switch', { name: 'Deploy only what CI passed (also PR previews)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save pipeline' }));
    await waitFor(() =>
      expect(api.ci.setPipeline).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ image: 'node:24-alpine', secrets: ['NPM_TOKEN'], labels: ['linux', 'x64'], gateDeploys: true, runOnPush: false }),
      ),
    );
  });

  it('shows a deploy-gate job with its attempt log', async () => {
    mockOf(api.ci.jobs.list).mockResolvedValue([JOB] as never);
    mockOf(api.ci.jobs.get).mockResolvedValue({ job: JOB, attempts: [ATTEMPT] } as never);
    mockOf(api.ci.jobs.log).mockResolvedValue({ data: 'npm test\nboom\n', size: 14, done: true } as never);
    renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    expect(await screen.findByText('deploy #40')).toBeInTheDocument();
    expect(screen.getByText('deploy gate')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /#12/ }));
    expect(await screen.findByText('Exited with 1')).toBeInTheDocument();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(api.ci.jobs.log).toHaveBeenCalledWith(7, 12, 1, { offset: 0 });
  });

  it('shows a preview its jobs only, and no pipeline editor or run button', async () => {
    renderWithProviders(<CiTab serviceId={9} isPreview />);
    expect(await screen.findByText(/tested with its parent service's pipeline/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save pipeline' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument();
    expect(api.ci.pipeline).not.toHaveBeenCalled();
  });

  it('edits a saved pipeline, reports a failed save, and removes it after confirming', async () => {
    const saved = { image: 'node:22', script: 'npm test', labels: ['linux'], secrets: ['NPM_TOKEN'], timeoutMinutes: 30, maxAttempts: 2, requireApproval: false, runOnPush: false, gateDeploys: false };
    mockOf(api.ci.pipeline).mockResolvedValue({ pipeline: saved } as never);
    mockOf(api.ci.setPipeline).mockRejectedValue(new Error('image refused'));
    mockOf(api.ci.deletePipeline).mockResolvedValue(undefined as never);
    renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    const image = await screen.findByLabelText('Image');
    expect(image).toHaveValue('node:22');
    expect(screen.getByLabelText('Runner labels')).toHaveValue('linux');
    await userEvent.clear(image);
    await userEvent.type(image, 'node:24');
    const script = screen.getByLabelText('Script');
    await userEvent.type(script, '\nnpm run lint');
    const timeout = screen.getByLabelText('Timeout (minutes)');
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '45');
    const attempts = screen.getByLabelText('Attempts');
    await userEvent.clear(attempts);
    await userEvent.type(attempts, '3');
    await userEvent.click(screen.getByRole('switch', { name: 'Run on every push to the service branch' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Every job waits for an admin to approve it' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save pipeline' }));
    await waitFor(() =>
      expect(api.ci.setPipeline).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ image: 'node:24', script: 'npm test\nnpm run lint', timeoutMinutes: 45, maxAttempts: 3, runOnPush: true, requireApproval: true }),
      ),
    );
    expect(await screen.findByText('Could not save the pipeline: image refused')).toBeInTheDocument();

    // Cancelling the dialog keeps the pipeline; confirming removes it.
    await userEvent.click(screen.getByRole('button', { name: 'Remove pipeline' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.ci.deletePipeline).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove pipeline' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.ci.deletePipeline).toHaveBeenCalledWith(7));
    expect(await screen.findByText('CI pipeline removed')).toBeInTheDocument();
  });

  it('reports a failed removal and a pipeline that cannot be loaded', async () => {
    mockOf(api.ci.pipeline).mockResolvedValue({ pipeline: { image: 'a', script: 'b', labels: [], secrets: [], timeoutMinutes: 1, maxAttempts: 1, requireApproval: false, runOnPush: false, gateDeploys: false } } as never);
    mockOf(api.ci.deletePipeline).mockRejectedValue(new Error('locked'));
    const { unmount } = renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove pipeline' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Could not remove the pipeline: locked')).toBeInTheDocument();
    unmount();

    mockOf(api.ci.pipeline).mockRejectedValue(new Error('down'));
    mockOf(api.ci.jobs.list).mockRejectedValue(new Error('down'));
    renderWithProviders(<CiTab serviceId={8} isPreview={false} />);
    expect(await screen.findByText('Could not load the CI pipeline')).toBeInTheDocument();
    expect(await screen.findByText('Could not load CI jobs')).toBeInTheDocument();
  });

  it('runs a job at a ref and opens it; a refused run is reported', async () => {
    const queued = { ...JOB, id: 13, status: 'queued', trigger: 'manual', deploymentId: null, commitSha: null, ref: 'main', error: null };
    mockOf(api.ci.jobs.create).mockResolvedValueOnce(queued as never).mockRejectedValueOnce(new Error('no pipeline'));
    mockOf(api.ci.jobs.list).mockResolvedValue([queued] as never);
    mockOf(api.ci.jobs.get).mockResolvedValue({ job: queued, attempts: [] } as never);
    renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    await userEvent.type(await screen.findByPlaceholderText('Branch or commit (optional)'), ' main ');
    await userEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(api.ci.jobs.create).toHaveBeenCalledWith(7, { ref: 'main' }));
    expect(await screen.findByText('Waiting for a runner to take the job.')).toBeInTheDocument();
    expect(screen.getByText('ref main')).toBeInTheDocument();
    // Clicking the open job closes it.
    await userEvent.click(screen.getByRole('button', { name: /#13/ }));
    expect(screen.queryByText('Waiting for a runner to take the job.')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByPlaceholderText('Branch or commit (optional)'));
    await userEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(api.ci.jobs.create).toHaveBeenLastCalledWith(7, {}));
    expect(await screen.findByText('Could not start the job: no pipeline')).toBeInTheDocument();
  });

  it('approves and cancels a waiting job, and reports either failing', async () => {
    const waiting = { ...JOB, status: 'awaiting_approval', error: null };
    mockOf(api.ci.jobs.list).mockResolvedValue([waiting] as never);
    mockOf(api.ci.jobs.get).mockResolvedValue({ job: waiting, attempts: [] } as never);
    mockOf(api.ci.jobs.approve).mockResolvedValueOnce(waiting as never).mockRejectedValueOnce(new Error('not an admin'));
    mockOf(api.ci.jobs.cancel).mockResolvedValueOnce(waiting as never).mockRejectedValueOnce(new Error('already over'));
    renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    await userEvent.click(await screen.findByRole('button', { name: /#12/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.ci.jobs.approve).toHaveBeenCalledWith(7, 12));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.ci.jobs.cancel).toHaveBeenCalledWith(7, 12));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Could not approve the job: not an admin')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Could not cancel the job: already over')).toBeInTheDocument();
  });

  it('switches between attempts, follows a log in slices, and shows a log that cannot be read', async () => {
    const second = { ...ATTEMPT, id: 31, number: 2, runnerName: null, status: 'running' };
    mockOf(api.ci.jobs.list).mockResolvedValue([JOB] as never);
    mockOf(api.ci.jobs.get).mockResolvedValue({ job: JOB, attempts: [ATTEMPT, second] } as never);
    mockOf(api.ci.jobs.log).mockImplementation(async (_s, _j, attempt, opts) => {
      if (attempt === 1) throw new Error('log gone');
      return (opts?.offset ?? 0) === 0 ? { data: 'step 1\n', size: 7, done: false } : { data: 'step 2\n', size: 14, done: true };
    });
    renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    await userEvent.click(await screen.findByRole('button', { name: /#12/ }));
    // The latest attempt is shown first, and its log is read again from where it stopped.
    expect(await screen.findByText(/step 1/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/step 2/)).toBeInTheDocument(), { timeout: 5000 });
    expect(api.ci.jobs.log).toHaveBeenCalledWith(7, 12, 2, { offset: 7 });
    await userEvent.click(screen.getByRole('button', { name: /Attempt 1/ }));
    expect(await screen.findByText('Could not read the log: log gone')).toBeInTheDocument();
    expect(screen.getByText('No output yet.')).toBeInTheDocument();
  });

  it('shows a job that cannot be loaded', async () => {
    mockOf(api.ci.jobs.list).mockResolvedValue([JOB] as never);
    mockOf(api.ci.jobs.get).mockRejectedValue(new Error('gone'));
    renderWithProviders(<CiTab serviceId={7} isPreview={false} />);
    await userEvent.click(await screen.findByRole('button', { name: /#12/ }));
    expect(await screen.findByText('Could not load the job')).toBeInTheDocument();
  });
});

describe('Settings → CI runners (R5)', () => {
  it('adds a runner and shows its token once', async () => {
    mockOf(api.ci.runners.list).mockResolvedValue([] as never);
    mockOf(api.ci.runners.create).mockResolvedValue({ id: 1, name: 'builder-1', token: 'ndrun_secret' } as never);
    renderWithProviders(<CiRunnersSection />);
    expect(await screen.findByText('No runner yet. Jobs wait in the queue until one is added.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'builder-1');
    await userEvent.type(screen.getByLabelText('Labels'), 'linux');
    await userEvent.click(screen.getByRole('button', { name: 'Add runner' }));
    await waitFor(() => expect(api.ci.runners.create).toHaveBeenCalledWith({ name: 'builder-1', labels: ['linux'], capacity: 1 }));
    expect((await screen.findAllByText(/ndrun_secret/)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/ndrun_secret/)).not.toBeInTheDocument();
  });

  it('refuses a bad label before sending', async () => {
    renderWithProviders(<CiRunnersSection />);
    await userEvent.type(await screen.findByLabelText('Name'), 'r');
    await userEvent.type(screen.getByLabelText('Labels'), 'Linux!');
    expect(screen.getByText('Not a valid label: Linux!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add runner' })).toBeDisabled();
  });

  it('lists runners by state and revokes one after confirming; failures are reported', async () => {
    const base = { labels: ['linux'], capacity: 2, running: 1, version: '0.19.0', lastSeenAt: '2026-10-31T09:00:00.000Z', createdAt: '2026-10-30T09:00:00.000Z', revokedAt: null };
    mockOf(api.ci.runners.list).mockResolvedValue([
      { ...base, id: 1, name: 'up', online: true },
      { ...base, id: 2, name: 'down', online: false, version: null, lastSeenAt: null },
      { ...base, id: 3, name: 'gone', online: false, revokedAt: '2026-10-31T08:00:00.000Z' },
    ] as never);
    mockOf(api.ci.runners.revoke).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new Error('busy'));
    mockOf(api.ci.runners.create).mockRejectedValueOnce(new Error('name taken'));
    renderWithProviders(<CiRunnersSection />);
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText(/never seen/)).toBeInTheDocument();
    // Revoked runners offer no Revoke button.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);

    await userEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.ci.runners.revoke).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await userEvent.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!);
    await waitFor(() => expect(api.ci.runners.revoke).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Runner revoked; its running jobs were requeued')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]!);
    await userEvent.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!);
    expect(await screen.findByText('Could not revoke the runner: busy')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), 'up');
    await userEvent.click(screen.getByRole('button', { name: 'Add runner' }));
    expect(await screen.findByText('Could not add the runner: name taken')).toBeInTheDocument();
  });

  it('shows runners that cannot be loaded', async () => {
    mockOf(api.ci.runners.list).mockRejectedValue(new Error('down'));
    renderWithProviders(<CiRunnersSection />);
    expect(await screen.findByText('Could not load CI runners')).toBeInTheDocument();
  });
});
