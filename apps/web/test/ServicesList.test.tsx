import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServicesList } from '../src/routes/ServicesList.js';
import { api } from '../src/lib/api.js';
import { TagScopeProvider } from '../src/lib/projects.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/components/DeployWizard.js', () => ({
  DeployWizard: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="deploy-wizard">
      wizard
      <button type="button" onClick={onClose}>close wizard</button>
    </div>
  ),
}));

const services = [
  { id: 1, name: 'my-api', slug: 'my-api', type: 'docker', branch: 'main', port: 3000, status: 'running' },
  { id: 2, name: 'worker', slug: 'worker', type: 'pm2', branch: 'dev', port: null, status: 'stopped' },
];

describe('ServicesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows skeleton while loading', () => {
    mockOf(api.services.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<ServicesList />);
    expect(document.querySelectorAll('.animate-pulse').length).toBe(9);
  });

  it('shows an error card with retry when the services query fails', async () => {
    mockOf(api.services.list).mockRejectedValue(new Error('api down') as never);
    renderWithProviders(<ServicesList />);
    expect(await screen.findByText("Couldn't load services")).toBeInTheDocument();
    expect(screen.getByText('api down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.services.list).toHaveBeenCalledTimes(2));
  });

  it('shows empty state with a create action', async () => {
    const user = userEvent.setup();
    mockOf(api.services.list).mockResolvedValue([] as never);
    renderWithProviders(<ServicesList />);
    await screen.findByText('No services yet');
    // empty-state action opens the wizard
    await user.click(screen.getByRole('button', { name: /Create service/ }));
    expect(screen.getByTestId('deploy-wizard')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close wizard' }));
    expect(screen.queryByTestId('deploy-wizard')).not.toBeInTheDocument();
  });

  it('renders service cards linking to detail pages', async () => {
    mockOf(api.services.list).mockResolvedValue(services as never);
    renderWithProviders(<ServicesList />);
    expect((await screen.findAllByText('my-api')).length).toBeGreaterThanOrEqual(2); // name + slug
    expect(screen.getAllByText('worker').length).toBeGreaterThanOrEqual(2); // name + slug
    expect(screen.getByText(':3000')).toBeInTheDocument();
    expect(screen.getAllByText('running').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('stopped').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: /my-api/ })).toHaveAttribute('href', '/services/1');
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('dev')).toBeInTheDocument();
  });

  it('opens and closes the deploy wizard from the header button', async () => {
    const user = userEvent.setup();
    mockOf(api.services.list).mockResolvedValue(services as never);
    renderWithProviders(<ServicesList />);
    await user.click(await screen.findByRole('button', { name: /New service/ }));
    expect(screen.getByTestId('deploy-wizard')).toBeInTheDocument();
  });

  it('scopes the list to the selected project', async () => {
    // The project filter now lives in the chip-based tag scope
    // (`ninedeploy.tagScope`), not the legacy single-project key.
    localStorage.setItem('ninedeploy.tagScope', JSON.stringify({ projectIds: [3] }));
    mockOf(api.services.list).mockResolvedValue([] as never);
    renderWithProviders(
      <TagScopeProvider>
        <ServicesList />
      </TagScopeProvider>,
    );
    await screen.findByText('No services yet');
    expect(api.services.list).toHaveBeenCalledWith('?tagProjectIds=3');
    localStorage.removeItem('ninedeploy.tagScope');
  });

  it('filters services by search query and status pill, and resets filters', async () => {
    const user = userEvent.setup();
    mockOf(api.services.list).mockResolvedValue(services as never);
    renderWithProviders(<ServicesList />);

    await screen.findAllByText('my-api');
    const searchInput = screen.getByPlaceholderText('Search services...');
    fireEvent.change(searchInput, { target: { value: 'worker' } });

    expect(screen.getAllByText('worker').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('my-api')).not.toBeInTheDocument();

    // Filter by running status (worker is stopped) -> shows empty matching state
    const runningBtn = screen.getByRole('button', { name: 'running' });
    await user.click(runningBtn);

    expect(screen.getByText('No matching services')).toBeInTheDocument();

    // Reset filters
    const resetBtn = screen.getByRole('button', { name: 'Reset filters' });
    await user.click(resetBtn);

    expect(screen.getAllByText('my-api').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('worker').length).toBeGreaterThanOrEqual(2);
  });

  it('renders publishedPort when present on a service', async () => {
    mockOf(api.services.list).mockResolvedValue([
      { id: 3, name: 'custom-web', slug: 'custom-web', type: 'docker', branch: 'main', port: 3000, publishedPort: 8080, status: 'running' },
    ] as never);
    renderWithProviders(<ServicesList />);
    expect(await screen.findByText(':8080')).toBeInTheDocument();
  });

  it('searches by slug, branch and type, and shows live usage plus the volume badge', async () => {
    mockOf(api.services.list).mockResolvedValue([
      { id: 1, name: 'Frontend', slug: 'web-ui', type: 'docker', branch: 'release', port: 3000, status: 'running', volumeMount: '/app/data' },
      // An image-based service has no branch at all — the filter must not
      // crash on the nullish branch field.
      { id: 2, name: 'Sidebar', slug: 'side-car', type: 'docker', branch: null, port: 3010, status: 'idle' },
    ] as never);
    // A live stat row for the running service powers the cpu/mem chips
    // (7.25 rounds to a displayed 7.3%).
    mockOf(api.stats.snapshot).mockResolvedValue({
      host: null,
      containers: [{ kind: 'service', refId: 1, refName: 'Frontend', name: 'nd-web', cpuPct: 7.25, memMb: 128.5, memLimitMb: 512 }],
    } as never);
    renderWithProviders(<ServicesList />);
    await screen.findByText('Frontend');

    // Live usage comes from the snapshot, not zeros.
    await waitFor(() => expect(screen.getByText('7.3%')).toBeInTheDocument());
    expect(screen.getByText('128.5 MiB')).toBeInTheDocument();
    // Volume badge carries the mount path.
    expect(screen.getByTitle('Volume mounted at /app/data')).toBeInTheDocument();

    // Search matches slug, branch and type — and a branch-less service still
    // matches on its other fields.
    const searchInput = screen.getByPlaceholderText('Search services...');
    for (const q of ['WEB-UI', 'release', 'docker', 'side-car']) {
      fireEvent.change(searchInput, { target: { value: q } });
      expect(screen.getAllByText(/Frontend|Sidebar/).length).toBeGreaterThan(0);
    }
    fireEvent.change(searchInput, { target: { value: 'no-such-thing' } });
    expect(screen.getByText('No matching services')).toBeInTheDocument();
  });

  it('shows a stop button on running services and calls the API on click', async () => {
    mockOf(api.services.list).mockResolvedValue([
      { id: 1, name: 'web', slug: 'web', type: 'docker', branch: 'main', port: 3000, status: 'running' },
    ] as never);
    renderWithProviders(<ServicesList />);
    const stopBtn = await screen.findByTitle('Stop service');
    fireEvent.click(stopBtn);
    await waitFor(() => expect(api.services.stop).toHaveBeenCalledWith(1));
  });

  it('shows a start button on stopped services and calls the API on click', async () => {
    mockOf(api.services.list).mockResolvedValue([
      { id: 1, name: 'web', slug: 'web', type: 'docker', branch: 'main', port: 3000, status: 'stopped' },
    ] as never);
    renderWithProviders(<ServicesList />);
    const startBtn = await screen.findByTitle('Start service');
    fireEvent.click(startBtn);
    await waitFor(() => expect(api.services.start).toHaveBeenCalledWith(1));
  });
});
