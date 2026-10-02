import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// r561: the on-screen buffer is the trimmed tail; Download must fetch the
// full log from the server instead of saving that buffer.
const logs = vi.hoisted(() => ({ lines: 'tail of a trimmed log\n', open: true }));
vi.mock('../src/lib/useDeployLogs.js', () => ({ useDeployLogs: () => logs }));

const apiMock = vi.hoisted(() => ({
  authedFetch: vi.fn(),
  api: { deploys: { logDownloadUrl: (s: number, d: number) => `/v1/services/${s}/deploys/${d}/logs/download` } },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const formatMock = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('../src/lib/format.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/format.js')>()),
  downloadBlob: formatMock.downloadBlob,
}));

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/Toast.js')>()),
  useToast: () => toastSpy,
}));

import { LogPanel } from '../src/routes/service/LogPanel.js';

describe('LogPanel download (r561)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads the FULL log from the server endpoint, not the trimmed on-screen buffer', async () => {
    const full = new Blob(['head of the log\n…\ntail of a trimmed log\n']);
    let resolveFetch: (r: Response) => void = () => {};
    apiMock.authedFetch.mockReturnValueOnce(new Promise<Response>((r) => { resolveFetch = r; }));
    render(<LogPanel serviceId={4} deploymentId={9} deployStatus="running" />);

    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    expect(apiMock.authedFetch).toHaveBeenCalledWith('/v1/services/4/deploys/9/logs/download');
    // In flight: disabled and labelled, so a second click cannot double-fire.
    const busy = screen.getByRole('button', { name: /Downloading/ });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(apiMock.authedFetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, blob: async () => full } as Response);
    await waitFor(() => expect(formatMock.downloadBlob).toHaveBeenCalledWith(full, 'deploy-9.log', 'text/plain'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Download$/ })).not.toBeDisabled());
  });

  it('toasts instead of saving a truncated copy when the server refuses', async () => {
    apiMock.authedFetch.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    render(<LogPanel serviceId={4} deploymentId={9} deployStatus="failed" />);
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not download the build log', 'error'));
    expect(formatMock.downloadBlob).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Download$/ })).not.toBeDisabled());
  });
});
