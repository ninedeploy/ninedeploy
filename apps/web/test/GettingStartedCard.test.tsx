import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import { GettingStartedCard } from '../src/components/GettingStartedCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

const IDS = ['auto_url', 'git_source', 'first_service', 'first_deploy', 'custom_domain', 'https', 'notifications', 'backups'] as const;
const OPTIONAL = new Set(['git_source', 'custom_domain', 'https', 'notifications', 'backups']);

function status(done: string[], over: Record<string, unknown> = {}) {
  const steps = IDS.map((id) => ({ id, done: done.includes(id), optional: OPTIONAL.has(id) }));
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    ready: steps.every((s) => s.optional || s.done),
    dismissed: false,
    autoUrl: { mode: 'off', domain: null, ip: null, source: 'setting' },
    ...over,
  };
}

function renderCard() {
  return renderWithProviders(
    <>
      <GettingStartedCard />
      <LocationProbe />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.onboarding.setDismissed).mockResolvedValue({ ok: true, dismissed: true });
});

describe('GettingStartedCard', () => {
  it('shows progress and highlights the next required step', async () => {
    mockOf(api.onboarding.get).mockResolvedValue(status(['auto_url']));
    renderCard();
    expect(await screen.findByText('Set up your panel')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('1 of 8')).toBeInTheDocument();
    // Done steps are struck through and offer no action.
    expect(screen.queryByRole('link', { name: /Give services a URL/ })).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'New service: Create your first service' });
    expect(next.firstElementChild).toHaveClass('bg-indigo-500');
  });

  it('the first-service step opens the Deploy Wizard; others link to their page', async () => {
    mockOf(api.onboarding.get).mockResolvedValue(status([]));
    renderCard();
    expect(await screen.findByRole('link', { name: 'Set up: Give services a URL' })).toHaveAttribute('href', '/settings?section=security');
    expect(screen.getByRole('link', { name: 'Add destination: Back up your data' })).toHaveAttribute('href', '/backups');
    fireEvent.click(screen.getByRole('button', { name: 'New service: Create your first service' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?deploy=new'));
  });

  it('collapses once ready, and can be hidden and brought back', async () => {
    mockOf(api.onboarding.get).mockResolvedValue(status(['auto_url', 'first_service', 'first_deploy']));
    renderCard();
    expect(await screen.findByText('Your panel is ready — a few extras left')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand checklist' }));
    expect(screen.getByRole('list')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the checklist' }));
    await waitFor(() => expect(api.onboarding.setDismissed).toHaveBeenCalledWith(true));
  });

  it('when hidden, one quiet line brings it back', async () => {
    mockOf(api.onboarding.get).mockResolvedValue(status(['auto_url'], { dismissed: true }));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Setup: 1 of 8 done · Show checklist/ }));
    await waitFor(() => expect(api.onboarding.setDismissed).toHaveBeenCalledWith(false));
  });

  it('renders nothing once every step is done', async () => {
    mockOf(api.onboarding.get).mockResolvedValue(status([...IDS]));
    const { container } = renderCard();
    await waitFor(() => expect(api.onboarding.get).toHaveBeenCalled());
    expect(container.querySelector('section')).toBeNull();
  });
});
