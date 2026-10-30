import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { FileMountsCard } from '../src/routes/service/FileMountsCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.3 Service → Volumes → Files: add, edit, remove (confirmed); refusals; hidden on an older panel. */

vi.mock('../src/lib/api.js', async () => {
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

const PANEL = { type: 'docker' as const, serverId: null };
const NGINX = { id: 4, path: '/etc/nginx/nginx.conf', size: 2048, updatedAt: '2026-10-19T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.services.files.list).mockResolvedValue([NGINX] as never);
});

describe('FileMountsCard', () => {
  it('adds a file at a path with its content', async () => {
    mockOf(api.services.files.put).mockResolvedValue({ ...NGINX, id: 5, path: '/app/config.yaml' } as never);
    renderWithProviders(<FileMountsCard serviceId={3} svc={PANEL} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add file/ }));
    fireEvent.change(screen.getByLabelText('Path in the container'), { target: { value: ' /app/config.yaml ' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'a: 1\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() => expect(api.services.files.put).toHaveBeenCalledWith(3, { path: '/app/config.yaml', content: 'a: 1\n' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('File saved — redeploy to apply', 'success'));
    expect(screen.queryByLabelText('Content')).not.toBeInTheDocument();
  });

  it('checks the path and size before saving, and shows a refusal from the server', async () => {
    mockOf(api.services.files.put).mockRejectedValueOnce(new Error('/data is the service data volume mount')).mockRejectedValueOnce(new Error(''));
    renderWithProviders(<FileMountsCard serviceId={3} svc={PANEL} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add file/ }));
    const save = screen.getByRole('button', { name: 'Save file' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Path in the container'), { target: { value: 'relative.conf' } });
    expect(screen.getByText('must be an absolute path')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Path in the container'), { target: { value: '/etc/hosts' } });
    expect(screen.getByText(/managed by Docker/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Path in the container'), { target: { value: '/data' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'x'.repeat(256 * 1024 + 1) } });
    expect(screen.getByText('At most 256 KiB')).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'x' } });
    fireEvent.click(save);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('/data is the service data volume mount', 'error'));
    fireEvent.click(save);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the file', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Content')).not.toBeInTheDocument();
  });

  it('opens an existing file to edit it in place; its path stays fixed', async () => {
    mockOf(api.services.files.get).mockResolvedValueOnce({ ...NGINX, content: 'events {}' } as never).mockRejectedValueOnce(new Error(''));
    mockOf(api.services.files.put).mockResolvedValue(NGINX as never);
    renderWithProviders(<FileMountsCard serviceId={3} svc={PANEL} />);
    fireEvent.click(await screen.findByRole('button', { name: '/etc/nginx/nginx.conf' }));
    await waitFor(() => expect(screen.getByLabelText('Content')).toHaveValue('events {}'));
    expect(screen.getByLabelText('Path in the container')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'events { worker_connections 64; }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() => expect(api.services.files.put).toHaveBeenCalledWith(3, { path: '/etc/nginx/nginx.conf', content: 'events { worker_connections 64; }' }));
    fireEvent.click(await screen.findByRole('button', { name: '/etc/nginx/nginx.conf' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not open the file', 'error'));
  });

  it('removes a file only after confirming', async () => {
    mockOf(api.services.files.remove).mockResolvedValueOnce({ ok: true } as never).mockRejectedValueOnce(new Error(''));
    renderWithProviders(<FileMountsCard serviceId={3} svc={PANEL} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove /etc/nginx/nginx.conf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.services.files.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove /etc/nginx/nginx.conf' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.services.files.remove).toHaveBeenCalledWith(3, 4));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('File removed — redeploy to apply', 'success'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove /etc/nginx/nginx.conf' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not remove the file', 'error'));
  });

  it('on a node: Add is offered and the agent version is named (0.16.5)', async () => {
    renderWithProviders(<FileMountsCard serviceId={3} svc={{ type: 'docker', serverId: 4 }} />);
    expect(await screen.findByText(/On a node they need agent 0\.16\.5 or newer\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add file/ })).toBeInTheDocument();
    expect(screen.queryByText(/docker services only/)).not.toBeInTheDocument();
  });

  it('on Swarm: Add is offered, and the files are Swarm secrets', async () => {
    renderWithProviders(<FileMountsCard serviceId={3} svc={{ type: 'docker', serverId: null, orchestrator: 'swarm' }} />);
    expect(await screen.findByText(/each file is a Swarm secret/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add file/ })).toBeInTheDocument();
    expect(screen.queryByText(/agent 0\.16\.5/)).not.toBeInTheDocument();
  });

  it('on a compose service: no Add button, and a warning that files block the deploy', async () => {
    const { unmount } = renderWithProviders(<FileMountsCard serviceId={3} svc={{ type: 'compose', serverId: null }} />);
    expect(await screen.findByText(/this service will not deploy until they are removed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add file/ })).not.toBeInTheDocument();
    unmount();
    mockOf(api.services.files.list).mockResolvedValue([] as never);
    renderWithProviders(<FileMountsCard serviceId={3} svc={{ type: 'compose', serverId: null }} />);
    expect(await screen.findByText('No files.')).toBeInTheDocument();
    expect(screen.getByText(/docker services only\.$/)).toBeInTheDocument();
  });

  it('stops offering Add at 20 files, and hides itself when the read fails (older panel)', async () => {
    mockOf(api.services.files.list).mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ ...NGINX, id: i + 1, path: `/app/f${i}` })) as never);
    const { unmount } = renderWithProviders(<FileMountsCard serviceId={3} svc={PANEL} />);
    expect(await screen.findByRole('button', { name: '/app/f0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add file/ })).not.toBeInTheDocument();
    unmount();
    mockOf(api.services.files.list).mockRejectedValue(new Error('404'));
    renderWithProviders(<FileMountsCard serviceId={3} svc={PANEL} />);
    await waitFor(() => expect(api.services.files.list).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Files')).not.toBeInTheDocument();
  });
});
