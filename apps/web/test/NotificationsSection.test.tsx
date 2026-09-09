import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NotificationsSection } from '../src/routes/settings/NotificationsSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

// The wizard is its own component suite; stub it to observe opens/closes.
vi.mock('../src/components/NotificationWizard.js', () => ({
  NotificationWizard: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="notif-wizard">
      wizard
      <button type="button" onClick={onClose}>close wizard</button>
    </div>
  ),
}));

function channel(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: 'telegram',
    name: 'ops',
    eventFilter: null,
    active: true,
    configJson: null,
    ...over,
  } as never;
}

describe('NotificationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state when no channels exist', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValue([] as never);
    renderWithProviders(<NotificationsSection />);
    expect(await screen.findByText('No notification channels configured.')).toBeInTheDocument();
    expect(screen.queryByTestId('notif-wizard')).not.toBeInTheDocument();
  });

  it('opens and closes the add-channel wizard', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValue([] as never);
    renderWithProviders(<NotificationsSection />);
    await screen.findByText('No notification channels configured.');
    fireEvent.click(screen.getByText('+ Add channel'));
    expect(screen.getByTestId('notif-wizard')).toBeInTheDocument();
    fireEvent.click(screen.getByText('close wizard'));
    expect(screen.queryByTestId('notif-wizard')).not.toBeInTheDocument();
  });

  it('toggles pause/activate, sends a test, and removes a channel', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValue([channel()] as never);
    mockOf(api.notifications.updateChannel).mockResolvedValue({} as never);
    mockOf(api.notifications.testChannel).mockResolvedValue({ ok: true } as never);
    mockOf(api.notifications.removeChannel).mockResolvedValue(undefined as never);
    renderWithProviders(<NotificationsSection />);
    await screen.findByText('ops');

    fireEvent.click(screen.getByTitle('Pause (deactivate)'));
    await waitFor(() => expect(api.notifications.updateChannel).toHaveBeenCalledWith(1, { active: false }));
    fireEvent.click(screen.getByTitle('Send test'));
    await waitFor(() => expect(api.notifications.testChannel).toHaveBeenCalledWith(1));
    fireEvent.click(screen.getByTitle('Remove'));
    await waitFor(() => expect(api.notifications.removeChannel).toHaveBeenCalledWith(1));
  });

  it('edits a discord channel: parses the stored embed blob, saves only filled fields', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValue([
      channel({
        type: 'discord',
        name: 'alerts',
        eventFilter: 'deploy.*',
        configJson: '{"username":"deploys","color":16733525,"unknownKey":true}',
      }),
    ] as never);
    mockOf(api.notifications.updateChannel).mockResolvedValue({} as never);
    renderWithProviders(<NotificationsSection />);
    await screen.findByText('alerts');

    fireEvent.click(screen.getByTitle('Edit'));
    // The stored blob parses into typed fields; unknown keys are dropped and
    // the color renders as #rrggbb.
    expect(screen.getByLabelText('Webhook username')).toHaveValue('deploys');
    expect(screen.getByLabelText('Embed color')).toHaveValue('#ff5555');

    // An invalid color clears instead of crashing.
    fireEvent.change(screen.getByLabelText('Embed color'), { target: { value: 'zzz' } });
    expect(screen.getByLabelText('Embed color')).toHaveValue('');
    // A valid hex re-parses.
    fireEvent.change(screen.getByLabelText('Embed color'), { target: { value: '#10b981' } });
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'alerts-2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.notifications.updateChannel).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'alerts-2', eventFilter: 'deploy.*' }),
      ),
    );
    const patch = vi.mocked(api.notifications.updateChannel).mock.calls[0]![1] as { configJson: string };
    const blob = JSON.parse(patch.configJson) as Record<string, unknown>;
    // Empty fields are dropped; the parsed values survive the round-trip.
    expect(blob).toEqual({ username: 'deploys', color: 0x10b981 });
    expect(patch.configJson).not.toContain('unknownKey');
  });

  it('tolerates a malformed config blob when opening the editor', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValue([
      channel({ type: 'discord', name: 'broken', configJson: '{not json' }),
    ] as never);
    renderWithProviders(<NotificationsSection />);
    await screen.findByText('broken');
    fireEvent.click(screen.getByTitle('Edit'));
    expect(screen.getByLabelText('Embed title')).toHaveValue('');
    expect(screen.getByLabelText('Webhook username')).toHaveValue('');
  });

  it('serializes a non-discord channel save with a null config blob', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValue([channel({ eventFilter: '' })] as never);
    mockOf(api.notifications.updateChannel).mockResolvedValue({} as never);
    renderWithProviders(<NotificationsSection />);
    await screen.findByText('ops');

    fireEvent.click(screen.getByTitle('Edit'));
    // No embed section for a telegram channel.
    expect(screen.queryByLabelText('Embed title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.notifications.updateChannel).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ configJson: null }),
      ),
    );
  });

  it('edits the discord embed title, username and avatar url fields', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValue([
      channel({ type: 'discord', name: 'alerts', configJson: '{}' }),
    ] as never);
    mockOf(api.notifications.updateChannel).mockResolvedValue({} as never);
    renderWithProviders(<NotificationsSection />);
    await screen.findByText('alerts');

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.change(screen.getByLabelText('Embed title'), { target: { value: 'Deploy finished' } });
    fireEvent.change(screen.getByLabelText('Webhook username'), { target: { value: 'ci-bot' } });
    fireEvent.change(screen.getByLabelText('Webhook avatar URL'), { target: { value: 'https://cdn.example.com/bot.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.notifications.updateChannel).toHaveBeenCalled());
    const patch = vi.mocked(api.notifications.updateChannel).mock.calls[0]![1] as { configJson: string };
    // All three typed fields survive the round-trip into the stored blob.
    expect(JSON.parse(patch.configJson)).toEqual({
      title: 'Deploy finished',
      username: 'ci-bot',
      avatarUrl: 'https://cdn.example.com/bot.png',
    });
  });
});
