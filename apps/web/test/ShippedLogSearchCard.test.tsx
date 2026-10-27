import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockOf, renderRoute } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());

import { api } from '../src/lib/api.js';
import { ShippedLogSearchCard } from '../src/routes/service/ShippedLogSearchCard.js';

beforeEach(() => {
  vi.clearAllMocks();
});

const render = () => renderRoute(<ShippedLogSearchCard serviceId={4} />, { path: '/services/:id', route: '/services/4' });

// G1.5: the first web control for the G-16 Loki search route.
describe('ShippedLogSearchCard', () => {
  it('searches the chosen window for this service and lists the lines', async () => {
    mockOf(api.logDrains.search).mockResolvedValue({
      drain: { id: 2, name: 'loki-main', type: 'loki' },
      serviceId: 4,
      window: { since: '2026-10-27T00:00:00.000Z', until: '2026-10-27T01:00:00.000Z' },
      lines: [{ ts: Date.UTC(2026, 9, 27, 0, 30), line: 'ERROR boom', service: 'api' }],
    });
    render();
    expect(screen.getByRole('button', { name: /Search/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Log search text'), { target: { value: ' ERROR ' } });
    fireEvent.change(screen.getByLabelText('Search window'), { target: { value: '1440' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(api.logDrains.search).toHaveBeenCalledWith({ query: 'ERROR', sinceMinutes: 1440, serviceId: 4, limit: 500 }));
    expect(await screen.findByTestId('shipped-log-lines')).toHaveTextContent(/2026-10-27T00:30:00\.000Z\s+ERROR boom/);
    expect(screen.getByText(/1 line from drain “loki-main”/)).toBeInTheDocument();
  });

  it('says when nothing matched', async () => {
    mockOf(api.logDrains.search).mockResolvedValue({
      drain: { id: 2, name: 'loki-main', type: 'loki' },
      serviceId: 4,
      window: { since: '', until: '' },
      lines: [],
    });
    render();
    fireEvent.change(screen.getByLabelText('Log search text'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(await screen.findByText('No matching lines in this window.')).toBeInTheDocument();
  });

  it('points to Log Drains when no Loki drain exists, and shows other errors as they are', async () => {
    mockOf(api.logDrains.search)
      .mockRejectedValueOnce(Object.assign(new Error('No enabled Loki drain'), { status: 404 }))
      .mockRejectedValueOnce(Object.assign(new Error('Drain "sys" (type=syslog) does not support search'), { status: 400 }));
    render();
    fireEvent.change(screen.getByLabelText('Log search text'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(await screen.findByRole('link', { name: 'Settings → Log Drains' })).toHaveAttribute('href', '/settings?section=log-drains');
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(await screen.findByText(/does not support search/)).toBeInTheDocument();
  });
});
