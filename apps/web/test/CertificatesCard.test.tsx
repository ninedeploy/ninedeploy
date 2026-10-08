import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    traefik: { customCertificates: { list: vi.fn(), upload: vi.fn(), replace: vi.fn(), delete: vi.fn() } },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

import { CertificatesCard, daysLeft } from '../src/routes/traefik/CertificatesCard.js';

const certs = apiMock.api.traefik.customCertificates;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000 + 3_600_000).toISOString();

const wildcard = {
  id: 1,
  name: 'wildcard',
  hostnames: ['*.example.com', 'example.com'],
  subject: 'CN=*.example.com',
  issuer: 'CN=Acme CA',
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: inDays(200),
  fingerprint: 'AB:CD:EF:01:23:45:67:89:AB:CD',
  expired: false,
  coveredDomains: [{ id: 7, hostname: 'app.example.com', serviceId: 3 }],
};
const soon = { ...wildcard, id: 2, name: 'soon', issuer: null, notAfter: inDays(10), coveredDomains: [] };
const old = { ...wildcard, id: 3, name: 'old', notAfter: inDays(-2), expired: true, coveredDomains: [] };

const CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';

const saved = (over: Record<string, unknown> = {}) => ({ ...wildcard, warnings: [], ...over });

describe('CertificatesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    certs.list.mockResolvedValue([wildcard, soon, old]);
  });

  it('lists certificates with hostnames, issuer, expiry state and covered domains', async () => {
    renderWithProviders(<CertificatesCard />);
    const row = await screen.findByTestId('custom-cert-1');
    expect(row).toHaveTextContent('*.example.com, example.com');
    expect(row).toHaveTextContent('CN=Acme CA');
    expect(row).toHaveTextContent('valid');
    expect(row).toHaveTextContent('app.example.com');
    expect(row).toHaveTextContent('AB:CD:EF:01:23:4');
    expect(screen.getByTestId('custom-cert-2')).toHaveTextContent(/\d+d left/);
    expect(screen.getByTestId('custom-cert-2')).toHaveTextContent('no domains');
    expect(screen.getByTestId('custom-cert-2')).toHaveTextContent('—');
    expect(screen.getByTestId('custom-cert-3')).toHaveTextContent('expired');
  });

  it('flags a certificate past notAfter as expired even before the server says so', () => {
    expect(daysLeft('2026-01-11T00:00:00.000Z', Date.parse('2026-01-01T00:00:00.000Z'))).toBe(10);
    expect(daysLeft('2026-01-01T00:00:00.000Z', Date.parse('2026-01-02T00:00:00.000Z'))).toBe(-1);
  });

  it('shows the empty state', async () => {
    certs.list.mockResolvedValue([]);
    renderWithProviders(<CertificatesCard />);
    expect(await screen.findByText(/No uploaded certificates/)).toBeInTheDocument();
  });

  it('uploads a certificate, surfaces size warnings and forgets the key', async () => {
    certs.upload.mockResolvedValue(saved({ warnings: ['uploaded certificates total about 900 KiB'] }));
    renderWithProviders(<CertificatesCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Upload certificate/ }));
    const dialog = screen.getByRole('dialog');
    const upload = within(dialog).getByRole('button', { name: 'Upload' });
    expect(upload).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' wildcard ' } });
    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: CERT } });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: KEY } });
    fireEvent.click(upload);
    await waitFor(() => expect(certs.upload).toHaveBeenCalledWith({ name: 'wildcard', certPem: CERT, keyPem: KEY }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Certificate uploaded: *.example.com, example.com', 'success'));
    expect(toastSpy.toast).toHaveBeenCalledWith('uploaded certificates total about 900 KiB', 'info');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Reopening starts blank: the key is never kept or shown again.
    fireEvent.click(screen.getByRole('button', { name: /Upload certificate/ }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Private key (PEM)')).toHaveValue('');
    await waitFor(() => expect(certs.list).toHaveBeenCalledTimes(2));
  });

  it('reads the PEM fields from picked files', async () => {
    renderWithProviders(<CertificatesCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Upload certificate/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Certificate file'), { target: { files: [new File([CERT], 'c.pem')] } });
    fireEvent.change(within(dialog).getByLabelText('Private key file'), { target: { files: [new File([KEY], 'k.pem')] } });
    await waitFor(() => expect(within(dialog).getByLabelText('Certificate chain (PEM)')).toHaveValue(CERT));
    await waitFor(() => expect(within(dialog).getByLabelText('Private key (PEM)')).toHaveValue(KEY));
    // No file picked: nothing changes.
    fireEvent.change(within(dialog).getByLabelText('Certificate file'), { target: { files: [] } });
    expect(within(dialog).getByLabelText('Certificate chain (PEM)')).toHaveValue(CERT);
    // Escape closes the form.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('replaces a certificate, keeping the name when it is left blank', async () => {
    certs.replace.mockResolvedValue(saved());
    renderWithProviders(<CertificatesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace wildcard' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Replace "wildcard"');
    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: CERT } });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: KEY } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(certs.replace).toHaveBeenCalledWith(1, { certPem: CERT, keyPem: KEY }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Certificate replaced: *.example.com, example.com', 'success'));
  });

  it('replaces with a new name, and reports a refusal', async () => {
    certs.replace.mockRejectedValueOnce(new Error('the key does not match the certificate'));
    renderWithProviders(<CertificatesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace soon' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'renamed' } });
    fireEvent.change(within(dialog).getByLabelText('Certificate chain (PEM)'), { target: { value: CERT } });
    fireEvent.change(within(dialog).getByLabelText('Private key (PEM)'), { target: { value: KEY } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(certs.replace).toHaveBeenCalledWith(2, { name: 'renamed', certPem: CERT, keyPem: KEY }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('the key does not match the certificate', 'error'));
    certs.replace.mockRejectedValueOnce('odd');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the certificate', 'error'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('deletes after confirming, and reports a failed delete', async () => {
    certs.delete.mockResolvedValueOnce({ ok: true });
    renderWithProviders(<CertificatesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete wildcard' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Domains served with "wildcard" fall back');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(certs.delete).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Certificate "wildcard" deleted', 'success'));
    certs.delete.mockRejectedValueOnce(new Error('gone'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete old' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('gone', 'error'));
    certs.delete.mockRejectedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Delete old' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not delete the certificate', 'error'));
  });

  it('cancels a delete', async () => {
    renderWithProviders(<CertificatesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete wildcard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(certs.delete).not.toHaveBeenCalled();
  });

  it('shows an error card when the list cannot be read', async () => {
    certs.list.mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<CertificatesCard />);
    expect(await screen.findByText("Couldn't load the uploaded certificates")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(certs.list).toHaveBeenCalledTimes(2));
  });
});
