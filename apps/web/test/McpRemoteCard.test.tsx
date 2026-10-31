import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpRemoteCard } from '../src/routes/settings/McpRemoteCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('McpRemoteCard (R4)', () => {
  it('turns remote MCP on and then shows the endpoint and how to connect', async () => {
    mockOf(api.mcpRemote.policy).mockResolvedValue({ policy: { enabled: false, readOnly: false }, path: '/v1/mcp' } as never);
    mockOf(api.mcpRemote.setPolicy).mockResolvedValue({ policy: { enabled: true, readOnly: false }, path: '/v1/mcp' } as never);
    renderWithProviders(<McpRemoteCard />);
    expect(screen.queryByText(/claude mcp add/)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('switch', { name: 'Serve MCP over HTTP' }));
    await waitFor(() => expect(api.mcpRemote.setPolicy).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByText(`${window.location.origin}/v1/mcp`)).toBeInTheDocument();
    expect(screen.getByText(/claude mcp add --transport http ninedeploy/)).toBeInTheDocument();
  });

  it('sets the read-only switch on its own', async () => {
    mockOf(api.mcpRemote.policy).mockResolvedValue({ policy: { enabled: true, readOnly: false }, path: '/v1/mcp' } as never);
    mockOf(api.mcpRemote.setPolicy).mockResolvedValue({ policy: { enabled: true, readOnly: true }, path: '/v1/mcp' } as never);
    renderWithProviders(<McpRemoteCard />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Read-only tools only, for every caller' }));
    await waitFor(() => expect(api.mcpRemote.setPolicy).toHaveBeenCalledWith({ readOnly: true }));
  });

  it('shows a load error with a retry', async () => {
    mockOf(api.mcpRemote.policy).mockRejectedValue(new Error('Operator access required'));
    renderWithProviders(<McpRemoteCard />);
    expect(await screen.findByText('Could not load remote MCP')).toBeInTheDocument();
  });
});
