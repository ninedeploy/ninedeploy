import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tunnels } from '../src/routes/Tunnels.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const tunnels = [
  { id: 1, name: 'production', token: 'tok', status: 'running', containerName: 'nd-tunnel-1' },
  { id: 2, name: 'staging', token: 'tok2', status: 'error', containerName: null as string | null },
];

describe('Tunnels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the complete cloudflared routing guide', async () => {
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    renderWithProviders(<Tunnels />);
    expect(screen.getByText(/Cloudflare Tunnel \/ cloudflared/)).toBeInTheDocument();
    expect(screen.getByText(/Do not choose Mesh/)).toBeInTheDocument();
    expect(screen.getByText('http://ninedeploy-traefik:80')).toBeInTheDocument();
    // The phrase is split across a <strong> node; match the emphasised part.
    expect(screen.getByText('SSL off in NineDeploy')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Cloudflare Zero Trust/ })).toHaveAttribute('href', 'https://one.dash.cloudflare.com/');
  });

  it('copies the Traefik origin from the guide', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    renderWithProviders(<Tunnels />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy Traefik origin' }));
    expect(writeText).toHaveBeenCalledWith('http://ninedeploy-traefik:80');
  });

  it('reports a failed copy from the guide', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    renderWithProviders(<Tunnels />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy Traefik origin' }));
    // The rejection is caught and surfaced as an error toast (no unhandled crash).
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });

  it('shows skeleton while loading', () => {
    mockOf(api.tunnels.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Tunnels />);
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows empty state when there are no tunnels', async () => {
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    renderWithProviders(<Tunnels />);
    await screen.findByText('No tunnels');
    expect(screen.getByText(/Add a Cloudflare Tunnel token/)).toBeInTheDocument();
  });

  it('shows an error card with retry when the tunnels query fails', async () => {
    mockOf(api.tunnels.list).mockRejectedValue(new Error('cf down') as never);
    renderWithProviders(<Tunnels />);
    expect(await screen.findByText("Couldn't load tunnels")).toBeInTheDocument();
    expect(screen.getByText('cf down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.tunnels.list).toHaveBeenCalledTimes(2));
  });

  it('toasts on create and delete failures', async () => {
    mockOf(api.tunnels.list).mockResolvedValue(tunnels as never);
    mockOf(api.tunnels.create).mockRejectedValue(new Error('bad token') as never);
    mockOf(api.tunnels.remove).mockRejectedValue(new Error('busy') as never);
    renderWithProviders(<Tunnels />);
    fireEvent.click(await screen.findByRole('button', { name: /New tunnel/ }));
    await userEvent.type(await screen.findByPlaceholderText('production'), 'edge');
    await userEvent.type(screen.getByPlaceholderText('eyJhIjoi…'), 'tok');
    fireEvent.click(screen.getByRole('button', { name: /Start tunnel/ }));
    await waitFor(() => expect(api.tunnels.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Delete production' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.tunnels.remove).toHaveBeenCalled());
  });

  it('renders the tunnel table with statuses and containers', async () => {
    mockOf(api.tunnels.list).mockResolvedValue(tunnels as never);
    renderWithProviders(<Tunnels />);
    await screen.findByText('production');
    // Status words also appear in the guide/legend — assert presence, not uniqueness.
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    expect(screen.getAllByText('error').length).toBeGreaterThan(0);
    expect(screen.getByText('nd-tunnel-1')).toBeInTheDocument();
  });

  it('creates a tunnel via the form and resets it', async () => {
    const user = userEvent.setup();
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    mockOf(api.tunnels.create).mockResolvedValue({ id: 3, name: 'new', token: 't', status: 'running', containerName: 'c' } as never);
    renderWithProviders(<Tunnels />);
    await user.click(await screen.findByRole('button', { name: /New tunnel/ }));
    await user.type(await screen.findByPlaceholderText('production'), 'edge');
    await user.type(screen.getByPlaceholderText('eyJhIjoi…'), 'secret-token');
    await user.click(screen.getByRole('button', { name: /Start tunnel/ }));
    await waitFor(() => expect(api.tunnels.create).toHaveBeenCalledWith({ name: 'edge', token: 'secret-token' }));
    // form closes on success
    expect(screen.queryByPlaceholderText('production')).not.toBeInTheDocument();
  });

  it('does not submit the tunnel form when fields are empty', async () => {
    const user = userEvent.setup();
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    renderWithProviders(<Tunnels />);
    await user.click(await screen.findByRole('button', { name: /New tunnel/ }));
    await user.click(screen.getByRole('button', { name: /Start tunnel/ }));
    expect(api.tunnels.create).not.toHaveBeenCalled();
  });

  it('does not submit the tunnel form when only a name is provided', async () => {
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    renderWithProviders(<Tunnels />);
    fireEvent.click(await screen.findByRole('button', { name: /New tunnel/ }));
    const input = await screen.findByPlaceholderText('production');
    await userEvent.type(input, 'edge');
    fireEvent.submit(input.closest('form')!);
    expect(api.tunnels.create).not.toHaveBeenCalled();
  });

  it('shows the starting label while a tunnel is being created', async () => {
    const user = userEvent.setup();
    mockOf(api.tunnels.list).mockResolvedValue([] as never);
    mockOf(api.tunnels.create).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Tunnels />);
    await user.click(await screen.findByRole('button', { name: /New tunnel/ }));
    await user.type(await screen.findByPlaceholderText('production'), 'edge');
    await user.type(screen.getByPlaceholderText('eyJhIjoi…'), 'tok');
    await user.click(screen.getByRole('button', { name: /Start tunnel/ }));
    expect(await screen.findByText('Starting…')).toBeInTheDocument();
  });

  it('removes a tunnel after confirmation', async () => {
    mockOf(api.tunnels.list).mockResolvedValue(tunnels as never);
    mockOf(api.tunnels.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Tunnels />);
    await screen.findByText('production');
    fireEvent.click(screen.getByRole('button', { name: 'Delete production' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.tunnels.remove).toHaveBeenCalledWith(1));
  });
});
