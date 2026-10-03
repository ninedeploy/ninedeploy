import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    env: { list: vi.fn().mockResolvedValue([]) },
    attachments: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), remove: vi.fn() },
    webhooks: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    jobs: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), run: vi.fn() },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

// EnvCard's raw .env editor needs clipboard; stub quietly.
Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

import { EnvironmentTab } from '../src/routes/service/EnvironmentTab.js';

const HOOK_LOCALHOST = [{ id: 1, branch: 'main', url: 'http://localhost:3000/v1/hooks/abc', secret: 's', watchPaths: null, watchPathsGlobCount: 0 }];
const JOB = { id: 3, name: 'nightly', cron: '0 3 * * *', kind: 'deploy' as const, command: '', enabled: true, lastRunAt: '2026-08-26T03:00:00Z' };

function renderTab() {
  return renderWithProviders(<EnvironmentTab serviceId={7} />, { queryClient: createQueryClient() });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.api.env.list.mockResolvedValue([]);
  apiMock.api.attachments.list.mockResolvedValue([]);
  apiMock.api.webhooks.list.mockResolvedValue([]);
  apiMock.api.jobs.list.mockResolvedValue([]);
});

describe('EnvironmentTab — scheduled jobs card', () => {
  it('creates a preset-based deploy job and describes the schedule', async () => {
    const user = userEvent.setup();
    apiMock.api.jobs.create.mockResolvedValue({ id: 9 });
    renderTab();

    await user.type(await screen.findByPlaceholderText('nightly-rebuild'), 'nightly');
    // Preset defaults to Daily at 03:00 — no command needed for redeploy jobs.
    expect(screen.getByText('every day at 03:00')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add job/i }));
    await waitFor(() =>
      expect(apiMock.api.jobs.create).toHaveBeenCalledWith(7, { name: 'nightly', cron: '0 3 * * *', kind: 'deploy', command: undefined }),
    );
  });

  it('reveals the weekday picker for weekly presets and the cron field for custom', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByPlaceholderText('nightly-rebuild');

    await user.selectOptions(screen.getByLabelText('Schedule preset'), 'weekly');
    expect(screen.getByLabelText('Day of week')).toBeInTheDocument();
    expect(screen.getByText('every Sunday at 03:00')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Schedule preset'), 'monthly');
    expect(screen.getByLabelText('Day of month')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Schedule preset'), 'custom');
    const cronField = screen.getByLabelText('Cron expression');
    expect(cronField).toBeInTheDocument();

    await user.type(cronField, '0');
    expect(screen.getByText('Not a valid 5-field expression yet.')).toBeInTheDocument();
    // A valid custom cron is still summarized like any other expression.
    await user.type(cronField, ' 5 * * *');
    expect(screen.getByText('every day at 05:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add job/i })).toBeDisabled(); // still no name
  });

  it('requires an exec command before submitting exec jobs', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.type(await screen.findByPlaceholderText('nightly-rebuild'), 'backup');
    await user.selectOptions(screen.getByLabelText('Job action'), 'exec');

    const addBtn = screen.getByRole('button', { name: /add job/i });
    expect(addBtn).toBeDisabled();
    await user.type(screen.getByPlaceholderText('pg_dump … / npm run cache:clean'), 'pg_dump main');
    expect(addBtn).not.toBeDisabled();
  });

  it('lists existing jobs with summary + last run and toggles/deletes them', async () => {
    const user = userEvent.setup();
    apiMock.api.jobs.list.mockResolvedValue([JOB]);
    renderTab();

    expect(await screen.findByText('nightly')).toBeInTheDocument();
    expect(screen.getByText('0 3 * * *')).toBeInTheDocument();
    expect(screen.getByText(/last ran/)).toBeInTheDocument();

    // The enabled chip reads the CURRENT state; clicking flips it.
    await user.click(screen.getByRole('button', { name: 'on' }));
    await waitFor(() => expect(apiMock.api.jobs.update).toHaveBeenCalledWith(7, 3, { enabled: false }));

    await user.click(screen.getByTitle('Delete job'));
    await waitFor(() => expect(apiMock.api.jobs.remove).toHaveBeenCalledWith(7, 3));

    await user.click(screen.getByTitle('Run now'));
    await waitFor(() => expect(apiMock.api.jobs.run).toHaveBeenCalledWith(7, 3));
  });

  it('warns when auto-deploy webhooks point at localhost', async () => {
    apiMock.api.webhooks.list.mockResolvedValue(HOOK_LOCALHOST);
    renderTab();

    expect(await screen.findByText(/Git\s+providers can.t reach that/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings → Security' })).toHaveAttribute('href', '/settings');
  });

  it('does not warn for public webhook URLs', async () => {
    apiMock.api.webhooks.list.mockResolvedValue([{ ...HOOK_LOCALHOST[0]!, url: 'https://panel.acme.dev/v1/hooks/abc' }]);
    const { container } = renderTab();
    await waitFor(() => expect(apiMock.api.webhooks.list).toHaveBeenCalled());
    expect(container.textContent).not.toContain("can't reach that");
  });

  it('rejects empty-form submissions silently (guarded mutate)', async () => {
    renderTab();
    const form = screen.getByPlaceholderText('nightly-rebuild').closest('form')!;
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.api.jobs.create).not.toHaveBeenCalled();
  });
});
