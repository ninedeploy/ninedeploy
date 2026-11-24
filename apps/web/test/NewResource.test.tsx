import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { importPlan } from '@ninedeploy/schemas';
import { useLocation } from 'react-router';
import { NewResource } from '../src/routes/NewResource.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { prepareImportResources } from '../src/lib/prepareImportResources.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return { ...createFakeApiModule(), getApiSessionGeneration: () => 0 };
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

  it('reviews a local migration plan, including manual steps, without applying it', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Review migration plan' }));
    const file = planFile({
      planVersion: 1,
      source: { kind: 'coolify', url: 'https://user:do-not-display@source.example?token=discard-this', version: null, scope: 'Project team' },
      generatedAt: '2026-11-23T11:00:00Z',
      services: [{
        ref: 'web', name: 'Example app', kind: 'image', create: { name: 'Example app', type: 'docker', image: 'nginx:1.27' },
        domains: [{ host: 'app.example', https: true }], env: [{ key: 'API_TOKEN', value: 'must-not-render' }],
        volumes: [{ mountPath: '/data', source: 'volume', name: 'files' }],
        issues: [{ level: 'manual', option: 'volume', detail: 'Copy the second volume separately.' }],
      }],
      databases: [{ ref: 'db', name: 'Example database', engine: 'postgres', image: 'postgres:16', issues: [] }],
      notes: [],
    });
    fireEvent.change(screen.getByLabelText('Migration plan JSON'), { target: { files: [file] } });

    await screen.findByText('source.example');
    fireEvent.click(screen.getByText('Example app'));
    expect(screen.getByText('app.example')).toBeVisible();
    expect(screen.getByText('API_TOKEN')).toBeVisible();
    expect(screen.getByText('/data')).toBeVisible();
    expect(screen.getByText('Copy the second volume separately.')).toBeVisible();
    expect(screen.getByText('Example database')).toBeVisible();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/do-not-display|discard-this|must-not-render/);
    expect(api.services.create).not.toHaveBeenCalled();
    expect(api.databases.create).not.toHaveBeenCalled();
  });

  it('rejects unsupported or malformed plans before showing a preview', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Review migration plan' }));
    fireEvent.change(screen.getByLabelText('Migration plan JSON'), { target: { files: [planFile({ planVersion: 2 })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a version 1 migration plan.');
  });

  it('checks proposed names against the target and reports repeated names and unfinished entries', async () => {
    mockOf(api.services.list).mockResolvedValue([{ id: 7, slug: 'aa' }] as never);
    mockOf(api.databases.list).mockResolvedValue([{ id: 8, slug: 'store-db' }] as never);
    renderPage();
    await openTargetPlan();
    expect(api.services.list).not.toHaveBeenCalled();
    expect(api.databases.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check target' }));

    expect(await screen.findAllByText('Target name already in use.')).toHaveLength(3);
    expect(screen.getAllByText('Repeated target name in plan.')).toHaveLength(2);
    expect(screen.getAllByText('Repeated reference in plan.')).toHaveLength(2);
    expect(screen.getByText('Add an image or repository before applying.')).toBeVisible();
    expect(screen.getByText('Select a supported database engine before applying.')).toBeVisible();
    expect(screen.getByText('Review proposed settings.')).toBeVisible();
    expect(api.services.create).not.toHaveBeenCalled();
    expect(api.databases.create).not.toHaveBeenCalled();
  });

  it('keeps local plan review available to members without checking incomplete target inventories', async () => {
    asOperator(false);
    renderPage();
    await openTargetPlan();
    expect(screen.queryByRole('button', { name: 'Check target' })).not.toBeInTheDocument();
    expect(api.services.list).not.toHaveBeenCalled();
    expect(api.databases.list).not.toHaveBeenCalled();
  });

  it('reports a target inventory error and can check again after it recovers', async () => {
    mockOf(api.services.list).mockRejectedValueOnce(new Error('inventory unavailable')).mockResolvedValue([]);
    mockOf(api.databases.list).mockResolvedValue([]);
    renderPage();
    await openTargetPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Check target' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the target inventory.');

    fireEvent.click(screen.getByRole('button', { name: 'Check target' }));
    expect(await screen.findByText('Review 5 planned resources')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('requires confirmation before preparing a service and an empty database', async () => {
    sessionStorage.clear();
    mockOf(api.services.list).mockResolvedValue([]);
    mockOf(api.databases.list).mockResolvedValueOnce([]).mockResolvedValue([{ id: 42, slug: 'prepared-db', engine: 'postgres' }] as never);
    mockOf(api.services.create).mockResolvedValue({ id: 41 } as never);
    mockOf(api.databases.createEmpty).mockResolvedValue({ id: 42 } as never);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Review migration plan' }));
    fireEvent.change(screen.getByLabelText('Migration plan JSON'), { target: { files: [planFile({
      planVersion: 1,
      source: { kind: 'coolify', url: 'https://prepare.example', version: null, scope: 'Workspace' },
      generatedAt: '2026-11-23T12:00:00Z',
      services: [{ ref: 'web', name: 'Prepared App', kind: 'image', create: { name: 'Prepared App', type: 'docker', image: 'nginx:1.27' },
        env: [], domains: [{ host: 'old.example', https: true }], issues: [], volumes: [] }],
      databases: [{ ref: 'database', name: 'Prepared DB', engine: 'postgres', image: 'postgres:16', issues: [] }],
      notes: [],
    })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare resources' }));
    expect(api.services.create).not.toHaveBeenCalled();
    expect(api.databases.createEmpty).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create resources' }));
    expect(await screen.findByText('Prepared 2 resources')).toBeVisible();
    expect(api.services.create).toHaveBeenCalledWith({ name: 'Prepared App', type: 'docker', image: 'nginx:1.27' });
    expect(api.databases.createEmpty).toHaveBeenCalledWith({ name: 'Prepared DB', engine: 'postgres', version: '16' });
    expect(api.databases.create).not.toHaveBeenCalled();
    expect(api.deploys.trigger).not.toHaveBeenCalled();
    expect(api.domains.create).not.toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: 'Import a dump into Prepared DB' })).toHaveAttribute('href', '/databases/42?tab=backups#import-dump');
  });

  it('resumes the unfinished configuration without creating or changing someone else’s service', async () => {
    sessionStorage.clear();
    const operator = { id: 3, createdAt: '2026-11-23T00:00:00Z', email: 'operator@example.test' };
    const service = { ref: 'worker', name: 'Worker', kind: 'image', create: { type: 'docker', name: 'Worker', image: 'nginx' },
      domains: [], volumes: [], env: [], issues: [], settings: { healthCheck: 'running' } };
    const plan = importPlan.parse({ planVersion: 1, generatedAt: '2026-11-23T10:00:00Z',
      source: { kind: 'heroku', url: 'https://source.example', scope: 'Application', version: null },
      services: [service, { ...service, ref: 'occupied', name: 'Occupied', create: { ...service.create, name: 'Occupied' } }],
      databases: [], notes: [],
    });
    const occupied = { id: 70, slug: 'occupied', status: 'idle' };
    mockOf(api.databases.list).mockResolvedValue([]);
    mockOf(api.services.list).mockResolvedValueOnce([occupied] as never)
      .mockResolvedValueOnce([occupied, { id: 71, slug: 'worker', status: 'idle' }] as never);
    mockOf(api.services.create).mockResolvedValueOnce({ id: 71 } as never);
    mockOf(api.services.update).mockRejectedValueOnce(new Error('Temporary error')).mockResolvedValueOnce({ id: 71 } as never);
    const first = await prepareImportResources(plan, operator, api, () => true);
    expect(first).toMatchObject({ outcomes: [{ status: 'failed' }, { status: 'occupied' }] });
    const second = await prepareImportResources(plan, operator, api, () => true);
    expect(second).toMatchObject({ outcomes: [{ status: 'prepared' }, { status: 'occupied' }] });
    expect(api.services.create).toHaveBeenCalledOnce();
    expect(mockOf(api.services.update).mock.calls).toEqual([[71, { healthCheck: 'running' }], [71, { healthCheck: 'running' }]]);
  });

  it('checks a planned custom domain and attaches it only after confirmation', async () => {
    sessionStorage.clear();
    const host = 'shop.example.test';
    mockOf(api.services.list).mockResolvedValueOnce([]).mockResolvedValue([{ id: 41, slug: 'shop', type: 'docker' }] as never);
    mockOf(api.databases.list).mockResolvedValue([]);
    mockOf(api.services.create).mockResolvedValue({ id: 41 } as never);
    mockOf(api.domains.cutoverCheck).mockResolvedValue({ hostname: host, status: 'ready' });
    mockOf(api.domains.cutover).mockResolvedValue({ hostname: host, status: 'active' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Review migration plan' }));
    fireEvent.change(screen.getByLabelText('Migration plan JSON'), { target: { files: [planFile({
      planVersion: 1, generatedAt: '2026-11-23T10:00:00Z',
      source: { kind: 'coolify', url: 'https://source.example', scope: 'Application', version: null },
      services: [{ ref: 'shop', name: 'Shop', kind: 'image', create: { type: 'docker', name: 'Shop', image: 'nginx' },
        domains: [{ host, https: false }, { host: 'old.example.test', https: true, sourceDefault: true }, { host: '*.example.test', https: true }],
        env: [], volumes: [], issues: [] }],
      databases: [], notes: [],
    })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare resources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create resources' }));
    const cutover = within(await screen.findByRole('region', { name: `Cutover for ${host}` }));
    expect(screen.queryByRole('region', { name: 'Cutover for old.example.test' })).not.toBeInTheDocument();
    expect(screen.getByText('This hostname needs manual routing review.')).toBeVisible();
    fireEvent.click(cutover.getByRole('button', { name: 'Check cutover' }));
    fireEvent.click(await cutover.findByRole('button', { name: 'Attach domain' }));
    expect(api.domains.cutover).not.toHaveBeenCalled();
    fireEvent.click(cutover.getByRole('button', { name: 'Confirm domain cutover' }));
    expect(await cutover.findByText('Domain is attached.')).toBeVisible();
    expect(api.domains.cutover).toHaveBeenCalledWith(41, { hostname: host, ssl: false });
    expect(api.domains.create).not.toHaveBeenCalled();
  });

  it('offers environment migration only for a prepared service', async () => {
    sessionStorage.clear();
    mockOf(api.services.list).mockResolvedValueOnce([]).mockResolvedValue([{ id: 41, slug: 'shop', type: 'docker' }] as never);
    mockOf(api.databases.list).mockResolvedValue([]);
    mockOf(api.services.create).mockResolvedValue({ id: 41 } as never);
    mockOf(api.services.get).mockResolvedValue({ id: 41, slug: 'shop', type: 'docker' } as never);
    mockOf(api.attachments.list).mockResolvedValue([]);
    mockOf(api.env.list).mockResolvedValue([]);
    mockOf(api.env.import).mockResolvedValue({ imported: 1, skipped: 0, errors: [] });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Review migration plan' }));
    fireEvent.change(screen.getByLabelText('Migration plan JSON'), { target: { files: [planFile({
      planVersion: 1, generatedAt: '2026-11-24T10:00:00Z',
      source: { kind: 'coolify', url: 'https://source.example', scope: 'Application', version: null },
      services: [{ ref: 'shop', name: 'Shop', kind: 'image', create: { type: 'docker', name: 'Shop', image: 'nginx' },
        domains: [], env: [{ key: 'API_KEY' }], volumes: [], issues: [] }], databases: [], notes: [],
    })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare resources' }));
    expect(screen.queryByLabelText('Environment file')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create resources' }));
    const fileInput = await screen.findByLabelText('Environment file');
    const readiness = within(screen.getByRole('region', { name: 'Deployment readiness for Shop' }));
    const snapshot = { id: 41, slug: 'shop', type: 'docker' as const, status: 'idle' as const, hasSource: true,
      bindings: [], managedDatabaseKeys: [], secretReferenceKeys: [], deploymentPending: false, databaseImportsPending: false, volumeImportsPending: false };
    mockOf(api.deploys.migrationReadiness).mockResolvedValueOnce({ ...snapshot, environmentKeys: [] })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: ['API_KEY'], databaseImportsPending: true })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: ['API_KEY'] });
    fireEvent.click(readiness.getByRole('button', { name: 'Check deployment readiness' }));
    expect(await readiness.findByText('Planned environment keys missing on the target')).toBeVisible();
    expect(readiness.getByText('API_KEY')).toBeVisible();
    expect(readiness.queryByRole('link', { name: 'Open deployments' })).not.toBeInTheDocument();
    const file = (text: string) => Object.assign(new File([text], 'migration.env'), { text: async () => text });
    fireEvent.change(fileInput, { target: { files: [file('API_KEY="broken\nline"')] } });
    expect(await screen.findByText('Choose a file with unique, single-line KEY=value entries.')).toBeVisible();
    expect(api.env.import).not.toHaveBeenCalled();
    fireEvent.change(fileInput, { target: { files: [file('API_KEY=" private-test #value " # comment "here"\nEXTRA=unplanned')] } });
    expect(await screen.findByText('1 unplanned keys skipped.')).toBeVisible();
    expect(screen.queryByText(/private-test/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply migration settings' }));
    expect(api.env.import).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm environment migration' }));
    expect(await screen.findByText('1 secret values saved, 0 existing keys kept, 0 refused.')).toBeVisible();
    expect(api.env.import).toHaveBeenCalledWith(41, "API_KEY=' private-test #value '", { isSecret: true, overwriteExisting: false });
    fireEvent.click(readiness.getByRole('button', { name: 'Check deployment readiness' }));
    expect(await readiness.findByText('Finish or cancel pending data imports before deploying.')).toBeVisible();
    fireEvent.click(readiness.getByRole('button', { name: 'Check deployment readiness' }));
    expect(await readiness.findByRole('link', { name: 'Open deployments' })).toHaveAttribute('href', '/services/41?tab=deploys');
    expect(api.deploys.trigger).not.toHaveBeenCalled();
  });
});

function planFile(contents: unknown): File {
  const json = JSON.stringify(contents);
  return Object.assign(new File([json], 'plan.json', { type: 'application/json' }), { text: async () => json });
}

async function openTargetPlan() {
  const service = (ref: string, name: string, create: Record<string, unknown>) => ({
    ref, name, kind: 'image', create: { type: 'docker', name, ...create }, domains: [], env: [], volumes: [], issues: [],
  });
  const file = planFile({
    planVersion: 1,
    source: { kind: 'coolify', url: 'https://source.example', version: null, scope: 'Workspace' },
    generatedAt: '2026-11-23T11:00:00Z',
    services: [
      service('repeat', 'Different display name', { name: 'A!', image: 'nginx' }),
      service('repeat', 'A?', { image: 'nginx' }),
      service('no-image', 'No source', {}),
      service('wrong-port', 'Invalid port', { image: 'nginx', port: 70000 }),
    ],
    databases: [
      { ref: 'db', name: 'Store DB', engine: 'postgres', image: null, issues: [] },
      { ref: 'external', name: 'External DB', engine: null, image: null, issues: [] },
    ],
    notes: [],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review migration plan' }));
  fireEvent.change(screen.getByLabelText('Migration plan JSON'), { target: { files: [file] } });
  await screen.findByText('source.example');
}
