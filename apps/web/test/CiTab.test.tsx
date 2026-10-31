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
});
