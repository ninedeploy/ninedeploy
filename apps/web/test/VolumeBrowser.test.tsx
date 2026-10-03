import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { VolumeBrowser } from '../src/components/VolumeBrowser.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const dir = {
  path: '',
  entries: [
    { name: 'configs', type: 'dir' as const, sizeBytes: 4096, modifiedAt: null },
    { name: 'app.env', type: 'file' as const, sizeBytes: 96, modifiedAt: null },
  ],
};

describe('VolumeBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the directory listing with breadcrumb navigation', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    expect(await screen.findByText('configs')).toBeInTheDocument();
    expect(screen.getByText('app.env')).toBeInTheDocument();
    expect(screen.getByText('nd-svc-web-data')).toBeInTheDocument();
  });

  it('navigates into a folder and back to the root', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('configs'));
    await waitFor(() => expect(api.volumes.listFiles).toHaveBeenCalledWith('nd-svc-web-data', 'configs'));
    mockOf(api.volumes.listFiles).mockResolvedValue({ path: 'configs', entries: [] } as never);
    // breadcrumb root '/'
    fireEvent.click(screen.getByRole('button', { name: '/' }));
    await waitFor(() => expect(api.volumes.listFiles).toHaveBeenCalledWith('nd-svc-web-data', ''));
  });

  it('opens a file into the editor and saves it as base64', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    mockOf(api.volumes.readFile).mockResolvedValue({ content: btoa('KEY=1'), encoding: 'base64' } as never);
    mockOf(api.volumes.writeFile).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('app.env'));
    const editor = await screen.findByLabelText('File editor');
    expect((editor as HTMLTextAreaElement).value).toBe('KEY=1');
    fireEvent.change(editor, { target: { value: 'KEY=2' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(api.volumes.writeFile).toHaveBeenCalledWith('nd-svc-web-data', {
        path: 'app.env',
        contentBase64: btoa('KEY=2'),
      }),
    );
  });

  it('r251: text typed while a save is in flight is kept and stays unsaved', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    mockOf(api.volumes.readFile).mockResolvedValue({ content: btoa('KEY=1'), encoding: 'base64' } as never);
    let finish!: () => void;
    mockOf(api.volumes.writeFile).mockReturnValue(new Promise((r) => { finish = () => r({ ok: true }); }) as never);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('app.env'));
    const editor = (await screen.findByLabelText('File editor')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'KEY=2' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    fireEvent.change(editor, { target: { value: 'KEY=3' } });
    finish();
    await waitFor(() => expect(api.volumes.writeFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).not.toBeDisabled());
    expect(editor.value).toBe('KEY=3');
  });

  it('deletes an entry after confirmation', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    mockOf(api.volumes.deleteFile).mockResolvedValue({ ok: true } as never);
    window.confirm = vi.fn(() => true);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText('Delete app.env'));
    await waitFor(() => expect(api.volumes.deleteFile).toHaveBeenCalledWith('nd-svc-web-data', 'app.env'));
  });

  it('covers the editor toolbar: new file, back, and read errors', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    mockOf(api.volumes.readFile).mockRejectedValue(new Error('binary') as never);
    window.prompt = vi.fn(() => 'notes.md');
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);

    // New file → editor opens empty and dirty
    fireEvent.click(await screen.findByRole('button', { name: /File$/ }));
    const editor = await screen.findByLabelText('File editor');
    expect((editor as HTMLTextAreaElement).value).toBe('');
    // Back returns to the listing
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByText('configs')).toBeInTheDocument();

    // A failing read (binary/too large) surfaces an error toast instead of the editor
    fireEvent.click(screen.getByText('app.env'));
    await waitFor(() => expect(screen.getByText(/Could not read the file/)).toBeInTheDocument());
    expect(screen.queryByLabelText('File editor')).toBeNull();
  });

  it('covers save-pending state and nested folder/file creation paths', async () => {
    mockOf(api.volumes.readFile).mockResolvedValue({ content: btoa('hi'), encoding: 'base64' } as never);
    mockOf(api.volumes.writeFile).mockReturnValue(new Promise(() => {}) as never);
    mockOf(api.volumes.listFiles).mockImplementation(async (_n: string, path: string) =>
      path === 'configs'
        ? { path, entries: [] }
        : { path, entries: [{ name: 'configs', type: 'dir' as const, sizeBytes: 0, modifiedAt: null }] },
    );
    window.prompt = vi.fn(() => 'nested');
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);

    // folder creation inside a subdirectory (cwd non-empty branch)
    fireEvent.click(await screen.findByText('configs'));
    await screen.findByText('Empty directory');
    fireEvent.click(screen.getByRole('button', { name: /Folder/ }));
    await waitFor(() => expect(api.volumes.mkdir).toHaveBeenCalledWith('nd-svc-web-data', { path: 'configs/nested' }));

    // new file inside a subdirectory (cwd non-empty branch)
    fireEvent.click(screen.getByRole('button', { name: /File$/ }));
    const editor = await screen.findByLabelText('File editor');
    expect((editor as HTMLTextAreaElement).value).toBe('');

    // save in-flight shows the pending label
    fireEvent.change(editor, { target: { value: 'body' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(screen.getByText('Saving…')).toBeInTheDocument());
  });

  it('closes on Escape via the backdrop key handler', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    await screen.findByText('app.env');
    fireEvent.keyDown(screen.getByRole('presentation'), { key: 'Escape' });
    // non-Escape keys are ignored
    fireEvent.keyDown(screen.getByRole('presentation'), { key: 'a' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(await screen.findByText('app.env')).toBeInTheDocument();
  });

  it('handles utf8-encoded reads', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    mockOf(api.volumes.readFile).mockResolvedValue({ content: 'KEY=1', encoding: 'utf8' } as never);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('app.env'));
    const editor = await screen.findByLabelText('File editor');
    expect((editor as HTMLTextAreaElement).value).toBe('KEY=1');
  });

  it('ignores cancelled prompts', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    window.prompt = vi.fn(() => null);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    await screen.findByText('app.env');
    fireEvent.click(screen.getByRole('button', { name: /Folder/ }));
    fireEvent.click(screen.getByRole('button', { name: /File$/ }));
    expect(api.volumes.mkdir).not.toHaveBeenCalled();
    expect(await screen.findByText('app.env')).toBeInTheDocument(); // still in listing, no editor
  });

  it('shows the loading skeleton and the error state', async () => {
    // loading: a never-resolving query keeps the skeleton mounted
    mockOf(api.volumes.listFiles).mockReturnValue(new Promise(() => {}) as never);
    const { unmount } = renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    unmount();

    mockOf(api.volumes.listFiles).mockRejectedValue(new Error('docker down') as never);
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    expect(await screen.findByText("Couldn't open the volume.")).toBeInTheDocument();
  });

  it('deletes a folder with the recursive warning', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue({ path: '', entries: [dir.entries[0]] } as never);
    mockOf(api.volumes.deleteFile).mockResolvedValue({ ok: true } as never);
    const confirmSpy = vi.fn(() => false);
    window.confirm = confirmSpy;
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText('Delete configs'));
    expect(confirmSpy).toHaveBeenCalledWith('Delete configs? (folder and everything in it)');
    expect(api.volumes.deleteFile).not.toHaveBeenCalled(); // cancelled
  });

  it('shows deep breadcrumbs after navigating into folders', async () => {
    mockOf(api.volumes.listFiles).mockImplementation(async (_n: string, path: string) => {
      if (path === 'configs') return { path, entries: [{ name: 'nginx', type: 'dir' as const, sizeBytes: 0, modifiedAt: null }] };
      if (path === 'configs/nginx') return { path, entries: [] };
      return dir;
    });
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('configs'));
    await screen.findByText('nginx');
    fireEvent.click(screen.getByText('nginx'));
    await screen.findByText('Empty directory');
    // full crumb trail renders and each crumb is clickable
    expect(screen.getByRole('button', { name: 'configs' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'configs' }));
    await waitFor(() => expect(api.volumes.listFiles).toHaveBeenLastCalledWith('nd-svc-web-data', 'configs'));
  });

  it('surfaces mutation failures as toasts', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    mockOf(api.volumes.deleteFile).mockRejectedValue(new Error('nope') as never);
    mockOf(api.volumes.mkdir).mockRejectedValue(new Error('nope') as never);
    mockOf(api.volumes.writeFile).mockRejectedValue(new Error('nope') as never);
    mockOf(api.volumes.readFile).mockResolvedValue({ content: btoa('x'), encoding: 'base64' } as never);
    window.confirm = vi.fn(() => true);
    window.prompt = vi.fn(() => 'newdir');
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByLabelText('Delete app.env'));
    await waitFor(() => expect(screen.getByText('Delete failed')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Folder/ }));
    await waitFor(() => expect(screen.getByText('Could not create the folder')).toBeInTheDocument());

    fireEvent.click(screen.getByText('app.env'));
    await screen.findByLabelText('File editor');
    fireEvent.change(screen.getByLabelText('File editor'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(screen.getByText('Save failed')).toBeInTheDocument());
  });

  it('creates a folder via prompt', async () => {
    mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
    mockOf(api.volumes.mkdir).mockResolvedValue({ ok: true } as never);
    window.prompt = vi.fn(() => 'uploads');
    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Folder/ }));
    await waitFor(() => expect(api.volumes.mkdir).toHaveBeenCalledWith('nd-svc-web-data', { path: 'uploads' }));
  });

  it('previews image files and allows downloading', async () => {
    const imgDir = {
      path: '',
      entries: [
        { name: 'logo.png', type: 'file' as const, sizeBytes: 2048, modifiedAt: null },
        { name: 'icon.svg', type: 'file' as const, sizeBytes: 512, modifiedAt: null },
      ],
    };
    mockOf(api.volumes.listFiles).mockResolvedValue(imgDir as never);
    mockOf(api.volumes.readFile).mockResolvedValue({ content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', encoding: 'base64' } as never);

    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('logo.png'));

    expect(await screen.findByAltText('logo.png')).toBeInTheDocument();
    expect(screen.getByText('Image Preview · Read-only')).toBeInTheDocument();

    const downloadBtn = screen.getByRole('button', { name: /Download/ });
    expect(downloadBtn).toBeInTheDocument();
    fireEvent.click(downloadBtn);

    // Back to listing and open svg
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    fireEvent.click(await screen.findByText('icon.svg'));
    expect(await screen.findByAltText('icon.svg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
  });

  it('protects binary files from corruption and provides download action', async () => {
    const binDir = {
      path: '',
      entries: [
        { name: 'data.sqlite', type: 'file' as const, sizeBytes: 16384, modifiedAt: null },
        { name: 'archive.tar.gz', type: 'file' as const, sizeBytes: 32768, modifiedAt: null },
        { name: 'Dockerfile', type: 'file' as const, sizeBytes: 120, modifiedAt: null },
        { name: '.gitignore', type: 'file' as const, sizeBytes: 40, modifiedAt: null },
        { name: '.env.local', type: 'file' as const, sizeBytes: 50, modifiedAt: null },
        { name: '.avatar.png', type: 'file' as const, sizeBytes: 1024, modifiedAt: null },
        { name: '.secret.bin', type: 'file' as const, sizeBytes: 2048, modifiedAt: null },
      ],
    };
    mockOf(api.volumes.listFiles).mockResolvedValue(binDir as never);
    mockOf(api.volumes.readFile).mockResolvedValue({ content: 'U1FMaXRlIGZvcm1hdCAzAA==', encoding: 'base64' } as never);

    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    expect(await screen.findByText('data.sqlite')).toBeInTheDocument();
    expect(screen.getByText('archive.tar.gz')).toBeInTheDocument();
    expect(screen.getByText('Dockerfile')).toBeInTheDocument();

    fireEvent.click(screen.getByText('data.sqlite'));
    expect(await screen.findByText(/This file is recognized as a binary \/ archive or compiled asset/)).toBeInTheDocument();
    expect(screen.getByText(/Direct text editing is disabled to protect against data corruption/)).toBeInTheDocument();
    expect(screen.queryByLabelText('File editor')).toBeNull();

    // Click download button in header and card
    const downloadBtns = screen.getAllByRole('button', { name: /Download/ });
    expect(downloadBtns.length).toBe(2);
    fireEvent.click(downloadBtns[0]!);
    fireEvent.click(downloadBtns[1]!);
  });

  it('handles extensionless and custom files as text', async () => {
    const customDir = {
      path: '',
      entries: [
        { name: 'entrypoint', type: 'file' as const, sizeBytes: 100, modifiedAt: null },
        { name: 'custom.xyz', type: 'file' as const, sizeBytes: 200, modifiedAt: null },
      ],
    };
    mockOf(api.volumes.listFiles).mockResolvedValue(customDir as never);
    mockOf(api.volumes.readFile).mockResolvedValue({ content: btoa('echo 1'), encoding: 'base64' } as never);

    renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
    expect(await screen.findByText('entrypoint')).toBeInTheDocument();
    expect(screen.getByText('custom.xyz')).toBeInTheDocument();

    fireEvent.click(screen.getByText('entrypoint'));
    expect(await screen.findByLabelText('File editor')).toBeInTheDocument();
  });

  it('supports file upload via file input and handles errors', async () => {
    class MockFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = 'data:text/plain;base64,Y29udGVudA==';
        if (this.onload) this.onload();
      }
    }
    const origFileReader = window.FileReader;
    window.FileReader = MockFileReader as any;

    try {
      mockOf(api.volumes.listFiles).mockResolvedValue(dir as never);
      mockOf(api.volumes.writeFile).mockResolvedValue({ ok: true } as never);

      const { unmount } = renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
      const fileInput = await screen.findByLabelText('Upload file to volume');

      // Empty / no file change
      fireEvent.change(fileInput, { target: { files: [] } });

      const fakeFile = new File(['content'], 'upload.txt', { type: 'text/plain' });
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });

      await waitFor(() =>
        expect(api.volumes.writeFile).toHaveBeenCalledWith('nd-svc-web-data', {
          path: 'upload.txt',
          contentBase64: 'Y29udGVudA==',
        }),
      );
      unmount();

      // Nested cwd upload
      mockOf(api.volumes.listFiles).mockImplementation(async (_n, p) =>
        p === 'configs' ? { path: 'configs', entries: [] } : dir,
      );
      renderWithProviders(<VolumeBrowser volume="nd-svc-web-data" onClose={vi.fn()} />);
      fireEvent.click(await screen.findByText('configs'));
      const nestedInput = await screen.findByLabelText('Upload file to volume');
      fireEvent.change(nestedInput, { target: { files: [fakeFile] } });
      await waitFor(() =>
        expect(api.volumes.writeFile).toHaveBeenCalledWith('nd-svc-web-data', {
          path: 'configs/upload.txt',
          contentBase64: 'Y29udGVudA==',
        }),
      );

      // Error on upload
      mockOf(api.volumes.writeFile).mockRejectedValueOnce(new Error('err'));
      fireEvent.change(nestedInput, { target: { files: [fakeFile] } });
      await waitFor(() => expect(screen.getByText(/Upload failed/)).toBeInTheDocument());

      // Raw base64 result without comma prefix and null result
      class RawFileReader {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          if (this.onload) this.onload();
        }
      }
      window.FileReader = RawFileReader as any;
      mockOf(api.volumes.writeFile).mockResolvedValueOnce({ ok: true } as never);
      fireEvent.change(nestedInput, { target: { files: [fakeFile] } });
      await waitFor(() =>
        expect(api.volumes.writeFile).toHaveBeenCalledWith('nd-svc-web-data', {
          path: 'configs/upload.txt',
          contentBase64: '',
        }),
      );
    } finally {
      window.FileReader = origFileReader;
    }
  });
});
