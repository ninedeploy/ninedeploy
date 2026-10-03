import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../src/components/Toast.js';
import { deferred } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    notifications: {
      createChannel: vi.fn(),
      updateChannel: vi.fn(),
      testChannel: vi.fn(),
    },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

import { NotificationWizard } from '../src/components/NotificationWizard.js';

function renderWizard(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <NotificationWizard onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

describe('NotificationWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.notifications.createChannel.mockResolvedValue({ id: 1, name: 'ch', type: 'telegram' });
    apiMock.api.notifications.updateChannel.mockResolvedValue({ id: 1, active: true });
    apiMock.api.notifications.testChannel.mockResolvedValue({ ok: true });
  });

  it('renders all channel types on the first step and requires a selection', async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Discord')).toBeInTheDocument();
    expect(screen.getByText('Webhook')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.click(screen.getByText('Telegram'));
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('shows the telegram connect form', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('1. Create bot')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('789123456:AAEx…:987654321')).toBeInTheDocument();
  });

  it('shows the discord connect form', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Discord'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Create Discord Webhook')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://discord.com/api/webhooks/…')).toBeInTheDocument();
  });

  it('shows the webhook connect form', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Webhook'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Generic Webhook')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://your-app.com/webhook')).toBeInTheDocument();
  });

  it('requires a target before advancing from the connect step', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('toggles events on the events step', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Deployments')).toBeInTheDocument();
    await user.click(screen.getByText('Domains'));
    await user.click(screen.getByText('Deployments'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // "Events" text appears in both the stepper label and the summary row
    // header — use getAllByText to assert the stepper rendered.
    expect(screen.getAllByText('Events').length).toBeGreaterThan(0);
  });

  it('tests the channel successfully and creates it', async () => {
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Test step
    expect(screen.getByText('Ready to test?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() =>
      expect(apiMock.api.notifications.createChannel).toHaveBeenCalledWith({
        name: 'telegram channel',
        type: 'telegram',
        target: 'tok:chat',
        eventFilter: 'deploy,service,alert',
      }),
    );
    await waitFor(() => expect(apiMock.api.notifications.testChannel).toHaveBeenCalledWith(1));
    expect(screen.getByText('Test message sent!')).toBeInTheDocument();

    // Finish: the channel already exists from the test, so the final step
    // PATCHes it (no second create) and closes.
    await user.click(screen.getByRole('button', { name: /create channel/i }));
    await waitFor(() =>
      expect(apiMock.api.notifications.updateChannel).toHaveBeenCalledWith(1, {
        name: 'telegram channel',
        target: 'tok:chat',
        eventFilter: 'deploy,service,alert',
      }),
    );
    expect(apiMock.api.notifications.createChannel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.getByText('Notification channel created!')).toBeInTheDocument();
  });

  it('toasts when saving the channel on the final step fails', async () => {
    // Test succeeds, but the final PATCH (sync of post-test edits) rejects.
    apiMock.api.notifications.updateChannel.mockRejectedValue(new Error('save blew up'));
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() => expect(screen.getByText('Test message sent!')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /create channel/i }));
    await waitFor(() => expect(screen.getByText('Could not save the channel')).toBeInTheDocument());
    // The wizard stays open so the user can retry.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('patches the existing channel when retrying the test after a delivery failure', async () => {
    // First delivery fails AFTER the channel row was created…
    apiMock.api.notifications.testChannel.mockRejectedValueOnce(new Error('no route'));
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() => expect(screen.getByText('Test failed — check your settings')).toBeInTheDocument());
    expect(apiMock.api.notifications.createChannel).toHaveBeenCalledTimes(1);

    // …retrying syncs the (possibly edited) settings via PATCH instead of
    // creating a duplicate channel.
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() =>
      expect(apiMock.api.notifications.updateChannel).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ target: 'tok:chat' }),
      ),
    );
    await waitFor(() => expect(apiMock.api.notifications.testChannel).toHaveBeenCalledTimes(2));
    expect(apiMock.api.notifications.createChannel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('Test message sent!')).toBeInTheDocument());

    // Finishing PATCHes the final state and closes.
    await user.click(screen.getByRole('button', { name: /create channel/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows a failure state when the test fails', async () => {
    apiMock.api.notifications.testChannel.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Discord'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('https://discord.com/api/webhooks/…'), 'https://discord.com/x');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() => expect(screen.getByText('Test failed — check your settings')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /send test/i })).toBeInTheDocument();
  });

  it('shows the testing label while a test is in flight', async () => {
    const d = deferred();
    apiMock.api.notifications.testChannel.mockReturnValue(d.promise);
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Webhook'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('https://your-app.com/webhook'), 'https://hook.example.com/x');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    expect(screen.getByText('Testing…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /testing/i })).toBeDisabled();
    d.resolve({ ok: true });
  });

  it('uses a custom channel name when creating the channel', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'x'.repeat(60));
    const nameInput = screen.getByPlaceholderText(/Telegram alerts/i) as HTMLInputElement;
    await user.type(nameInput, 'My Alerts');
    await waitFor(() => expect(nameInput.value).toBe('My Alerts'));
    // Step 3 summary truncates the long target with an ellipsis.
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() =>
      expect(
        screen.getByText((_, el) => (el?.textContent ?? '').startsWith('x'.repeat(40))),
      ).toBeInTheDocument(),
    );
    const target = screen.getByText((_, el) => (el?.textContent ?? '').startsWith('x'.repeat(40)));
    expect(target.textContent).toContain('…');
    // Run the test + create and verify the custom name is sent.
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() =>
      expect(apiMock.api.notifications.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My Alerts' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /create channel/i }));
    // Exactly one create ever; the finish step syncs via PATCH.
    await waitFor(() =>
      expect(apiMock.api.notifications.updateChannel).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'My Alerts' }),
      ),
    );
    expect(apiMock.api.notifications.createChannel).toHaveBeenCalledTimes(1);
  });

  it('submitting the form without a target does not advance', async () => {
    renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(screen.getByPlaceholderText('789123456:AAEx…:987654321')).toBeInTheDocument();
  });

  it('shows the discord confirmation when a discord channel tests ok', async () => {
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Discord'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('https://discord.com/api/webhooks/…'), 'https://discord.com/api/webhooks/abc');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() => expect(screen.getByText('Check your Discord for a test message.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /create channel/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the webhook confirmation when a webhook channel tests ok', async () => {
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('Webhook'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('https://your-app.com/webhook'), 'https://hooks.example.com/x');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() => expect(screen.getByText('Check your Webhook for a test message.')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /create channel/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows "all" in the summary when no events are selected', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByText('Deployments'));
    await user.click(screen.getByText('Services'));
    await user.click(screen.getByText('Alerts'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('all')).toBeInTheDocument();
  });

  it('goes back between steps and hides back on the first step', async () => {
    const user = userEvent.setup();
    renderWizard();
    // The footer "Back" button is the only one whose accessible name is
    // exactly "Back" — step 2 (Events) also renders an event-group card
    // titled "Backups" which matches `/back/i`. Grab the footer button
    // up front while there's exactly one.
    const footerBack = screen.getByRole('button', { name: /^Back$/ });
    expect(footerBack.className).toContain('invisible');
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(footerBack);
    expect(screen.getByPlaceholderText('789123456:AAEx…:987654321')).toBeInTheDocument();
  });

  it('closes via X and the backdrop', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = screen.getByRole('button', { name: 'Close dialog', hidden: true });
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders the success summary with the channel-specific instructions and shows Creating… while pending', async () => {
    let resolveCreate: (v: { id: number; name: string; type: string }) => void = () => {};
    const createPromise = new Promise<{ id: number; name: string; type: string }>((res) => {
      resolveCreate = res;
    });
    // doTest calls createChannel then testChannel — resolve createChannel so
    // testChannel (mocked to resolve) runs and tested flips to 'ok'.
    apiMock.api.notifications.createChannel.mockImplementation(() => createPromise);
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Telegram'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('789123456:AAEx…:987654321'), 'tok:chat');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Run the test: flip tested='ok' → success copy renders.
    await user.click(screen.getByRole('button', { name: /send test/i }));
    expect(screen.getByText('Testing…')).toBeInTheDocument();
    resolveCreate({ id: 1, name: 'ch', type: 'telegram' });
    await waitFor(() => expect(screen.getByText('Test message sent!')).toBeInTheDocument());
    // "Check your Telegram" appears inside a <p> with surrounding sibling
    // text — use a function matcher scoped to the test summary block.
    const matches = screen.getAllByText(
      (_, el) => (el?.textContent ?? '').includes('Check your Telegram'),
    );
    expect(matches.length).toBeGreaterThan(0);
    // The create-button copy flips from "Send test" to "Create channel"
    // (covers the tested === 'ok' branch of the footer button label).
    expect(screen.getByRole('button', { name: /create channel/i })).toBeInTheDocument();
    // Submit create: mock updateChannel with a fresh deferred so we can
    // assert the 'Saving…' label appears while the mutation is pending.
    const savePromise = new Promise<{ id: number; active: boolean }>(() => {});
    apiMock.api.notifications.updateChannel.mockReturnValueOnce(savePromise);
    await user.click(screen.getByRole('button', { name: /create channel/i }));
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  it('shows the slack connect form and creates a slack channel', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Slack'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Create Slack Webhook')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), 'https://hooks.slack.com/services/T/B/x');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() =>
      expect(apiMock.api.notifications.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'slack', target: 'https://hooks.slack.com/services/T/B/x' }),
      ),
    );
    await waitFor(() => expect(screen.getByText('Check your Slack for a test message.')).toBeInTheDocument());
  });

  it('shows the ntfy connect form and creates an ntfy channel', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('ntfy'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('ntfy topic')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('https://ntfy.sh/my-ninedeploy-alerts'), 'https://ntfy.sh/alerts');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() =>
      expect(apiMock.api.notifications.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ntfy', target: 'https://ntfy.sh/alerts' }),
      ),
    );
    await waitFor(() => expect(screen.getByText('Check your ntfy for a test message.')).toBeInTheDocument());
  });

  it('composes an email target as JSON from the SMTP fields', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Email (SMTP)'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('SMTP settings')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('smtp.example.com'), 'smtp.example.com');
    await user.type(screen.getByPlaceholderText('587'), '587');
    await user.type(screen.getByPlaceholderText('ninedeploy@example.com'), 'alerts@example.com');
    await user.type(screen.getByPlaceholderText('you@example.com'), 'ops@example.com');
    const emailInputs = document.querySelectorAll('input');
    await user.type(emailInputs[emailInputs.length - 3] as HTMLInputElement, 'smtp-user');
    await user.type(document.querySelector('input[type="password"]') as HTMLInputElement, 'smtp-secret');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() =>
      expect(apiMock.api.notifications.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email',
          target: JSON.stringify({ host: 'smtp.example.com', port: '587', from: 'alerts@example.com', to: 'ops@example.com', user: 'smtp-user', pass: 'smtp-secret' }),
        }),
      ),
    );
    await waitFor(() => expect(screen.getByText('Check your inbox for a test message.')).toBeInTheDocument());
  });
});
