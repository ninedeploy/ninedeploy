import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import './web-utils.js';
import { CommandPalette } from '../src/components/CommandPalette.js';

const apiMock = vi.hoisted(() => ({
  api: {
    services: { list: vi.fn() },
    databases: { list: vi.fn() },
    templates: { list: vi.fn() },
    plugins: { list: vi.fn() },
    menus: { list: vi.fn() },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPalette(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/current']}>
        <CommandPalette onClose={onClose} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

function key(key: string, opts: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, ...opts });
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.services.list.mockResolvedValue([]);
    apiMock.api.databases.list.mockResolvedValue([]);
    apiMock.api.templates.list.mockResolvedValue([]);
    apiMock.api.plugins.list.mockResolvedValue({ plugins: [] });
    apiMock.api.menus.list.mockResolvedValue({ items: [] });
  });

  it('lists the first 8 nav commands when the query is empty', async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    expect(screen.getByText('Services')).toBeInTheDocument();
    expect(screen.getByText('Databases')).toBeInTheDocument();
    expect(screen.getAllByText('Navigate')).toHaveLength(8);
  });

  it('filters commands by label', async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'Volumes' } });
    expect(screen.getByText('Volumes')).toBeInTheDocument();
    expect(screen.queryByText('Hub')).not.toBeInTheDocument();
  });

  it('filters by sub-text and by type', async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'Domain routing' } });
    expect(screen.getByText('Domains')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'Service' } });
    expect(screen.getByText('Services')).toBeInTheDocument();
  });

  it('shows an empty-state message when nothing matches', async () => {
    renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'zzzz' } });
    expect(screen.getByText('No results for "zzzz"')).toBeInTheDocument();
  });

  it('includes dynamic service/database/template results', async () => {
    apiMock.api.services.list.mockResolvedValue([
      { id: 5, name: 'blog', type: 'docker', status: 'running' },
    ] as never);
    apiMock.api.databases.list.mockResolvedValue([
      { id: 9, name: 'pg-main', engine: 'postgres', status: 'running' },
    ] as never);
    apiMock.api.templates.list.mockResolvedValue([
      { id: 'n8n', name: 'n8n', tagline: 'Workflow automation' },
    ] as never);
    apiMock.api.plugins.list.mockResolvedValue({
      plugins: [
        { id: 'datadog', name: 'Datadog APM', version: '1.0.0', status: 'active' },
      ],
    } as never);
    apiMock.api.menus.list.mockResolvedValue({
      items: [
        { id: 'cf-tunnel-nav', label: 'Cloudflare Tunnels Extension', route: '/tunnels', icon: 'cloud' },
        { id: 'custom-ext', label: 'Custom Ext', route: '/custom', icon: 'unknown_icon' },
      ],
    } as never);
    renderPalette();
    // Query 'b' matches nav "Backups" and service "blog" (label) + database
    // "Backups" doesn't match pg-main — use a broader query to surface all
    // dynamic results; the test asserts they render alongside nav commands.
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'b' } });
    await waitFor(() => expect(screen.getByText('blog')).toBeInTheDocument());
    expect(screen.getByText('pg-main')).toBeInTheDocument();
    // Template's label is "Deploy n8n" which doesn't contain 'b'; broaden.
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'n' } });
    await waitFor(() => expect(screen.getByText('Deploy n8n')).toBeInTheDocument());

    // Plugin & Extension matches
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'datadog' } });
    await waitFor(() => expect(screen.getByText('Datadog APM')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'cloudflare' } });
    await waitFor(() => expect(screen.getByText('Cloudflare Tunnels Extension')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'custom ext' } });
    await waitFor(() => expect(screen.getByText('Custom Ext')).toBeInTheDocument());
  });

  it('opens a database result on its own detail page, not the list (r296)', async () => {
    apiMock.api.databases.list.mockResolvedValue([
      { id: 9, name: 'pg-main', engine: 'postgres', status: 'running' },
    ] as never);
    renderPalette();
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'pg-main' } });
    fireEvent.click(await screen.findByText('pg-main'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/databases/9'));
  });

  it('executes the selected command with Enter and closes', async () => {
    const { onClose } = renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    key('Enter');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/hub'));
    expect(onClose).toHaveBeenCalled();
  });

  it('navigates with arrow keys and Enter', async () => {
    const { onClose } = renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    key('ArrowDown'); // Services
    key('Enter');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/'));
    expect(onClose).toHaveBeenCalled();
  });

  it('clamps ArrowUp at the first result', async () => {
    const { onClose } = renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    key('ArrowUp');
    key('Enter');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/hub'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does nothing on Enter with no results', async () => {
    const { onClose } = renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'zzzz' } });
    key('Enter');
    expect(screen.getByTestId('location')).toHaveTextContent('/current');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { onClose } = renderPalette();
    key('Escape');
    expect(onClose).toHaveBeenCalled();
  });

  it('activates a command on click', async () => {
    const { onClose } = renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Hub'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/hub'));
    expect(onClose).toHaveBeenCalled();
  });

  it('tracks the hovered item as selected', async () => {
    renderPalette();
    // Type a query so Settings (which sits past the first 8 nav commands) is
    // visible alongside the other results.
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 's' } });
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    fireEvent.mouseEnter(screen.getByText('Settings'));
    key('Enter');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings'));
  });

  it('closes when the backdrop is clicked', async () => {
    const { onClose } = renderPalette();
    await waitFor(() => expect(screen.getByText('Hub')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Hub').closest('.fixed')!.firstElementChild!);
    expect(onClose).toHaveBeenCalled();
  });
});
