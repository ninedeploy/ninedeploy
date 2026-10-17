import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import { NewResource } from '../src/routes/NewResource.js';
import { UploadSourceCard, archiveProblem } from '../src/components/UploadSource.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.1 deploy from an uploaded archive: the New resource entry and the Deploys-tab card. */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});
vi.mock('../src/components/DeployWizard.js', () => ({ DeployWizard: () => <div data-testid="deploy-wizard" /> }));

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const zipFile = (name = 'app.zip', bytes = [0x50, 0x4b, 3, 4]) => new File([new Uint8Array(bytes)], name, { type: 'application/zip' });

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(useAuth).mockReturnValue({ user: { id: 1, email: 'a@test', isOperator: false }, loading: false } as never);
  mockOf(api.templates.list).mockResolvedValue([]);
  mockOf(api.sources.list).mockResolvedValue([]);
  mockOf(api.services.sourceUploads).mockResolvedValue({ uploadSourced: true, maxBytes: 104857600, uploads: [] });
});

describe('archiveProblem', () => {
  it('accepts .zip, .tar.gz and .tgz within the limit, and names the problem otherwise', () => {
    expect(archiveProblem({ name: 'a.zip', size: 10 })).toBeNull();
    expect(archiveProblem({ name: 'a.TAR.GZ', size: 10 })).toBeNull();
    expect(archiveProblem({ name: 'a.tgz', size: 10 })).toBeNull();
    expect(archiveProblem({ name: 'a.rar', size: 10 })).toMatch(/\.zip or a \.tar\.gz/);
    expect(archiveProblem({ name: 'a.zip', size: 101 * 1024 * 1024 })).toMatch(/limit is 100 MiB/);
    expect(archiveProblem({ name: 'a.zip', size: 0 })).toMatch(/empty/);
  });
});

describe('New resource → Upload source', () => {
  function open() {
    renderWithProviders(
      <>
        <NewResource />
        <LocationProbe />
      </>,
      { route: '/new' },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Upload source' }));
  }

  it('creates a docker service, uploads the archive to it and opens the service', async () => {
    mockOf(api.services.create).mockResolvedValue({ id: 31, name: 'drop', slug: 'drop' } as never);
    mockOf(api.services.uploadSource).mockResolvedValue({ sha: 'a'.repeat(40), entries: 2, deploymentId: 5 } as never);
    open();
    fireEvent.change(screen.getByPlaceholderText('my-app'), { target: { value: 'drop' } });
    fireEvent.change(screen.getByLabelText('Archive'), { target: { files: [zipFile()] } });
    fireEvent.change(screen.getByPlaceholderText('3000'), { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: /Create and deploy/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/services/31'));
    expect(api.services.create).toHaveBeenCalledWith({ name: 'drop', type: 'docker', port: 8080 });
    expect(mockOf(api.services.uploadSource).mock.calls[0]![0]).toBe(31);
    expect(Array.from(mockOf(api.services.uploadSource).mock.calls[0]![1] as Uint8Array)).toEqual([0x50, 0x4b, 3, 4]);
    expect(toastSpy.toast).toHaveBeenCalledWith('drop created — deploying your upload', 'success');
  });

  it('a refused upload still leads to the service it created, saying so', async () => {
    mockOf(api.services.create).mockResolvedValue({ id: 32, name: 'drop', slug: 'drop' } as never);
    mockOf(api.services.uploadSource).mockRejectedValue(new Error('Unsafe path in the archive: "../x"'));
    open();
    fireEvent.change(screen.getByPlaceholderText('my-app'), { target: { value: 'drop' } });
    fireEvent.change(screen.getByLabelText('Archive'), { target: { files: [zipFile()] } });
    fireEvent.click(screen.getByRole('button', { name: /Create and deploy/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/services/32'));
    expect(toastSpy.toast).toHaveBeenCalledWith('Service created, but the upload failed: Unsafe path in the archive: "../x"', 'error');
  });

  it('a refused create says why and stays put', async () => {
    mockOf(api.services.create).mockRejectedValue(new Error('slug_taken'));
    open();
    fireEvent.change(screen.getByPlaceholderText('my-app'), { target: { value: 'drop' } });
    fireEvent.change(screen.getByLabelText('Archive'), { target: { files: [zipFile()] } });
    fireEvent.click(screen.getByRole('button', { name: /Create and deploy/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('slug_taken', 'error'));
    expect(screen.getByTestId('location')).toHaveTextContent('/new');
    expect(api.services.uploadSource).not.toHaveBeenCalled();
  });

  it('will not submit a wrong file type or a bad port, and Cancel closes it', async () => {
    open();
    fireEvent.change(screen.getByPlaceholderText('my-app'), { target: { value: 'drop' } });
    fireEvent.change(screen.getByLabelText('Archive'), { target: { files: [zipFile('app.rar')] } });
    expect(screen.getByText('Pick a .zip or a .tar.gz archive.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create and deploy/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Archive'), { target: { files: [zipFile()] } });
    fireEvent.change(screen.getByPlaceholderText('3000'), { target: { value: '99999' } });
    expect(screen.getByText('Not a port number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create and deploy/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Archive')).not.toBeInTheDocument());
    expect(api.services.create).not.toHaveBeenCalled();
  });
});

describe('Deploys tab: Uploaded source card', () => {
  it('lists the kept uploads, newest marked, and uploads a new version', async () => {
    mockOf(api.services.sourceUploads).mockResolvedValue({
      uploadSourced: true,
      maxBytes: 104857600,
      uploads: [
        { sha: 'b'.repeat(40), format: 'zip', bytes: 2 * 1024 * 1024, uploadedAt: new Date().toISOString() },
        { sha: 'c'.repeat(40), format: 'tar.gz', bytes: 1024 * 1024, uploadedAt: new Date(Date.now() - 86_400_000).toISOString() },
      ],
    });
    mockOf(api.services.uploadSource).mockResolvedValue({ sha: 'd'.repeat(40), entries: 4, deploymentId: 9 } as never);
    renderWithProviders(<UploadSourceCard serviceId={6} />);
    expect(await screen.findByText('bbbbbbb')).toBeInTheDocument();
    expect(screen.getByText('latest')).toBeInTheDocument();
    expect(screen.getByText('2.0 MiB')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Upload new version'), { target: { files: [zipFile()] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Uploaded ddddddd — deployment #9 queued', 'success'));
    expect(mockOf(api.services.uploadSource).mock.calls[0]![0]).toBe(6);
  });

  it('says nothing is uploaded yet, refuses a wrong file locally and shows a server refusal', async () => {
    renderWithProviders(<UploadSourceCard serviceId={6} />);
    expect(await screen.findByText(/Nothing uploaded yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Upload new version'), { target: { files: [zipFile('notes.txt')] } });
    expect(screen.getByText('Pick a .zip or a .tar.gz archive.')).toBeInTheDocument();
    expect(api.services.uploadSource).not.toHaveBeenCalled();

    mockOf(api.services.uploadSource).mockRejectedValue(new Error('Encrypted zip archives are not supported.'));
    fireEvent.change(screen.getByLabelText('Upload new version'), { target: { files: [zipFile()] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Encrypted zip archives are not supported.', 'error'));
  });

  it('a stored-only upload says so', async () => {
    mockOf(api.services.uploadSource).mockResolvedValue({ sha: 'e'.repeat(40), entries: 1, deploymentId: null } as never);
    renderWithProviders(<UploadSourceCard serviceId={6} />);
    await screen.findByText(/Nothing uploaded yet/);
    fireEvent.change(screen.getByLabelText('Upload new version'), { target: { files: [zipFile()] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Uploaded eeeeeee', 'success'));
  });
});
