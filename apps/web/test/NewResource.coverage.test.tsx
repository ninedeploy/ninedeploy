import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import { NewResource } from '../src/routes/NewResource.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});
vi.mock('../src/components/DeployWizard.js', () => ({
  DeployWizard: ({ template, onClose }: { template: { name: string }; onClose: () => void }) => (
    <div data-testid="deploy-wizard">
      wizard-{template?.name}
      <button type="button" onClick={onClose}>
        close deploy wizard
      </button>
    </div>
  ),
}));
vi.mock('../src/components/DatabaseWizard.js', async (orig) => ({
  ...(await orig<typeof import('../src/components/DatabaseWizard.js')>()),
  DatabaseWizard: ({ initialEngine, onClose, onCreated }: { initialEngine: string; onClose: () => void; onCreated: (db: { id: number }) => void }) => (
    <div data-testid="db-wizard">
      db-{initialEngine}
      <button type="button" onClick={onClose}>
        close db wizard
      </button>
      <button type="button" onClick={() => onCreated({ id: 42 })}>
        finish db wizard
      </button>
    </div>
  ),
}));
vi.mock('../src/components/UploadSource.js', () => ({
  UploadSourceModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="upload-modal">
      <button type="button" onClick={onClose}>
        close upload
      </button>
    </div>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

const TEMPLATES = [{ id: 'wordpress', name: 'WordPress', tagline: 'Blogs and sites', category: 'CMS', emoji: '📝' }];

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
  for (const fn of [api.templates.list, api.templates.get, api.sources.list]) mockOf(fn as never).mockReset();
  mockOf(useAuth).mockReturnValue({ user: { id: 1, email: 'a@test', isOperator: true }, loading: false } as never);
  mockOf(api.templates.list).mockResolvedValue(TEMPLATES as never);
  mockOf(api.sources.list).mockResolvedValue([]);
});

describe('NewResource: wizard close paths and failures', () => {
  it('toasts when a one-click template cannot be loaded and opens no wizard', async () => {
    mockOf(api.templates.get).mockRejectedValue(new Error('catalog offline'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy WordPress' }));
    expect(await screen.findByText('Could not load the template: catalog offline')).toBeInTheDocument();
    expect(api.templates.get).toHaveBeenCalledWith('wordpress');
    expect(screen.queryByTestId('deploy-wizard')).not.toBeInTheDocument();
  });

  it('closes the template wizard', async () => {
    mockOf(api.templates.get).mockResolvedValue({ ...TEMPLATES[0], description: 'd', image: 'wordpress', port: 80 } as never);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy WordPress' }));
    expect(await screen.findByTestId('deploy-wizard')).toHaveTextContent('wizard-WordPress');
    fireEvent.click(screen.getByRole('button', { name: 'close deploy wizard' }));
    expect(screen.queryByTestId('deploy-wizard')).not.toBeInTheDocument();
  });

  it('closes the database wizard, and navigates to a created database', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Redis database' }));
    fireEvent.click(screen.getByRole('button', { name: 'close db wizard' }));
    expect(screen.queryByTestId('db-wizard')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'PostgreSQL database' }));
    expect(screen.getByTestId('db-wizard')).toHaveTextContent('db-postgres');
    fireEvent.click(screen.getByRole('button', { name: 'finish db wizard' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/databases/42'));
  });

  it('opens and closes the source upload', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Upload source' }));
    expect(screen.getByTestId('upload-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close upload' }));
    expect(screen.queryByTestId('upload-modal')).not.toBeInTheDocument();
  });

  it('offers a Git repository when nothing matches', async () => {
    renderPage();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: 'zzzz-nothing' } });
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'a Git repository' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('deploy=git'));
  });
});
