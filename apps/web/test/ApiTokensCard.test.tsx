import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ApiTokensCard } from '../src/routes/settings/ApiTokensCard.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.3 Settings → Security → API tokens: create (shown once), list, revoke (confirmed). */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const DAY = 24 * 60 * 60 * 1000;
const TOKENS = [
  { id: 1, name: 'ci', scopes: ['write'], lastUsedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 30 * DAY).toISOString(), createdAt: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'old-script', scopes: [], lastUsedAt: null, expiresAt: null, createdAt: '2025-01-01T00:00:00Z' },
  { id: 3, name: 'mcp', scopes: ['nd://scope/read/services'], lastUsedAt: null, expiresAt: new Date(Date.now() - DAY).toISOString(), createdAt: '2025-06-01T00:00:00Z' },
];
const asOperator = (isOperator: boolean) => mockOf(useAuth).mockReturnValue({ user: { id: 1, isOperator }, loading: false } as never);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  mockOf(api.auth.tokens.list).mockResolvedValue(TOKENS as never);
  asOperator(true);
});

describe('ApiTokensCard', () => {
  it('lists each token with its access, last use and expiry; legacy and expired ones are flagged', async () => {
    renderWithProviders(<ApiTokensCard />);
    const list = await screen.findByRole('list', { name: 'Your API tokens' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('write')).toBeInTheDocument();
    expect(rows[0]!.textContent).toMatch(/last used .*· expires/);
    expect(within(rows[1]!).getByText('unrestricted (legacy)')).toBeInTheDocument();
    expect(rows[1]!.textContent).toMatch(/never used · never expires/);
    expect(within(rows[2]!).getByText('read/services')).toBeInTheDocument();
    expect(within(rows[2]!).getAllByText('expired').length).toBeGreaterThan(0);
  });

  it('creates a token with the chosen name, access and lifetime, and shows it once', async () => {
    mockOf(api.auth.tokens.create).mockResolvedValue({ id: 9, name: 'gha', token: 'nd_secret_value', scopes: ['write'], expiresAt: null, createdAt: '2026-10-19T00:00:00Z' } as never);
    renderWithProviders(<ApiTokensCard />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: ' gha ' } });
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'write' } });
    expect(screen.getByText(/as a non-operator/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(api.auth.tokens.create).toHaveBeenCalledWith({ name: 'gha', scopes: ['write'], expiresInDays: 90 }));
    expect(await screen.findByText('nd_secret_value')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('nd_secret_value'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('nd_secret_value')).not.toBeInTheDocument();
  });

  it('a blank name is sent as "cli"; read-only and one year are the defaults; a refusal is shown', async () => {
    mockOf(api.auth.tokens.create).mockRejectedValueOnce(new Error('nope')).mockRejectedValueOnce(new Error(''));
    renderWithProviders(<ApiTokensCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(api.auth.tokens.create).toHaveBeenCalledWith({ name: 'cli', scopes: ['read'], expiresInDays: 365 }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('nope', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not create the token', 'error'));
  });

  it('offers full access only to an operator', async () => {
    asOperator(false);
    renderWithProviders(<ApiTokensCard />);
    const access = await screen.findByLabelText('Access');
    expect(within(access).queryByRole('option', { name: 'Full access' })).not.toBeInTheDocument();
    expect(within(access).getByRole('option', { name: 'Read & write' })).toBeInTheDocument();
  });

  it('revokes a token only after confirming', async () => {
    mockOf(api.auth.tokens.remove).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new Error('API token not found'));
    renderWithProviders(<ApiTokensCard />);
    const list = await screen.findByRole('list', { name: 'Your API tokens' });
    fireEvent.click(within(list).getAllByRole('button', { name: 'Revoke' })[0]!);
    expect(screen.getByText(/Anything using “ci” stops working/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.auth.tokens.remove).not.toHaveBeenCalled();
    fireEvent.click(within(list).getAllByRole('button', { name: 'Revoke' })[0]!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.auth.tokens.remove).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Token revoked', 'success'));
    fireEvent.click(within(list).getAllByRole('button', { name: 'Revoke' })[1]!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('API token not found', 'error'));
  });

  it('empty and failed lists', async () => {
    mockOf(api.auth.tokens.list).mockResolvedValueOnce([] as never);
    const { unmount } = renderWithProviders(<ApiTokensCard />);
    expect(await screen.findByText('No API tokens.')).toBeInTheDocument();
    unmount();
    mockOf(api.auth.tokens.list).mockRejectedValueOnce(new Error('down'));
    renderWithProviders(<ApiTokensCard />);
    expect(await screen.findByText('Could not load your tokens.')).toBeInTheDocument();
  });
});
