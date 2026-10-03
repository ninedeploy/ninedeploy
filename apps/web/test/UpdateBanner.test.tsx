import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from '../src/components/UpdateBanner.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.tsx.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

// The banner gates on the auth context (operators only). A hand-rolled stub
// keeps both exports the app imports (AuthProvider passthrough + useAuth spy)
// so helpers' provider tree keeps working under the same mock. The fn is
// explicitly typed so tests can swing between signed-out and operator users.
const auth = vi.hoisted(() => ({
  useAuth: vi.fn<() => { user: { isOperator?: boolean } | null; loading: boolean }>(() => ({ user: null, loading: false })),
}));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: ReactNode }) => children,
  useAuth: auth.useAuth,
}));

const operatorUser = { id: 1, email: 'root@example.com', name: null, isOperator: true, workspaceCount: 1, createdAt: '2026-01-01T00:00:00Z' };

const idleStatus = {
  supported: true,
  phase: 'idle',
  currentVersion: 'v0.3.3',
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  errorTail: null,
};

function localStorageReset(): void {
  window.localStorage.clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.useAuth.mockReturnValue({ user: null, loading: false });
  localStorageReset();
});

describe('UpdateBanner', () => {
  it('renders nothing for signed-out users', async () => {
    mockOf(api.system.updateCheck).mockResolvedValue({
      current: 'v0.3.3', latest: 'v9.9.9', updateAvailable: true, notesUrl: null, checkedAt: '2026-08-15T00:00:00Z',
    } as never);
    const { container } = renderWithProviders(<UpdateBanner />);
    await waitFor(() => expect(container.querySelector('.nd-fade')).toBeNull());
    expect(api.system.updateStatus).not.toHaveBeenCalled();
  });

  it('renders nothing while a poll is still unsettled', async () => {
    auth.useAuth.mockReturnValue({ user: operatorUser, loading: false });
    mockOf(api.system.updateStatus).mockReturnValue(new Promise(() => {}) as never);
    const { container } = renderWithProviders(<UpdateBanner />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe('');
  });

  it('offers the one-click upgrade when a newer release exists', async () => {
    auth.useAuth.mockReturnValue({ user: operatorUser, loading: false });
    mockOf(api.system.updateCheck).mockResolvedValue({
      current: 'v0.3.3', latest: 'v0.4.0',
      notesUrl: 'https://github.com/ninedeploy/ninedeploy/releases/tag/v0.4.0',
      updateAvailable: true, checkedAt: '2026-08-15T00:00:00Z',
    } as never);
    mockOf(api.system.updateStatus).mockResolvedValue(idleStatus as never);
    renderWithProviders(<UpdateBanner />);

    expect(await screen.findByText(/New release/)).toBeInTheDocument();
    expect(screen.getByText(/v0\.4\.0/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /update & restart/i }));

    // The confirmation spells out what will happen before anything starts.
    expect(screen.getByText(/runs the official installer/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update and Restart' }));

    await waitFor(() =>
      expect(mockOf(api.system.updateStart)).toHaveBeenCalledWith('v0.4.0'),
    );
  });

  it('shows progress copy while the updater is running', async () => {
    auth.useAuth.mockReturnValue({ user: operatorUser, loading: false });
    mockOf(api.system.updateCheck).mockResolvedValue({
      current: 'v0.3.3', latest: 'v0.4.0', updateAvailable: true, notesUrl: null, checkedAt: '2026-08-15T00:00:00Z',
    } as never);
    mockOf(api.system.updateStatus).mockResolvedValue({
      ...idleStatus,
      phase: 'running',
      targetVersion: 'v0.4.0',
      startedAt: '2026-08-27T09:00:00Z',
    } as never);
    renderWithProviders(<UpdateBanner />);
    expect(await screen.findByText(/is updating to/)).toBeInTheDocument();
    expect(screen.getByText(/Deployed services keep running|leaving this page is safe/i)).toBeTruthy();
  });

  it('displays the failure tail when an updater run failed', async () => {
    auth.useAuth.mockReturnValue({ user: operatorUser, loading: false });
    mockOf(api.system.updateCheck).mockResolvedValue({
      current: 'v0.3.3', latest: null, updateAvailable: false, notesUrl: null, checkedAt: '2026-08-15T00:00:00Z',
    } as never);
    mockOf(api.system.updateStatus).mockResolvedValue({
      ...idleStatus,
      phase: 'failed',
      targetVersion: 'v0.4.0',
      errorTail: 'pnpm build exited 1',
      finishedAt: '2026-08-27T09:05:00Z',
      startedAt: '2026-08-27T09:00:00Z',
    } as never);
    renderWithProviders(<UpdateBanner />);
    expect(await screen.findByText(/did not complete/)).toBeInTheDocument();
    expect(screen.getByText(/pnpm build exited 1/)).toBeInTheDocument();
  });

  it('announces a completed upgrade and moves on', async () => {
    auth.useAuth.mockReturnValue({ user: operatorUser, loading: false });
    mockOf(api.system.updateCheck).mockResolvedValue({
      current: 'v0.3.3', latest: null, updateAvailable: false, notesUrl: null, checkedAt: '2026-08-15T00:00:00Z',
    } as never);
    mockOf(api.system.updateStatus).mockResolvedValue({
      ...idleStatus,
      phase: 'success',
      targetVersion: 'v0.4.0',
      finishedAt: '2026-08-27T09:07:00Z',
    } as never);
    renderWithProviders(<UpdateBanner />);
    expect(await screen.findByText(/was updated to/)).toBeInTheDocument();
    expect(screen.getByText('v0.4.0')).toBeInTheDocument();
  });

  it('hides itself on installs without a self-update path', async () => {
    auth.useAuth.mockReturnValue({ user: operatorUser, loading: false });
    mockOf(api.system.updateCheck).mockResolvedValue({
      current: 'v0.3.3', latest: 'v9.9.9', updateAvailable: true, notesUrl: null, checkedAt: '2026-08-15T00:00:00Z',
    } as never);
    mockOf(api.system.updateStatus).mockResolvedValue({
      ...idleStatus,
      supported: false,
      phase: 'unsupported',
      reason: 'The panel runs as a container',
    } as never);
    const { container } = renderWithProviders(<UpdateBanner />);
    await waitFor(() => expect(container.querySelector('.nd-fade')).toBeNull());
  });
});
