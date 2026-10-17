import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import { NewResource } from '../src/routes/NewResource.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});
vi.mock('../src/components/DeployWizard.js', () => ({
  DeployWizard: ({ template }: { template: { name: string } }) => <div data-testid="deploy-wizard">wizard-{template?.name}</div>,
}));
vi.mock('../src/components/DatabaseWizard.js', async (orig) => ({
  ...(await orig<typeof import('../src/components/DatabaseWizard.js')>()),
  DatabaseWizard: ({ initialEngine }: { initialEngine: string }) => <div data-testid="db-wizard">db-{initialEngine}</div>,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

const TEMPLATES = [
  { id: 'plausible', name: 'Plausible', tagline: 'Web analytics', category: 'Analytics', emoji: '📈' },
  { id: 'n8n', name: 'n8n', tagline: 'Workflow automation', category: 'Automation', emoji: '⚡', featured: true, runtimeVerified: true },
  { id: 'wordpress', name: 'WordPress', tagline: 'Blogs and sites', category: 'CMS', emoji: '📝' },
];

const asOperator = (isOperator: boolean) =>
  mockOf(useAuth).mockReturnValue({ user: { id: 1, email: 'a@test', isOperator }, loading: false } as never);

function renderPage() {
  return renderWithProviders(
    <>
      <NewResource />
      <LocationProbe />
    </>,
    { route: '/new' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  asOperator(true);
  mockOf(api.templates.list).mockResolvedValue(TEMPLATES);
  mockOf(api.sources.list).mockResolvedValue([]);
});

describe('NewResource', () => {
  it('lists applications, databases and one-click apps, featured first', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Applications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Docker image' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PostgreSQL database' })).toBeInTheDocument();
    const apps = await screen.findAllByRole('button', { name: /^Deploy / });
    expect(apps[0]).toHaveAccessibleName('Deploy n8n');
    expect(screen.getByText(/3 in the catalog/)).toBeInTheDocument();
  });

  it('an application opens the wizard pre-set for its source', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Docker image' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/new?deploy=image'));
    fireEvent.click(screen.getByRole('button', { name: 'Static site' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/new?deploy=static'));
  });

  it('a database opens the database wizard on that engine', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Redis database' }));
    expect(screen.getByTestId('db-wizard')).toHaveTextContent('db-redis');
  });

  it('a one-click app loads its template, then opens the wizard with it', async () => {
    mockOf(api.templates.get).mockResolvedValue({ ...TEMPLATES[2], description: 'd', image: 'wordpress', port: 80 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy WordPress' }));
    expect(await screen.findByTestId('deploy-wizard')).toHaveTextContent('wizard-WordPress');
    expect(api.templates.get).toHaveBeenCalledWith('wordpress');
  });

  it('search narrows every section; "/" focuses it', async () => {
    renderPage();
    const search = screen.getByRole('textbox', { name: 'Search resources' });
    search.blur();
    fireEvent.keyDown(window, { key: '/' });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'postgres' } });
    expect(screen.getByRole('button', { name: 'PostgreSQL database' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Docker image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redis database' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'wordpress' } });
    expect(await screen.findByRole('button', { name: 'Deploy WordPress' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deploy n8n' })).not.toBeInTheDocument();
  });

  it('says so when nothing matches, and still offers an image or a repo', async () => {
    renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: 'zzzz-nothing' } });
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deploy a Docker image' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('deploy=image'));
  });

  it('the category tabs show one section at a time', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Databases' }));
    expect(screen.queryByRole('heading', { name: 'Applications' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MongoDB database' })).toBeInTheDocument();
  });

  it('members get no host-level sources; an operator without a GitHub App is sent to set one up', async () => {
    renderPage();
    expect(await screen.findByRole('link', { name: 'GitHub App: connect one first' })).toHaveAttribute('href', '/sources');
    expect(screen.getByRole('button', { name: 'Docker Compose' })).toBeInTheDocument();

    asOperator(false);
    renderPage();
    const last = screen.getAllByRole('heading', { name: 'Applications' }).at(-1)!.parentElement!;
    expect(last.querySelector('[aria-label="Docker Compose"]')).toBeNull();
    expect(last.querySelector('[aria-label="PM2 process"]')).toBeNull();
    expect(last.querySelector('[aria-label^="GitHub App"]')).toBeNull();
  });

  it('an operator with a GitHub App deploys from it directly', async () => {
    mockOf(api.sources.list).mockResolvedValue([{ id: 8, name: 'acme', type: 'github_app' }]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub App' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('deploy=github-app'));
  });
});
