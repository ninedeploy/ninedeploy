import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, createQueryClient } from './web-utils.js';
import { mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());

import { api } from '../src/lib/api.js';
import { ToastProvider } from '../src/components/Toast.js';
import { EmailTemplatesCard } from '../src/routes/workspaces/EmailTemplatesCard.js';

const render = () =>
  renderWithProviders(<EmailTemplatesCard workspaceId={5} />, { queryClient: createQueryClient(), wrapper: (c) => <ToastProvider>{c}</ToastProvider> });

const templates = [
  { name: 'password-reset', scope: 'instance', sent: true, overridden: false, subject: null, text: null },
  { name: 'workspace-invitation', scope: 'workspace', sent: true, overridden: true, subject: 'Join us', text: 'Hi {{acceptUrl}}' },
  { name: 'backup-drill-failed', scope: 'workspace', sent: false, overridden: false, subject: null, text: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.emailTemplates.list).mockResolvedValue({ workspaceId: 5, templates } as never);
});

// G1.5: the first web control for the G-30 email template routes.
describe('EmailTemplatesCard', () => {
  it('lists templates with their state; an account email has no editor', async () => {
    render();
    expect(await screen.findByText('Password reset')).toBeInTheDocument();
    expect(screen.getByText('About the account: always sent with the built-in text')).toBeInTheDocument();
    expect(screen.getByText('customised')).toBeInTheDocument();
    expect(screen.getByText('not sent yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
  });

  it('edits, previews and saves an override', async () => {
    mockOf(api.emailTemplates.set).mockResolvedValue({ ok: true });
    mockOf(api.emailTemplates.preview).mockResolvedValue({ subject: 'Join us', text: 'Hi https://x/accept', overridden: true });
    render();
    await screen.findByText('Workspace invitation');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    expect(screen.getByLabelText('Subject')).toHaveValue('Join us');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(api.emailTemplates.preview).toHaveBeenCalledWith(5, 'workspace-invitation'));
    expect(await screen.findByTestId('email-preview')).toHaveTextContent('Hi https://x/accept');
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Welcome' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.emailTemplates.set).toHaveBeenCalledWith(5, 'workspace-invitation', 'Welcome', 'Hi {{acceptUrl}}'));
    expect(await screen.findByText('Template saved')).toBeInTheDocument();
  });

  it('resets an override and shows a refused save', async () => {
    mockOf(api.emailTemplates.reset).mockResolvedValue({ ok: true });
    mockOf(api.emailTemplates.set).mockRejectedValue(new Error('The email text must include {{acceptUrl}}'));
    render();
    await screen.findByText('Workspace invitation');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'no link' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The email text must include {{acceptUrl}}')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to built-in' }));
    await waitFor(() => expect(api.emailTemplates.reset).toHaveBeenCalledWith(5, 'workspace-invitation'));
    expect(await screen.findByText('Template reset to the built-in text')).toBeInTheDocument();
  });

  it('needs both fields for a template that uses the built-in text', async () => {
    render();
    await screen.findByText('Backup check failed');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    expect(screen.getByText(/uses the built-in text/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reset to built-in' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByLabelText('Subject')).toBeNull();
  });

  it('shows a load error', async () => {
    mockOf(api.emailTemplates.list).mockRejectedValue(new Error('nope'));
    render();
    expect(await screen.findByText('Could not load the email templates')).toBeInTheDocument();
  });
});
