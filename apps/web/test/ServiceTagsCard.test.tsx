import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { ServiceTagsCard } from '../src/routes/service/ServiceTagsCard.js';
import { TagsCard } from '../src/routes/service/SettingsTab.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
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

const project = { id: 1, name: 'Acme', slug: 'acme' };
const workspace = { id: 2, name: 'Core', slug: 'core' };
const label = { id: 3, name: 'production', color: 'rose' };

const initial = { projects: [project], workspaces: [workspace], labels: [label] };

function signedInAs(isOperator: boolean) {
  mockOf(useAuth).mockReturnValue({ user: { id: 1, isOperator }, loading: false } as never);
}

describe('ServiceTagsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedInAs(true);
    mockOf(api.projects.list).mockResolvedValue([project, { id: 9, name: 'Other', slug: 'other' }] as never);
    mockOf(api.workspaces.list).mockResolvedValue([workspace] as never);
    mockOf(api.labels.list).mockResolvedValue([label] as never);
    mockOf(api.serviceTags.get).mockResolvedValue({ serviceId: 4, ...initial } as never);
    mockOf(api.serviceTags.set).mockResolvedValue({ serviceId: 4, ...initial } as never);
  });

  it('r562: the tags editor never mounts on unloaded tags (its writes replace the whole set)', async () => {
    let fail: (e: Error) => void = () => {};
    mockOf(api.serviceTags.get).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }) as never);
    renderWithProviders(<TagsCard serviceId={4} svc={{} as never} />);
    // Loading: no editor (it used to render "untagged" and accept toggles).
    expect(screen.queryByText('Projects')).toBeNull();
    fail(new Error('HTTP 500'));
    expect(await screen.findByText('Could not load the service tags')).toBeInTheDocument();
    expect(screen.queryByText('Projects')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('Click to remove (production)')).toBeInTheDocument();
    expect(api.serviceTags.set).not.toHaveBeenCalled();
  });

  it('renders the current tags with per-group counts', async () => {
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    expect(await screen.findByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
    expect(screen.getByText('Labels')).toBeInTheDocument();
    // Projects: 1 tagged of 2 available once the options query resolves.
    await waitFor(() => expect(screen.getByText('(1 of 2)')).toBeInTheDocument());
    // The project chip carries its slug as a sublabel.
    expect(screen.getByText('· acme')).toBeInTheDocument();
  });

  it('removes a tag by clicking its chip', async () => {
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    fireEvent.click(await screen.findByTitle('Click to remove (production)'));
    await waitFor(() =>
      expect(api.serviceTags.set).toHaveBeenCalledWith(4, {
        projectIds: [1],
        workspaceIds: [2],
        labelIds: [],
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Tags updated', 'success'));
  });

  it('reports a failed tag write', async () => {
    mockOf(api.serviceTags.set).mockRejectedValue(new Error('nope') as never);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    fireEvent.click(await screen.findByTitle('Click to remove (Acme)'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('nope', 'error'));
  });

  it('reports a non-Error tag write rejection with the fallback message', async () => {
    mockOf(api.serviceTags.set).mockRejectedValue('boom' as never);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    fireEvent.click(await screen.findByTitle('Click to remove (Core)'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not update tags', 'error'));
  });

  it('shows the untagged placeholder for an empty group', async () => {
    const empty = { projects: [], workspaces: [], labels: [] };
    mockOf(api.serviceTags.get).mockResolvedValue({ serviceId: 4, ...empty } as never);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={empty as never} />);

    await waitFor(() => expect(screen.getAllByText('Not tagged')).toHaveLength(3));
  });

  it('creates a label from the modal and attaches it in one write', async () => {
    mockOf(api.labels.create).mockResolvedValue({ id: 77, name: 'staging', color: 'sky' } as never);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    // The "Add" control of the Labels group opens the create modal.
    fireEvent.click((await screen.findAllByTitle('Add more'))[2]!);
    expect(screen.getByText('Create label')).toBeInTheDocument();
    // Operators may leave the label global.
    expect(screen.getByRole('option', { name: 'Global (no workspace)' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: ' staging ' } });
    fireEvent.change(screen.getByDisplayValue('indigo'), { target: { value: 'sky' } });
    fireEvent.change(screen.getByDisplayValue('Global (no workspace)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Create & add/ }));

    await waitFor(() =>
      expect(api.labels.create).toHaveBeenCalledWith({ name: 'staging', color: 'sky', workspaceId: 2 }),
    );
    await waitFor(() =>
      expect(api.serviceTags.set).toHaveBeenCalledWith(4, {
        projectIds: [1],
        workspaceIds: [2],
        labelIds: [3, 77],
      }),
    );
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Label "staging" created and added', 'success'),
    );
  });

  it('creates a global label when no workspace is picked', async () => {
    mockOf(api.labels.create).mockResolvedValue({ id: 78, name: 'edge', color: 'indigo' } as never);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    fireEvent.click((await screen.findAllByTitle('Add more'))[2]!);
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'edge' } });
    fireEvent.click(screen.getByRole('button', { name: /Create & add/ }));

    await waitFor(() =>
      expect(api.labels.create).toHaveBeenCalledWith({ name: 'edge', color: 'indigo', workspaceId: null }),
    );
  });

  it('reports a failed label creation and keeps the modal open', async () => {
    mockOf(api.labels.create).mockRejectedValue(new Error('duplicate') as never);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    fireEvent.click((await screen.findAllByTitle('Add more'))[2]!);
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'dup' } });
    fireEvent.click(screen.getByRole('button', { name: /Create & add/ }));

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('duplicate', 'error'));
    expect(screen.getByText('Create label')).toBeInTheDocument();
  });

  it('reports a non-Error label creation rejection with the fallback message', async () => {
    mockOf(api.labels.create).mockRejectedValue('kaboom' as never);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    fireEvent.click((await screen.findAllByTitle('Add more'))[2]!);
    fireEvent.change(screen.getByPlaceholderText('e.g. production'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Create & add/ }));

    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not create label', 'error'));
  });

  it('closes the create modal with Cancel and labels the global option for members', async () => {
    signedInAs(false);
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    fireEvent.click((await screen.findAllByTitle('Add more'))[2]!);
    expect(screen.getByRole('option', { name: 'No workspace' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Create label')).not.toBeInTheDocument());
  });

  it('opens the project and workspace pickers without a create modal', async () => {
    renderWithProviders(<ServiceTagsCard serviceId={4} initial={initial as never} />);

    const addButtons = await screen.findAllByTitle('Add more');
    fireEvent.click(addButtons[0]!); // projects
    expect(screen.queryByText('Create label')).not.toBeInTheDocument();
    fireEvent.click(addButtons[1]!); // workspaces
    expect(screen.queryByText('Create label')).not.toBeInTheDocument();
  });
});
