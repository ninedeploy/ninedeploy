import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SharedCertificatesCard } from '../src/routes/traefik/SharedCertificatesCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('SharedCertificatesCard (G5.7)', () => {
  it('switches sharing on and warns about the keys', async () => {
    mockOf(api.traefik.sharedCertificates.get).mockResolvedValue({ enabled: false } as never);
    mockOf(api.traefik.sharedCertificates.set).mockResolvedValue({ enabled: true } as never);
    renderWithProviders(<SharedCertificatesCard />);
    expect(await screen.findByText(/private keys to the nodes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Share panel certificates with nodes' }));
    await waitFor(() => expect(api.traefik.sharedCertificates.set).toHaveBeenCalledWith(true));
  });
});
