import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegistryHookCard } from '../src/routes/service/RegistryHookCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const off = { enabled: false, mine: false, url: null, createdAt: null, lastPushAt: null };

describe('RegistryHookCard (G1.7)', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.services.registryHook)) mockOf(fn as never).mockReset();
  });
  it('turns the hook on and shows the URL once', async () => {
    mockOf(api.services.registryHook.get).mockResolvedValue(off as never);
    mockOf(api.services.registryHook.enable).mockResolvedValue({
      ...off,
      enabled: true,
      mine: true,
      url: 'https://panel.example.com/v1/registry-hooks/5/' + 'a'.repeat(32),
      createdAt: '2026-10-28T10:00:00.000Z',
    } as never);
    renderWithProviders(<RegistryHookCard svc={{ id: 5, type: 'docker', image: 'acme/api:v1' } as never} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Registry webhook' }));
    await waitFor(() => expect(api.services.registryHook.enable).toHaveBeenCalledWith(5));
    expect(await screen.findByText(/registry-hooks\/5\//)).toBeTruthy();
    expect(screen.getByText('Copy it now: it is shown only once.')).toBeTruthy();
  });

  it('is only for services deployed from an image', () => {
    const { container } = renderWithProviders(<RegistryHookCard svc={{ id: 6, type: 'git', image: null } as never} />);
    expect(container.textContent).toBe('');
    expect(api.services.registryHook.get).not.toHaveBeenCalled();
  });

  it('requires confirmation before replacing an existing webhook URL', async () => {
    mockOf(api.services.registryHook.get).mockResolvedValue({ ...off, enabled: true, mine: true, lastPushAt: '2026-10-28T10:00:00Z' } as never);
    mockOf(api.services.registryHook.enable).mockResolvedValue({ ...off, enabled: true, mine: true, url: 'https://panel.test/new' } as never);
    renderWithProviders(<RegistryHookCard svc={{ id: 5, type: 'docker', image: 'acme/api:v1' } as never} />);
    await userEvent.click(await screen.findByRole('button', { name: 'New URL' }));
    expect(await screen.findByText('The current URL stops working; update the webhook in your registry with the new one. The hook deploys as you from now on.')).toBeInTheDocument();
    expect(api.services.registryHook.enable).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    const { within } = await import('@testing-library/react');
    await userEvent.click(within(dialog).getByRole('button', { name: 'New URL' }));
    expect(await screen.findByText('https://panel.test/new')).toBeInTheDocument();
    expect(api.services.registryHook.enable).toHaveBeenCalledWith(5);
  });

  it('stops a webhook and displays an error when disabling is refused', async () => {
    mockOf(api.services.registryHook.get).mockResolvedValue({ ...off, enabled: true, mine: false } as never);
    mockOf(api.services.registryHook.disable).mockRejectedValueOnce(new Error('Access denied')).mockResolvedValueOnce(off as never);
    renderWithProviders(<RegistryHookCard svc={{ id: 5, type: 'docker', image: 'acme/api:v1' } as never} />);
    expect(await screen.findByText('Turned on by another member — it deploys as them.')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Registry webhook' });
    await userEvent.click(toggle);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(api.services.registryHook.disable).toHaveBeenCalledTimes(2);
  });
});
