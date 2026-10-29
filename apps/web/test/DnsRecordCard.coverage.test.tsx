import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DnsRecordCard } from '../src/routes/settings/DnsRecordCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('DnsRecordCard (coverage)', () => {
  beforeEach(() => {
    mockOf(api.domainPresets.list).mockReset().mockResolvedValue({ providers: ['cloudflare-zone'] } as never);
    mockOf(api.domainPresets.apply).mockReset();
  });

  it('creates a CNAME with explicit content, toasts the result and clears the form', async () => {
    mockOf(api.domainPresets.apply).mockResolvedValue({ hostname: 'www.example.com', provider: 'cloudflare-zone', zone: 'example.com', recordId: 'r2', type: 'CNAME', content: 'lb.example.net' } as never);
    renderWithProviders(<DnsRecordCard />);
    const host = await screen.findByPlaceholderText('app.example.com');
    const content = screen.getByPlaceholderText('203.0.113.10');
    await userEvent.type(host, ' www.example.com ');
    await userEvent.type(content, ' lb.example.net ');
    await userEvent.click(screen.getByRole('button', { name: 'Create record' }));
    await waitFor(() => expect(api.domainPresets.apply).toHaveBeenCalledWith({ hostname: 'www.example.com', content: 'lb.example.net' }));
    expect(await screen.findByText('CNAME record for www.example.com created in example.com (lb.example.net)')).toBeInTheDocument();
    expect(host).toHaveValue('');
    expect(content).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create record' })).toBeDisabled();
  });

  it('shows a provider error and keeps what was typed', async () => {
    mockOf(api.domainPresets.apply).mockRejectedValue(new Error('no zone holds app.example.org'));
    renderWithProviders(<DnsRecordCard />);
    const host = await screen.findByPlaceholderText('app.example.com');
    await userEvent.type(host, 'app.example.org');
    await userEvent.click(screen.getByRole('button', { name: 'Create record' }));
    expect(await screen.findByText('no zone holds app.example.org')).toBeInTheDocument();
    expect(host).toHaveValue('app.example.org');
  });
});
