import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ServicesList } from '../src/routes/ServicesList.js';
import { api } from '../src/lib/api.js';
import { LocaleProvider } from '../src/lib/i18n.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

/** G4.6: an extracted route renders its Turkish strings under a Turkish locale. */
describe('translated routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('ninedeploy.locale', 'tr');
  });
  afterEach(() => localStorage.clear());

  it('renders the services list empty state in Turkish', async () => {
    mockOf(api.services.list).mockResolvedValue([] as never);
    renderWithProviders(<LocaleProvider><ServicesList /></LocaleProvider>);
    expect(await screen.findByText('Henüz servis yok')).toBeInTheDocument();
    expect(screen.queryByText('No services yet')).not.toBeInTheDocument();
  });
});
