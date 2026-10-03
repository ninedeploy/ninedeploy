import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpProvider, useHelp } from '../src/help/HelpContext.js';
import { HelpButton, HelpDrawer } from '../src/components/HelpDrawer.js';
import { renderWithProviders } from './helpers.js';

/** Mounts the drawer plus triggers the way pages would use it. */
function Harness({ namedTopic }: { namedTopic?: string }) {
  const { openHelp } = useHelp();
  return (
    <>
      <button type="button" onClick={() => openHelp()}>open-page-help</button>
      <button type="button" onClick={() => openHelp(namedTopic)}>open-named</button>
      <input aria-label="plain input" />
      <textarea aria-label="plain textarea" />
      <HelpButton />
      <HelpDrawer />
    </>
  );
}

function renderHelp(route = '/services/9?tab=deploys', namedTopic?: string) {
  return renderWithProviders(
    <HelpProvider>
      <Harness namedTopic={namedTopic} />
    </HelpProvider>,
    { route },
  );
}

const open = () => screen.getByRole('button', { name: 'open-page-help' });
const openNamed = () => screen.getByRole('button', { name: 'open-named' });
const closeX = () => screen.getByRole('button', { name: 'Close help panel' });

describe('HelpDrawer', () => {
  it('renders nothing until opened', () => {
    renderHelp();
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('opens with the topic of the current page (route + tab aware)', async () => {
    const user = userEvent.setup();
    renderHelp('/services/9?tab=deploys');
    await user.click(open());
    expect(screen.getByText('Service · Deploys')).toBeInTheDocument();
    expect(screen.getByText(/deployment history/i)).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('renders an explicit topic over the current page one', async () => {
    const user = userEvent.setup();
    renderHelp('/services/9?tab=deploys', 'service.danger');
    await user.click(openNamed());
    expect(screen.getByText('Service · Danger Zone')).toBeInTheDocument();
  });

  it('falls back to the general topic for an unknown explicit id', async () => {
    const user = userEvent.setup();
    renderHelp('/', 'not-a-topic');
    await user.click(openNamed());
    expect(screen.getByText('NineDeploy Help')).toBeInTheDocument();
  });

  it('closes via the header X, the backdrop and Escape, restoring scroll', async () => {
    const user = userEvent.setup();
    const { container } = renderHelp();
    await user.click(open());
    expect(screen.getByText('Service · Deploys')).toBeInTheDocument();

    await user.click(closeX());
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');

    await user.click(open());
    // The backdrop is the aria-hidden button inside the fixed wrapper.
    const backdrop = container.querySelector('div.fixed > button.absolute') as HTMLButtonElement;
    expect(backdrop).not.toBeNull();
    await user.click(backdrop);
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();

    await user.click(open());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('opens via the header help button for the current page', async () => {
    const user = userEvent.setup();
    renderHelp('/databases/3?tab=backups');
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByText('Database · Backups')).toBeInTheDocument();
  });

  it('toggles with the ? and F1 keys, ignoring modified keys', async () => {
    renderHelp();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByText('Service · Deploys')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'F1' });
    expect(screen.getByText('Service · Deploys')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F1' });
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();

    // Modifier chords are left alone (⌘K belongs to the command palette).
    fireEvent.keyDown(window, { key: '?', metaKey: true });
    fireEvent.keyDown(window, { key: '?', ctrlKey: true });
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();
  });

  it('ignores the ? key while typing in a text field', async () => {
    const user = userEvent.setup();
    renderHelp();
    await user.type(screen.getByLabelText('plain input'), 'what?');
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('plain textarea'), 'what?');
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();
  });

  it('renders paragraphs, steps, bullets and tip callouts', async () => {
    const user = userEvent.setup();
    renderHelp('/');
    await user.click(open());
    // Dashboard topic mixes all four content kinds.
    expect(screen.getByText('What you see here')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(3);
    expect(screen.getByText(/polling interval/i)).toBeInTheDocument();
  });

  it('navigates between topics through related links', async () => {
    const user = userEvent.setup();
    renderHelp('/dashboard');
    await user.click(open());
    await user.click(screen.getByRole('button', { name: /Monitoring & metrics/ }));
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    // …and back through another link.
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('closes when the footer link to the About page is used', async () => {
    const user = userEvent.setup();
    renderHelp();
    await user.click(open());
    await user.click(screen.getByText('Version, changelog & full docs'));
    expect(screen.queryByText('Service · Deploys')).not.toBeInTheDocument();
  });

  it('throws a helpful error when useHelp is used without a provider', () => {
    function Orphan(): null {
      useHelp();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/HelpProvider/);
  });
});
