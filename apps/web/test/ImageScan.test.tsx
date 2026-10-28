import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImageScanCard } from '../src/routes/service/ImageScanCard.js';
import { ImageScanSection } from '../src/routes/settings/ImageScanSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const counts = (critical: number, high: number) => ({ critical, high, medium: 2, low: 3, unknown: 0 });
const RESULT = {
  serviceId: 5,
  imageId: `sha256:${'a'.repeat(64)}`,
  scannedAt: '2026-10-28T09:00:00.000Z',
  trigger: 'deploy',
  deploymentId: 9,
  status: 'ok',
  error: null,
  os: 'debian 12.15',
  counts: counts(1, 1),
  fixable: counts(1, 0),
  findings: [
    { id: 'CVE-2024-1', severity: 'CRITICAL', pkg: 'openssl', installed: '3.0.11-1', fixed: '3.0.15-1', title: 't', url: 'https://avd.aquasec.com/nvd/cve-2024-1', target: 'x' },
    { id: 'CVE-2024-2', severity: 'HIGH', pkg: 'zlib1g', installed: '1.2.13', fixed: null, title: null, url: null, target: 'x' },
  ],
  findingsTruncated: false,
  blocked: true,
};

describe('ImageScanCard (G5.1)', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.imageScans)) mockOf(fn as never).mockReset();
  });

  it('shows nothing until the service has a scan', async () => {
    mockOf(api.imageScans.get).mockResolvedValue({ result: null, scanning: false } as never);
    const { container } = renderWithProviders(<ImageScanCard serviceId={5} />);
    await waitFor(() => expect(api.imageScans.get).toHaveBeenCalledWith(5));
    expect(container.textContent).toBe('');
  });

  it('shows the counts, the findings and the gate, and starts a rescan', async () => {
    mockOf(api.imageScans.get).mockResolvedValue({ result: RESULT, scanning: false } as never);
    mockOf(api.imageScans.scan).mockResolvedValue({ started: true, imageId: RESULT.imageId } as never);
    renderWithProviders(<ImageScanCard serviceId={5} />);
    expect(await screen.findByText('1 critical (1 fixable)')).toBeInTheDocument();
    expect(screen.getByText('Deploy blocked by the gate')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CVE-2024-1' })).toHaveAttribute('href', 'https://avd.aquasec.com/nvd/cve-2024-1');
    expect(screen.getByText('3.0.15-1')).toBeInTheDocument();
    expect(screen.getByText('no fix')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(api.imageScans.scan).toHaveBeenCalledWith(5));
  });

  it('shows a scan failure and surfaces a rejected retry', async () => {
    mockOf(api.imageScans.get).mockResolvedValue({ result: { ...RESULT, status: 'error', error: 'scanner offline' }, scanning: false } as never);
    mockOf(api.imageScans.scan).mockRejectedValue(new Error('not allowed'));
    renderWithProviders(<ImageScanCard serviceId={5} />);
    expect(await screen.findByText('The scan could not run: scanner offline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    expect(await screen.findByText('Could not start a scan: not allowed')).toBeInTheDocument();
  });

  it('keeps scanning disabled during an active scan and can expand truncated findings', async () => {
    const findings = Array.from({ length: 21 }, (_, index) => ({ ...RESULT.findings[0]!, id: `CVE-${index}`, url: null }));
    mockOf(api.imageScans.get).mockResolvedValue({ result: { ...RESULT, findings, findingsTruncated: true }, scanning: true } as never);
    renderWithProviders(<ImageScanCard serviceId={5} />);
    expect(await screen.findByRole('button', { name: 'Scanning…' })).toBeDisabled();
    expect(screen.queryByText('CVE-20')).not.toBeInTheDocument();
    expect(screen.getByText('Only the 21 most severe findings are kept.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all 21' }));
    expect(screen.getByText('CVE-20')).toBeInTheDocument();
  });
});

describe('ImageScanSection (G5.1)', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.imageScans)) mockOf(fn as never).mockReset();
  });

  it('turns scanning on and sets the gate', async () => {
    const view = { policy: { enabled: false, gate: 'off', gateFixableOnly: true, rescanHours: 24 }, trivyImage: 'aquasec/trivy:0.69.3@sha256:x' };
    mockOf(api.imageScans.policy).mockResolvedValue(view as never);
    mockOf(api.imageScans.setPolicy).mockImplementation(async (patch) => ({ ...view, policy: { ...view.policy, ...patch } }) as never);
    renderWithProviders(<ImageScanSection />);
    expect(await screen.findByText('Scanner image: aquasec/trivy:0.69.3@sha256:x')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Scan images' }));
    await waitFor(() => expect(api.imageScans.setPolicy).toHaveBeenCalledWith({ enabled: true }));
    await userEvent.selectOptions(screen.getByLabelText('Deploy gate'), 'critical');
    await waitFor(() => expect(api.imageScans.setPolicy).toHaveBeenCalledWith({ gate: 'critical' }));
  });

  it('validates the rescan interval and saves fixable-only policy changes', async () => {
    const view = { policy: { enabled: true, gate: 'critical', gateFixableOnly: true, rescanHours: 24 }, trivyImage: 'trivy:test' };
    mockOf(api.imageScans.policy).mockResolvedValue(view as never);
    mockOf(api.imageScans.setPolicy).mockImplementation(async (patch) => ({ ...view, policy: { ...view.policy, ...patch } }) as never);
    renderWithProviders(<ImageScanSection />);
    const hours = await screen.findByLabelText('Rescan running images every (hours)');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.clear(hours);
    await userEvent.type(hours, '721');
    expect(save).toBeDisabled();
    await userEvent.clear(hours);
    await userEvent.type(hours, '0');
    await userEvent.click(save);
    await waitFor(() => expect(api.imageScans.setPolicy).toHaveBeenCalledWith({ rescanHours: 0 }));
    await userEvent.click(screen.getByRole('switch', { name: 'Gate counts only fixable findings' }));
    await waitFor(() => expect(api.imageScans.setPolicy).toHaveBeenCalledWith({ gateFixableOnly: false }));
  });
});
