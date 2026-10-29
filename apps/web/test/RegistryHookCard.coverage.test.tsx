import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
const svc = { id: 5, type: 'docker', image: 'acme/api:v1' } as never;

describe('RegistryHookCard — copy and refusals', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.services.registryHook)) mockOf(fn as never).mockReset();
  });

  it('shows the error when turning the hook on is refused', async () => {
    mockOf(api.services.registryHook.get).mockResolvedValue(off as never);
    mockOf(api.services.registryHook.enable).mockRejectedValue(new Error('Image services only'));
    renderWithProviders(<RegistryHookCard svc={svc} />);
    const toggle = await screen.findByRole('switch', { name: 'Registry webhook' });
    await userEvent.click(toggle);
    expect(await screen.findByText('Image services only')).toBeInTheDocument();
    expect(api.services.registryHook.enable).toHaveBeenCalledWith(5);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('copies the freshly made URL to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const url = 'https://panel.example.com/v1/registry-hooks/5/' + 'b'.repeat(32);
    mockOf(api.services.registryHook.get).mockResolvedValue({ ...off, enabled: true, mine: true, url } as never);
    renderWithProviders(<RegistryHookCard svc={svc} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
  });
});
