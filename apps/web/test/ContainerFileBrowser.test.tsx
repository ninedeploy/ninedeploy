import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContainerFileBrowser } from '../src/components/ContainerFileBrowser.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

const mockFiles = {
  path: '/',
  entries: [
    { name: 'app', type: 'dir' as const, sizeBytes: 4096, mode: '0755', modifiedAt: null },
    { name: 'package.json', type: 'file' as const, sizeBytes: 512, mode: '0644', modifiedAt: null },
    { name: 'logo.svg', type: 'file' as const, sizeBytes: 1024, mode: '0644', modifiedAt: null },
    { name: 'archive.tar.gz', type: 'file' as const, sizeBytes: 2048, mode: '0644', modifiedAt: null },
  ],
};

describe('ContainerFileBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy.toast.mockClear();
    mockOf(api.containers.listFiles).mockResolvedValue(mockFiles as never);
  });

  it('renders directory contents and container header', async () => {
    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(screen.getByText('nd-svc-api-1')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
    expect(screen.getByText('logo.svg')).toBeInTheDocument();
    expect(screen.getByText('archive.tar.gz')).toBeInTheDocument();
  });

  it('filters files by search query', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    await screen.findByText('package.json');

    const searchInput = screen.getByPlaceholderText('Filter files…');
    await user.type(searchInput, 'package');
    expect(screen.getByText('package.json')).toBeInTheDocument();
    expect(screen.queryByText('logo.svg')).toBeNull();

    await user.clear(searchInput);
    await user.type(searchInput, 'nonexistent');
    expect(screen.getByText('No matching files found')).toBeInTheDocument();
  });

  it('navigates into directories and breadcrumbs', async () => {
    mockOf(api.containers.listFiles).mockImplementation(async (_c, path) =>
      path === '/app'
        ? {
            path: '/app',
            entries: [{ name: 'index.js', type: 'file' as const, sizeBytes: 256, mode: '0644', modifiedAt: null }],
          }
        : mockFiles,
    );

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    const appDir = await screen.findByText('app');
    fireEvent.click(appDir);

    expect(await screen.findByText('index.js')).toBeInTheDocument();
    expect(api.containers.listFiles).toHaveBeenCalledWith('nd-svc-api-1', '/app');

    // Click root '/' in breadcrumbs
    const rootBtn = screen.getByRole('button', { name: '/' });
    fireEvent.click(rootBtn);
    expect(await screen.findByText('package.json')).toBeInTheDocument();
    expect(api.containers.listFiles).toHaveBeenCalledWith('nd-svc-api-1', '/');
  });

  it('opens and edits a text file with save', async () => {
    const user = userEvent.setup();
    mockOf(api.containers.readFile).mockResolvedValue({
      content: btoa('{"name": "app"}'),
      encoding: 'base64',
    } as never);
    mockOf(api.containers.writeFile).mockResolvedValue({ ok: true } as never);

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    const pkgFile = await screen.findByText('package.json');
    fireEvent.click(pkgFile);

    const editor = await screen.findByLabelText('Container file editor');
    expect((editor as HTMLTextAreaElement).value).toBe('{"name": "app"}');

    // Not dirty yet -> 'Saved'
    expect(screen.getByRole('button', { name: /Saved/ })).toBeDisabled();

    let resolveWrite: (val: unknown) => void = () => {};
    mockOf(api.containers.writeFile).mockImplementation(() => new Promise((res) => { resolveWrite = res; }));

    fireEvent.change(editor, { target: { value: '{"name": "app-v2"}' } });
    const saveBtn = screen.getByRole('button', { name: /Save/ });
    await user.click(saveBtn);

    expect(await screen.findByRole('button', { name: /Saving…/ })).toBeInTheDocument();
    resolveWrite({ ok: true });

    await waitFor(() =>
      expect(api.containers.writeFile).toHaveBeenCalledWith('nd-svc-api-1', {
        path: '/package.json',
        contentBase64: btoa('{"name": "app-v2"}'),
      }),
    );
    expect(toastSpy.toast).toHaveBeenCalledWith('File saved', 'success');

    // Click Back
    const backBtn = screen.getByRole('button', { name: /Back/ });
    fireEvent.click(backBtn);
    expect(await screen.findByText('package.json')).toBeInTheDocument();
  });

  it('creates a new file via prompt', async () => {
    window.prompt = vi.fn(() => 'server.js');
    const { unmount } = renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    const newFileBtn = await screen.findByRole('button', { name: /File$/ });
    fireEvent.click(newFileBtn);

    expect(await screen.findByLabelText('Container file editor')).toBeInTheDocument();
    expect(screen.getByText('/server.js')).toBeInTheDocument();
    unmount();

    // Nested file creation in /app
    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" initialPath="/app" />);
    const nestedFileBtn = await screen.findByRole('button', { name: /File$/ });
    fireEvent.click(nestedFileBtn);
    expect(screen.getByText('/app/server.js')).toBeInTheDocument();
  });

  it('creates a new folder via prompt', async () => {
    window.prompt = vi.fn(() => 'logs');
    mockOf(api.containers.mkdir).mockResolvedValue({ ok: true } as never);

    const { unmount } = renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    const newFolderBtn = await screen.findByRole('button', { name: /Folder/ });
    fireEvent.click(newFolderBtn);

    await waitFor(() =>
      expect(api.containers.mkdir).toHaveBeenCalledWith('nd-svc-api-1', { path: '/logs' }),
    );
    expect(toastSpy.toast).toHaveBeenCalledWith('Folder created', 'success');
    unmount();

    // Nested folder creation in /app
    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" initialPath="/app" />);
    const nestedFolderBtn = await screen.findByRole('button', { name: /Folder/ });
    fireEvent.click(nestedFolderBtn);
    await waitFor(() =>
      expect(api.containers.mkdir).toHaveBeenCalledWith('nd-svc-api-1', { path: '/app/logs' }),
    );
  });

  it('opens an image file preview and downloads', async () => {
    mockOf(api.containers.readFile).mockResolvedValue({
      content: btoa('<svg></svg>'),
      encoding: 'base64',
    } as never);

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    const imgFile = await screen.findByText('logo.svg');
    fireEvent.click(imgFile);

    expect(await screen.findByText('Image Preview · Read-only')).toBeInTheDocument();
    const downloadBtn = screen.getByRole('button', { name: /Download/ });
    fireEvent.click(downloadBtn);

    // Back to listing and test PNG preview
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    mockOf(api.containers.listFiles).mockResolvedValueOnce({
      path: '/',
      entries: [{ name: 'avatar.png', type: 'file' as const, sizeBytes: 1024, mode: '0644', modifiedAt: null }],
    } as never);
    mockOf(api.containers.readFile).mockResolvedValueOnce({
      content: btoa('png-bytes'),
      encoding: 'base64',
    } as never);
    fireEvent.click(screen.getByTitle('Refresh directory'));
    const pngFile = await screen.findByText('avatar.png');
    fireEvent.click(pngFile);
    expect(await screen.findByAltText('avatar.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
  });

  it('reads a text file returning utf8 encoding', async () => {
    mockOf(api.containers.readFile).mockResolvedValueOnce({
      content: 'plain text content',
      encoding: 'utf8' as any,
    } as never);

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    fireEvent.click(await screen.findByText('package.json'));
    const editor = await screen.findByLabelText('Container file editor');
    expect((editor as HTMLTextAreaElement).value).toBe('plain text content');
  });

  it('opens a binary file and allows downloading raw data', async () => {
    mockOf(api.containers.readFile).mockResolvedValue({
      content: btoa('binary-data'),
      encoding: 'base64',
    } as never);

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    const binFile = await screen.findByText('archive.tar.gz');
    fireEvent.click(binFile);

    expect(await screen.findByText(/Direct text editing is disabled/)).toBeInTheDocument();
    const downloadBtn = screen.getByRole('button', { name: /Download File/ });
    fireEvent.click(downloadBtn);
  });

  it('deletes a file and a folder after confirmation or cancels', async () => {
    window.confirm = vi.fn(() => true);
    mockOf(api.containers.deleteFile).mockResolvedValue(undefined as never);

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    const delFileBtn = await screen.findByLabelText('Delete package.json');
    fireEvent.click(delFileBtn);

    await waitFor(() =>
      expect(api.containers.deleteFile).toHaveBeenCalledWith('nd-svc-api-1', '/package.json'),
    );
    expect(toastSpy.toast).toHaveBeenCalledWith('Deleted package.json', 'success');

    // Delete folder
    const delFolderBtn = screen.getByLabelText('Delete app');
    fireEvent.click(delFolderBtn);
    await waitFor(() =>
      expect(api.containers.deleteFile).toHaveBeenCalledWith('nd-svc-api-1', '/app'),
    );

    // Cancel deletion
    window.confirm = vi.fn(() => false);
    fireEvent.click(delFileBtn);
    expect(api.containers.deleteFile).toHaveBeenCalledTimes(2);
  });

  it('supports file upload via file input and drag and drop with error handling', async () => {
    class MockFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = 'data:text/plain;base64,aGVsbG8=';
        if (this.onload) this.onload();
      }
    }
    const origFileReader = window.FileReader;
    window.FileReader = MockFileReader as any;

    try {
      mockOf(api.containers.writeFile).mockResolvedValue({ ok: true } as never);

      const { unmount } = renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
      const fileInput = await screen.findByLabelText('Upload file to container');

      // Empty / no file change
      fireEvent.change(fileInput, { target: { files: [] } });

      const fakeFile = new File(['hello'], 'hello.txt', { type: 'text/plain' });
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });

      await waitFor(() =>
        expect(api.containers.writeFile).toHaveBeenCalledWith('nd-svc-api-1', {
          path: '/hello.txt',
          contentBase64: 'aGVsbG8=',
        }),
      );

      // Drag and drop upload in root
      const dropZone = screen.getByTestId('container-dropzone');
      fireEvent.dragOver(dropZone);
      fireEvent.dragLeave(dropZone);
      fireEvent.drop(dropZone, { dataTransfer: { files: [] } });
      fireEvent.drop(dropZone, { dataTransfer: { files: [fakeFile] } });

      await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Uploaded hello.txt', 'success'));
      unmount();

      // Upload in nested cwd e.g. /app
      mockOf(api.containers.listFiles).mockResolvedValue({ path: '/app', entries: [] } as never);
      renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" initialPath="/app" />);
      const nestedInput = await screen.findByLabelText('Upload file to container');
      fireEvent.change(nestedInput, { target: { files: [fakeFile] } });
      await waitFor(() =>
        expect(api.containers.writeFile).toHaveBeenCalledWith('nd-svc-api-1', {
          path: '/app/hello.txt',
          contentBase64: 'aGVsbG8=',
        }),
      );

      // Upload error handling
      mockOf(api.containers.writeFile).mockRejectedValueOnce(new Error('upload failed'));
      fireEvent.change(nestedInput, { target: { files: [fakeFile] } });
      await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Upload failed', 'error'));

      // Raw base64 result without comma and null reader result
      class RawFileReader {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          if (this.onload) this.onload();
        }
      }
      window.FileReader = RawFileReader as any;
      mockOf(api.containers.writeFile).mockResolvedValueOnce({ ok: true } as never);
      fireEvent.change(nestedInput, { target: { files: [fakeFile] } });
      await waitFor(() =>
        expect(api.containers.writeFile).toHaveBeenCalledWith('nd-svc-api-1', {
          path: '/app/hello.txt',
          contentBase64: '',
        }),
      );
    } finally {
      window.FileReader = origFileReader;
    }
  });

  it('handles multi-level breadcrumb clicks and prompt cancellation', async () => {
    mockOf(api.containers.listFiles).mockImplementation(async (_c, path) => ({
      path,
      entries: [{ name: 'server.ts', type: 'file', sizeBytes: 100, mode: '0644', modifiedAt: null }],
    }));

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" initialPath="app/src" />);
    expect(await screen.findByText('server.ts')).toBeInTheDocument();

    // Click intermediate breadcrumb 'app'
    const appCrumb = screen.getByRole('button', { name: 'app' });
    fireEvent.click(appCrumb);
    await waitFor(() => expect(api.containers.listFiles).toHaveBeenCalledWith('nd-svc-api-1', '/app'));

    // Cancel prompt for folder creation
    window.prompt = vi.fn(() => null);
    fireEvent.click(screen.getByRole('button', { name: /Folder/ }));
    expect(api.containers.mkdir).not.toHaveBeenCalled();

    // Cancel prompt for file creation
    fireEvent.click(screen.getByRole('button', { name: /File$/ }));
    expect(screen.queryByLabelText('Container file editor')).toBeNull();
  });

  it('handles errors on read, write, mkdir, and delete gracefully', async () => {
    const user = userEvent.setup();
    mockOf(api.containers.readFile).mockResolvedValueOnce({ content: btoa('test'), encoding: 'base64' } as never);
    mockOf(api.containers.writeFile).mockRejectedValueOnce(new Error('err'));
    mockOf(api.containers.mkdir).mockRejectedValueOnce(new Error('err'));
    mockOf(api.containers.deleteFile).mockRejectedValueOnce(new Error('err'));
    window.confirm = vi.fn(() => true);
    window.prompt = vi.fn(() => 'new-folder');

    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);

    // Save error
    const pkgFile = await screen.findByText('package.json');
    fireEvent.click(pkgFile);
    const editor = await screen.findByLabelText('Container file editor');
    fireEvent.change(editor, { target: { value: 'modified' } });
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Save failed', 'error'));

    // Back to listing
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByText('package.json')).toBeInTheDocument();

    // Read error
    mockOf(api.containers.readFile).mockRejectedValueOnce(new Error('err'));
    fireEvent.click(screen.getByText('package.json'));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Could not read file (binary or >1 MB)', 'error'),
    );

    // Mkdir error
    fireEvent.click(screen.getByRole('button', { name: /Folder/ }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Could not create folder', 'error'),
    );

    // Delete error
    fireEvent.click(screen.getByLabelText('Delete package.json'));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Delete failed', 'error'),
    );
  });

  it('renders empty and error states', async () => {
    mockOf(api.containers.listFiles).mockResolvedValueOnce({ path: '/', entries: [] } as never);
    const { unmount } = renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    expect(await screen.findByText(/Empty directory/)).toBeInTheDocument();
    unmount();

    mockOf(api.containers.listFiles).mockRejectedValueOnce(new Error('unreachable'));
    renderWithProviders(<ContainerFileBrowser container="nd-svc-api-1" />);
    expect(
      await screen.findByText(/Container is not running or file system is inaccessible/),
    ).toBeInTheDocument();
  });
});
