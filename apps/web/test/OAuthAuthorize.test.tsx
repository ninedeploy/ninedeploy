import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OAuthAuthorize } from '../src/routes/OAuthAuthorize.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const QUERY = '?response_type=code&client_id=ndc_abcdefghijkl&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&code_challenge=x&code_challenge_method=S256&state=s1';
const assign = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  assign.mockReset();
});

function render() {
  vi.stubGlobal('location', { ...window.location, assign });
  return renderWithProviders(<OAuthAuthorize />, { route: `/oauth/authorize${QUERY}` });
}

describe('OAuthAuthorize (R4)', () => {
  it('keeps reduced access after a failed approval and allows a retry without redirecting early', async () => {
    mockOf(api.mcpRemote.checkAuthorization).mockResolvedValue({ client: { name: 'Client', redirectHost: '127.0.0.1:9' }, requestedAccess: 'full' } as never);
    mockOf(api.mcpRemote.decideAuthorization).mockRejectedValueOnce(new Error('Grant expired')).mockResolvedValueOnce({ redirect: 'http://127.0.0.1:9/cb?code=retry' } as never);
    render();
    await userEvent.click(await screen.findByRole('radio', { name: /Read only/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('Grant expired')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /Read only/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:9/cb?code=retry'));
    expect(api.mcpRemote.decideAuthorization).toHaveBeenLastCalledWith(expect.objectContaining({ approve: true, access: 'read' }));
  });

  it('names the client and its return host, and approves with the chosen access', async () => {
    mockOf(api.mcpRemote.checkAuthorization).mockResolvedValue({ client: { name: 'Claude', redirectHost: '127.0.0.1:9' }, requestedAccess: 'read' } as never);
    mockOf(api.mcpRemote.decideAuthorization).mockResolvedValue({ redirect: 'http://127.0.0.1:9/cb?code=c&state=s1' } as never);
    render();
    expect(await screen.findByText('127.0.0.1:9')).toBeInTheDocument();
    expect(screen.getByText(/Claude wants to use NineDeploy/)).toBeInTheDocument();
    expect(api.mcpRemote.checkAuthorization).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'ndc_abcdefghijkl', state: 's1' }));
    // Read was requested and is preselected; the user widens it.
    expect(screen.getByRole('radio', { name: /Read only/ })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /Full/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.mcpRemote.decideAuthorization).toHaveBeenCalledWith(expect.objectContaining({ approve: true, access: 'full' })));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:9/cb?code=c&state=s1'));
  });

  it('denies', async () => {
    mockOf(api.mcpRemote.checkAuthorization).mockResolvedValue({ client: { name: 'Claude', redirectHost: '127.0.0.1:9' }, requestedAccess: 'full' } as never);
    mockOf(api.mcpRemote.decideAuthorization).mockResolvedValue({ redirect: 'http://127.0.0.1:9/cb?error=access_denied' } as never);
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(api.mcpRemote.decideAuthorization).toHaveBeenCalledWith(expect.objectContaining({ approve: false })));
  });

  it('inside a frame it shows no buttons at all (clickjacking)', async () => {
    mockOf(api.mcpRemote.checkAuthorization).mockResolvedValue({ client: { name: 'Claude', redirectHost: '127.0.0.1:9' }, requestedAccess: 'full' } as never);
    vi.stubGlobal('top', {});
    renderWithProviders(<OAuthAuthorize />, { route: `/oauth/authorize${QUERY}` });
    expect(await screen.findByText('Open this page in its own browser tab to approve an MCP client.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('shows a refused request and never redirects', async () => {
    mockOf(api.mcpRemote.checkAuthorization).mockRejectedValue(new Error('The redirect address is not one the client registered'));
    render();
    expect(await screen.findByText('This authorization request cannot be used')).toBeInTheDocument();
    expect(screen.getByText('The redirect address is not one the client registered')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
