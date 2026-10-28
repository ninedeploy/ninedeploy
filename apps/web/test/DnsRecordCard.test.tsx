import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DnsRecordCard } from '../src/routes/settings/DnsRecordCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('DnsRecordCard (G1.5 domain presets)', () => {
  it('creates a record through the configured provider', async () => {
    mockOf(api.domainPresets.list).mockResolvedValue({ providers: ['cloudflare-zone'] });
    mockOf(api.domainPresets.apply).mockResolvedValue({ hostname: 'app.example.com', provider: 'cloudflare-zone', zone: 'example.com', recordId: 'r1', type: 'A', content: '203.0.113.10' } as never);
    renderWithProviders(<DnsRecordCard />);
    fireEvent.change(await screen.findByPlaceholderText('app.example.com'), { target: { value: 'app.example.com' } });
    await userEvent.click(screen.getByRole('button', { name: 'Create record' }));
    await waitFor(() => expect(api.domainPresets.apply).toHaveBeenCalledWith({ hostname: 'app.example.com' }));
  });

  it('is hidden without a DNS provider', async () => {
    const { container } = renderWithProviders(<DnsRecordCard />);
    await waitFor(() => expect(api.domainPresets.list).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
