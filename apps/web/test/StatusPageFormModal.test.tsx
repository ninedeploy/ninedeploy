import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MonitorView, StatusPageView } from '@ninedeploy/schemas';
import { StatusPageFormModal } from '../src/components/uptime/StatusPageFormModal.js';
import { uptimeApi } from '../src/lib/uptimeApi.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.8 status page modal: texts, switches, the ordered monitor picker, validation. */

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/uptimeApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/uptimeApi.js')>()),
  uptimeApi: (await import('./apiMock.js')).createUptimeApiMock(),
}));
vi.mock('../src/lib/auth.js', async () => (await import('./apiMock.js')).createAuthMock());
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const base = {
  serviceId: null,
  kind: 'http' as const,
  target: 'https://x.test',
  method: 'GET' as const,
  expectedStatus: '200-399',
  keyword: null,
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failuresBeforeDown: 2,
  followRedirects: true,
  verifyTls: true,
  enabled: true,
  statusSince: null,
  consecutiveFailures: 0,
  lastCheckedAt: null,
  lastResponseMs: null,
  lastStatusCode: null,
  lastError: null,
  certExpiresAt: null,
  uptime: { h24: null, d7: null, d30: null },
  createdAt: '2026-10-01T00:00:00Z',
};
const MONITORS: MonitorView[] = [
  { ...base, id: 1, name: 'Website', status: 'up' },
  { ...base, id: 2, name: 'API', status: 'down' },
  { ...base, id: 3, name: 'Docs', status: 'pending' },
];
const PAGE: StatusPageView = {
  id: 9,
  slug: 'acme',
  title: 'Acme',
  description: 'Our services',
  notice: null,
  published: false,
  showResponseTimes: true,
  monitorIds: [2, 77],
  path: '/status/acme',
  createdAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => vi.clearAllMocks());

function dialog() {
  return within(screen.getByRole('dialog'));
}

describe('StatusPageFormModal', () => {
  it('creates a page with its monitors in the chosen order', async () => {
    const onClose = vi.fn();
    mockOf(uptimeApi.statusPages.create).mockResolvedValue(PAGE);
    renderWithProviders(<StatusPageFormModal monitors={MONITORS} onClose={onClose} />);
    const d = dialog();
    expect(d.getByText('No monitors on this page yet.')).toBeInTheDocument();

    // The slug follows the title until it is typed in.
    fireEvent.change(d.getByLabelText('Title'), { target: { value: 'Acme Status' } });
    expect(d.getByLabelText('Slug')).toHaveValue('acme-status');
    fireEvent.change(d.getByLabelText('Slug'), { target: { value: 'acme' } });
    fireEvent.change(d.getByLabelText('Title'), { target: { value: 'Acme' } });
    expect(d.getByLabelText('Slug')).toHaveValue('acme');
    expect(d.getByText('Public at /status/acme')).toBeInTheDocument();

    fireEvent.change(d.getByLabelText('Description (optional)'), { target: { value: ' Our services ' } });
    fireEvent.change(d.getByLabelText('Notice (optional)'), { target: { value: 'Maintenance tonight' } });
    fireEvent.click(d.getByRole('switch', { name: 'Published' }));
    fireEvent.click(d.getByRole('switch', { name: 'Show response times' }));

    const add = d.getByLabelText('Add a monitor');
    fireEvent.change(add, { target: { value: '1' } });
    fireEvent.change(d.getByLabelText('Add a monitor'), { target: { value: '2' } });
    fireEvent.change(d.getByLabelText('Add a monitor'), { target: { value: '3' } });
    // Every monitor is on the page: the picker goes away.
    expect(d.queryByLabelText('Add a monitor')).not.toBeInTheDocument();
    const order = () => within(d.getByRole('list', { name: 'Monitors on the page' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(order()).toEqual(['Website', 'API', 'Docs']);
    expect(d.getByRole('button', { name: 'Move Website up' })).toBeDisabled();
    expect(d.getByRole('button', { name: 'Move Docs down' })).toBeDisabled();
    fireEvent.click(d.getByRole('button', { name: 'Move Docs up' }));
    fireEvent.click(d.getByRole('button', { name: 'Move Website down' }));
    expect(order()).toEqual(['Docs', 'Website', 'API']);
    fireEvent.click(d.getByRole('button', { name: 'Remove API' }));
    expect(order()).toEqual(['Docs', 'Website']);

    fireEvent.click(d.getByRole('button', { name: 'Create page' }));
    await waitFor(() =>
      expect(uptimeApi.statusPages.create).toHaveBeenCalledWith({
        slug: 'acme',
        title: 'Acme',
        description: 'Our services',
        notice: 'Maintenance tonight',
        published: true,
        showResponseTimes: false,
        monitorIds: [3, 1],
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Status page created', 'success'));
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores the placeholder option of the picker', () => {
    renderWithProviders(<StatusPageFormModal monitors={MONITORS} onClose={vi.fn()} />);
    fireEvent.change(dialog().getByLabelText('Add a monitor'), { target: { value: '' } });
    expect(dialog().getByText('No monitors on this page yet.')).toBeInTheDocument();
  });

  it('validates before sending and shows a refusal', async () => {
    mockOf(uptimeApi.statusPages.create).mockRejectedValueOnce(new Error('the slug is taken')).mockRejectedValueOnce(new Error(''));
    renderWithProviders(<StatusPageFormModal monitors={[]} onClose={vi.fn()} />);
    const d = dialog();
    expect(d.queryByLabelText('Add a monitor')).not.toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: 'Create page' }));
    expect(await d.findAllByText(/Too small|at least|expected/i)).not.toHaveLength(0);
    expect(uptimeApi.statusPages.create).not.toHaveBeenCalled();

    fireEvent.change(d.getByLabelText('Title'), { target: { value: 'Ok' } });
    fireEvent.submit(d.getByLabelText('Title').closest('form')!);
    expect(await d.findByRole('alert')).toHaveTextContent('the slug is taken');
    expect(toastSpy.toast).toHaveBeenCalledWith('the slug is taken', 'error');
    fireEvent.click(d.getByRole('button', { name: 'Create page' }));
    await waitFor(() => expect(d.getByRole('alert')).toHaveTextContent('Could not save the status page'));
  });

  it('edits a page, naming a monitor that no longer exists by id', async () => {
    const onClose = vi.fn();
    mockOf(uptimeApi.statusPages.update).mockResolvedValue(PAGE);
    renderWithProviders(<StatusPageFormModal page={PAGE} monitors={MONITORS} onClose={onClose} />);
    const d = dialog();
    expect(screen.getByRole('dialog', { name: 'Edit Acme' })).toBeInTheDocument();
    expect(d.getByText('monitor #77')).toBeInTheDocument();
    // An existing page keeps its slug when the title changes.
    fireEvent.change(d.getByLabelText('Title'), { target: { value: 'Acme Inc' } });
    expect(d.getByLabelText('Slug')).toHaveValue('acme');
    fireEvent.click(d.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(uptimeApi.statusPages.update).toHaveBeenCalledWith(9, expect.objectContaining({ title: 'Acme Inc', monitorIds: [2, 77], notice: null })));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Status page saved', 'success'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on cancel', () => {
    const onClose = vi.fn();
    renderWithProviders(<StatusPageFormModal monitors={MONITORS} onClose={onClose} />);
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
