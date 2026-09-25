import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DomainTransferAccept } from '../src/routes/DomainTransferAccept.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { mockOf, renderRoute } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

const PATH = '/domains/transfers/:token/accept';

function preview(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: 'pending',
    hostname: 'shop.example.com',
    sourceEmail: 'alice@example.com',
    targetEmail: 'bob@example.com',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
    acceptedAt: null,
    cancelledAt: null,
    effectivelyExpired: false,
    ...over,
  };
}

function signedInAs(email: string) {
  mockOf(useAuth).mockReturnValue({ user: { id: 2, email, isOperator: false }, loading: false } as never);
}

describe('DomainTransferAccept (r358)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedInAs('bob@example.com');
    mockOf(api.services.list).mockResolvedValue([
      { id: 11, name: 'bob-web' },
      { id: 12, name: 'bob-api' },
    ] as never);
  });

  it('previews the transfer and accepts it onto the chosen service', async () => {
    mockOf(api.domains.previewTransfer).mockResolvedValue(preview() as never);
    mockOf(api.domains.acceptTransfer).mockResolvedValue({
      ok: true,
      transferId: 7,
      domainId: 3,
      serviceId: 12,
      hostname: 'shop.example.com',
    } as never);
    renderRoute(<DomainTransferAccept />, { path: PATH, route: '/domains/transfers/tok123/accept' });

    expect(await screen.findByText('Domain transfer: shop.example.com')).toBeInTheDocument();
    expect(api.domains.previewTransfer).toHaveBeenCalledWith('tok123');
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText(/The link expires/)).toBeInTheDocument();

    const accept = screen.getByRole('button', { name: 'Accept transfer' });
    expect(accept).toBeDisabled();
    await screen.findByRole('option', { name: 'bob-api' });
    fireEvent.change(screen.getByLabelText('Move it to'), { target: { value: '12' } });
    fireEvent.click(accept);

    expect(await screen.findByText('Domain transferred')).toBeInTheDocument();
    expect(api.domains.acceptTransfer).toHaveBeenCalledWith('tok123', { targetServiceId: 12 });
    expect(screen.getByRole('link', { name: 'Open the service' })).toHaveAttribute('href', '/services/12');
  });

  it('shows the server refusal (e.g. no admin seat) inline', async () => {
    mockOf(api.domains.previewTransfer).mockResolvedValue(preview() as never);
    mockOf(api.domains.acceptTransfer).mockRejectedValue(
      new Error('This action requires the "admin" role or higher on this service'),
    );
    renderRoute(<DomainTransferAccept />, { path: PATH, route: '/domains/transfers/tok123/accept' });
    await screen.findByRole('option', { name: 'bob-web' });
    fireEvent.change(screen.getByLabelText('Move it to'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept transfer' }));
    expect(await screen.findByText(/requires the "admin" role/)).toBeInTheDocument();
  });

  it('refuses to offer accept to an account the transfer is not addressed to', async () => {
    signedInAs('mallory@example.com');
    mockOf(api.domains.previewTransfer).mockResolvedValue(preview() as never);
    renderRoute(<DomainTransferAccept />, { path: PATH, route: '/domains/transfers/tok123/accept' });
    expect(await screen.findByText(/but you are signed in as/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept transfer' })).toBeNull();
  });

  it('says a used or expired transfer can no longer be accepted', async () => {
    mockOf(api.domains.previewTransfer).mockResolvedValue(preview({ status: 'expired' }) as never);
    renderRoute(<DomainTransferAccept />, { path: PATH, route: '/domains/transfers/tok123/accept' });
    expect(await screen.findByText('expired')).toBeInTheDocument();
    expect(screen.getByText(/can no longer be accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept transfer' })).toBeNull();
  });

  it('shows "not found" for an unknown token', async () => {
    mockOf(api.domains.previewTransfer).mockRejectedValue(new Error('Transfer not found'));
    renderRoute(<DomainTransferAccept />, { path: PATH, route: '/domains/transfers/nope/accept' });
    expect(await screen.findByText('Transfer not found')).toBeInTheDocument();
  });

  it('tells a recipient with no services why the picker is empty', async () => {
    mockOf(api.services.list).mockResolvedValue([] as never);
    mockOf(api.domains.previewTransfer).mockResolvedValue(preview() as never);
    renderRoute(<DomainTransferAccept />, { path: PATH, route: '/domains/transfers/tok123/accept' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'You have no services yet' })).toBeInTheDocument());
  });
});
