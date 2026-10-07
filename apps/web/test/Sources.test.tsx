import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sources } from '../src/routes/Sources.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const sources = [
  { id: 1, name: 'github-personal', type: 'github', hasToken: true, hasDeployKey: false },
  { id: 2, name: 'custom-server', type: 'weird', hasToken: false, hasDeployKey: true },
];

// r472/r473: the page/queries are operator-gated — the auth mock hands out a
// MUTABLE user so the member-arm test can flip it.
const authState = vi.hoisted(() => ({ user: { id: 1, isOperator: true } as { id: number; isOperator: boolean } | null }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: authState.user, loading: false })),
}));

describe('Sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, isOperator: true };
  });

  it('shows skeleton while loading', () => {
    mockOf(api.sources.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Sources />);
    expect(document.querySelectorAll('.animate-pulse').length).toBe(2);
  });

  it('shows empty state when there are no sources', async () => {
    mockOf(api.sources.list).mockResolvedValue([] as never);
    renderWithProviders(<Sources />);
    await screen.findByText('No sources');
  });

  it('shows an error card with retry when the sources query fails', async () => {
    mockOf(api.sources.list).mockRejectedValue(new Error('401') as never);
    renderWithProviders(<Sources />);
    expect(await screen.findByText("Couldn't load sources")).toBeInTheDocument();
    expect(screen.getByText('401')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.sources.list).toHaveBeenCalledTimes(2));
  });

  it('toasts on create and delete failures', async () => {
    mockOf(api.sources.list).mockResolvedValue(sources as never);
    mockOf(api.sources.create).mockRejectedValue(new Error('dup') as never);
    mockOf(api.sources.remove).mockRejectedValue(new Error('busy') as never);
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('button', { name: /New source/ }));
    await userEvent.type(await screen.findByPlaceholderText('github-personal'), 'x');
    await userEvent.type(screen.getByPlaceholderText('ghp_… / github_pat_…'), 'tok');
    fireEvent.click(screen.getByRole('button', { name: /Save source/ }));
    await waitFor(() => expect(api.sources.create).toHaveBeenCalled());
    const buttons = screen.getAllByRole('button');
    const trash = buttons.find((b) => b.querySelector('svg') !== null && b.className.includes('hover:text-rose-400'))!;
    await userEvent.click(trash);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.sources.remove).toHaveBeenCalled());
  });

  it('renders sources with type labels and credential tags', async () => {
    mockOf(api.sources.list).mockResolvedValue(sources as never);
    renderWithProviders(<Sources />);
    await screen.findByText('github-personal');
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    // unknown type falls back to raw value
    expect(screen.getByText('weird')).toBeInTheDocument();
    expect(screen.getAllByText('Token').length).toBe(2);
    expect(screen.getAllByText('Deploy key').length).toBe(2);
  });

  it('creates a source with token, closes and resets the form', async () => {
    const user = userEvent.setup();
    mockOf(api.sources.list).mockResolvedValue([] as never);
    mockOf(api.sources.create).mockResolvedValue({ id: 3, name: 'x', type: 'github', hasToken: true, hasDeployKey: false } as never);
    renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: /New source/ }));
    await user.type(await screen.findByPlaceholderText('github-personal'), 'my-src');
    await user.selectOptions(screen.getByRole('combobox'), 'gitlab');
    await user.type(screen.getByPlaceholderText('glpat-…'), 'glpat_token');
    await user.click(screen.getByRole('button', { name: /Save source/ }));
    await waitFor(() => expect(api.sources.create).toHaveBeenCalledWith({ name: 'my-src', type: 'gitlab', token: 'glpat_token', deployKey: undefined }));
    expect(screen.queryByPlaceholderText('github-personal')).not.toBeInTheDocument();
  });

  it('creates a source with an SSH deploy key only', async () => {
    const user = userEvent.setup();
    mockOf(api.sources.list).mockResolvedValue([] as never);
    mockOf(api.sources.create).mockResolvedValue({ id: 4, name: 'k', type: 'github', hasToken: false, hasDeployKey: true } as never);
    renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: /New source/ }));
    await user.type(await screen.findByPlaceholderText('github-personal'), 'ssh-src');
    // The SSH key field is gated by the auth-method radio — pick "SSH deploy key"
    // first, otherwise the key textarea is unmounted.
    await user.click(screen.getByRole('button', { name: /SSH deploy key/ }));
    await user.type(screen.getByPlaceholderText('-----BEGIN OPENSSH PRIVATE KEY-----'), 'PRIVATE KEY');
    await user.click(screen.getByRole('button', { name: /Save source/ }));
    await waitFor(() => expect(api.sources.create).toHaveBeenCalledWith({ name: 'ssh-src', type: 'github', token: undefined, deployKey: 'PRIVATE KEY' }));
  });

  it('creates a gitea source with the "access token" placeholder (third branch)', async () => {
    // Exercises the third arm of the placeholder ternary (gitea + custom).
    const user = userEvent.setup();
    mockOf(api.sources.list).mockResolvedValue([] as never);
    mockOf(api.sources.create).mockResolvedValue({ id: 5, name: 'gt', type: 'gitea', hasToken: true, hasDeployKey: false } as never);
    renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: /New source/ }));
    await user.type(await screen.findByPlaceholderText('github-personal'), 'gitea-src');
    await user.selectOptions(screen.getByRole('combobox'), 'gitea');
    const tokenField = await screen.findByPlaceholderText('access token');
    await user.type(tokenField, 'gtok');
    await user.click(screen.getByRole('button', { name: /Save source/ }));
    await waitFor(() => expect(api.sources.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'gitea-src', type: 'gitea', token: 'gtok' })));
  });

  it('shows the generic "your Git host" hint for custom (no docs link)', async () => {
    // Verifies the DEPLOY_KEY_DOCS fallback branch (label is empty for custom).
    const user = userEvent.setup();
    mockOf(api.sources.list).mockResolvedValue([] as never);
    mockOf(api.sources.create).mockResolvedValue({ id: 6, name: 'c', type: 'custom', hasToken: false, hasDeployKey: true } as never);
    renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: /New source/ }));
    await user.type(await screen.findByPlaceholderText('github-personal'), 'custom-src');
    await user.selectOptions(screen.getByRole('combobox'), 'custom');
    await user.click(screen.getByRole('button', { name: /SSH deploy key/ }));
    const hint = await screen.findByText(/your Git host/);
    expect(hint).toBeInTheDocument();
  });

  it('shows the saving label while the source is being created', async () => {
    const user = userEvent.setup();
    mockOf(api.sources.list).mockResolvedValue([] as never);
    mockOf(api.sources.create).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: /New source/ }));
    await user.type(await screen.findByPlaceholderText('github-personal'), 'x');
    await user.type(screen.getByPlaceholderText('ghp_… / github_pat_…'), 'tok');
    await user.click(screen.getByRole('button', { name: /Save source/ }));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('does not submit when name or credentials are missing', async () => {
    const user = userEvent.setup();
    mockOf(api.sources.list).mockResolvedValue([] as never);
    renderWithProviders(<Sources />);
    await user.click(await screen.findByRole('button', { name: /New source/ }));
    await user.click(screen.getByRole('button', { name: /Save source/ }));
    expect(api.sources.create).not.toHaveBeenCalled();
  });

  it('does not submit when only a name is provided', async () => {
    mockOf(api.sources.list).mockResolvedValue([] as never);
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('button', { name: /New source/ }));
    // bypass the disabled button by submitting the form directly
    const input = await screen.findByPlaceholderText('github-personal');
    await userEvent.type(input, 'no-creds');
    fireEvent.submit(input.closest('form')!);
    expect(api.sources.create).not.toHaveBeenCalled();
  });

  it('removes a source after confirmation', async () => {
    mockOf(api.sources.list).mockResolvedValue(sources as never);
    mockOf(api.sources.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Sources />);
    await screen.findByText('github-personal');
    // trash buttons render a Trash2 svg inside a <button>
    const buttons = screen.getAllByRole('button');
    const trash = buttons.find((b) => b.querySelector('svg') !== null && b.className.includes('hover:text-rose-400'))!;
    await userEvent.click(trash);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.sources.remove).toHaveBeenCalledWith(1));
  });
  it('shows a registry username field for registry sources and sends it', async () => {
    mockOf(api.sources.create).mockResolvedValue({ id: 9 } as never);
    const user = userEvent.setup();
    renderWithProviders(<Sources />);
    fireEvent.click(await screen.findByRole('button', { name: /New source/ }));
    fireEvent.change(await screen.findByPlaceholderText('github-personal'), { target: { value: 'ghcr' } });
    // Switch the type select to registry FIRST so the password field is the
    // only credential input we need to fill (no PAT placeholder to confuse
    // the test).
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'registry' } });
    const passwordField = await screen.findByPlaceholderText('dckr_pat_… / password');
    await user.type(passwordField, 'regpass');
    const userField = await screen.findByPlaceholderText('dockerhub-user');
    await user.type(userField, 'ci-bot');
    fireEvent.submit(userField.closest('form')!);
    await waitFor(() =>
      expect(api.sources.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'registry', registryUsername: 'ci-bot', token: 'regpass' })));
  });

  // F1008: the credential test shows the GitHub token kind, scopes and the
  // warnings that explain missing private repositories.
  it('tests a token and shows its scopes and warnings; failures show the status', async () => {
    const test = vi.fn();
    (api.sources as unknown as { test: typeof test }).test = test;
    test.mockResolvedValueOnce({
      ok: true,
      provider: 'github',
      login: 'octocat',
      name: 'The Octocat',
      tokenKind: 'classic',
      scopes: ['public_repo', 'read:org'],
      warnings: ['This classic token lacks the `repo` scope — private repositories are not listed and cannot be cloned.'],
    });
    mockOf(api.sources.list).mockResolvedValue(sources as never);
    renderWithProviders(<Sources />);
    await screen.findByText('github-personal');
    // Only the token-bearing GitHub source can be tested (source 2 has a key only).
    const buttons = screen.getAllByRole('button', { name: /Test token/ });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(test).toHaveBeenCalledWith(1));
    const result = await screen.findByTestId('source-test-result');
    expect(result).toHaveTextContent('Authenticates as octocat (The Octocat)');
    expect(result).toHaveTextContent('Token type: classic');
    expect(result).toHaveTextContent('Scopes: public_repo, read:org');
    expect(result).toHaveTextContent('lacks the `repo` scope');

    test.mockResolvedValueOnce({ ok: false, provider: 'github', status: 401, error: 'Bad credentials' });
    await userEvent.click(screen.getByRole('button', { name: /Test token/ }));
    await waitFor(() => expect(screen.getByTestId('source-test-result')).toHaveTextContent('Check failed (HTTP 401): Bad credentials'));
    expect(screen.getByTestId('source-test-result')).not.toHaveTextContent('Scopes');
  });

  it('r473: a member gets the operators-only one-liner and no listing call', async () => {
    authState.user = { id: 7, isOperator: false };
    renderWithProviders(<Sources />);
    expect(await screen.findByText(/operators only/i)).toBeInTheDocument();
    expect(mockOf(api.sources.list)).not.toHaveBeenCalled();
  });
});
