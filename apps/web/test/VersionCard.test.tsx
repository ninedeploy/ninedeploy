import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    databases: {
      version: { get: vi.fn(), set: vi.fn() },
    },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

import { ToastProvider } from '../src/components/Toast.js';
import { VersionCard } from '../src/routes/database/VersionCard.js';

/** N12: Database → Settings → Version: a database without a version, or one named by hand. */
const version = apiMock.api.databases.version;
const db = { id: 7, name: 'shop', engine: 'mysql', version: null, status: 'stopped' };
const unknown = (over: Record<string, unknown> = {}) => ({
  databaseId: 7, version: null, namedAt: null, canSet: true, why: null, creationImage: 'mysql:8.0', defaultImage: 'mysql:9.7', defaultTag: '9.7',
  containerImage: null, ambiguous: true, choices: ['8.0', '8.4', '9.7'], ...over,
});

function renderCard(d: unknown = db) {
  return renderWithProviders(<VersionCard db={d as never} />, {
    queryClient: createQueryClient(),
    wrapper: (c) => <ToastProvider>{c}</ToastProvider>,
  });
}

beforeEach(() => {
  version.get.mockReset();
  version.set.mockReset();
  version.get.mockResolvedValue(unknown());
});

describe('VersionCard', () => {
  it('asks nothing about a database whose version the server runs, nor about one on a node', () => {
    const { container } = renderCard({ id: 7, name: 'shop', engine: 'mysql', version: '8.0', versionNamedAt: null });
    expect(container.textContent).toBe('');
    renderCard({ id: 7, name: 'shop', engine: 'mysql', version: null, serverId: 3 });
    expect(version.get).not.toHaveBeenCalled();
  });

  it('says what a Start would run on data created by another image, offers the releases with the creating one selected, and names one after a confirmation', async () => {
    version.set.mockResolvedValue(unknown({ version: '8.4', namedAt: '2026-11-28T02:00:00.000Z' }));
    renderCard();
    const notice = await screen.findByTestId('version-unknown');
    expect(notice.textContent).toContain('This database has no version: a Start would run mysql:9.7 on data created by mysql:8.0.');
    expect(notice.textContent).toContain('Nobody can tell which release this data runs');
    expect(screen.getByText(/upgrades the data in place, with no way back/)).toBeTruthy();
    const select = (await screen.findByLabelText('Release to name')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['8.0', '8.4', '9.7']);
    expect(select.value).toBe('8.0');
    fireEvent.change(select, { target: { value: '8.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set version' }));
    expect(await screen.findByText('Set the version to MySQL 8.4?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Set version' }).at(-1)!);
    await waitFor(() => expect(version.set).toHaveBeenCalledWith(7, { version: '8.4' }));
    expect(await screen.findByText('Version set to 8.4. The first start tries it.')).toBeTruthy();
  });

  it('a volume the default image created is not called ambiguous', async () => {
    version.get.mockResolvedValue(unknown({ creationImage: 'mysql:9.7', ambiguous: false }));
    renderCard();
    const notice = await screen.findByTestId('version-unknown');
    expect(notice.textContent).toContain('on data created by mysql:9.7');
    expect(notice.textContent).not.toContain('Nobody can tell');
  });

  it('a volume that says nothing is not called ambiguous either', async () => {
    version.get.mockResolvedValue(unknown({ creationImage: null, ambiguous: false }));
    renderCard();
    expect((await screen.findByTestId('version-unknown')).textContent).toContain('This database has no version: a Start would run mysql:9.7.');
  });

  it('a release named by hand is shown as not run on yet, and offered again', async () => {
    version.get.mockResolvedValue(unknown({ version: '8.0', namedAt: '2026-11-27T02:00:00.000Z', ambiguous: false }));
    renderCard({ ...db, version: '8.0', versionNamedAt: '2026-11-27T02:00:00.000Z' });
    const notice = await screen.findByTestId('version-provisional');
    expect(notice.textContent).toContain('Named 8.0 by hand on');
    expect(notice.textContent).toContain('the server has not run on it yet.');
    expect(notice.textContent).toContain('one the server does not stay up in is undone, and the release can be named again.');
    expect((screen.getByLabelText('Release to name') as HTMLSelectElement).value).toBe('8.0');
  });

  it('gives the reason when the release cannot be named, and offers nothing', async () => {
    version.get.mockResolvedValue(unknown({ canSet: false, ambiguous: false, containerImage: 'mysql:8.4', why: 'Its container exists: the panel pins the release it runs at its next boot.' }));
    renderCard();
    expect((await screen.findByTestId('version-closed')).textContent).toBe('Its container exists: the panel pins the release it runs at its next boot.');
    expect(screen.queryByLabelText('Release to name')).toBeNull();
  });

  it('reports what the panel refuses', async () => {
    version.set.mockRejectedValue(new Error('The database ran on its named release meanwhile; it is its version now.'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Set version' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Set version' })).at(-1)!);
    expect(await screen.findByText('The database ran on its named release meanwhile; it is its version now.')).toBeTruthy();
  });
});
