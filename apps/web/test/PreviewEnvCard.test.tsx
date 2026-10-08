import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, renderWithProviders } from './web-utils.js';

// 0.12 preview-only env: the Environment tab's "Preview deployments" card.
const apiMock = vi.hoisted(() => ({
  api: {
    env: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    previewEnv: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    attachments: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    webhooks: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    jobs: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), run: vi.fn() },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

const formatMock = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('../src/lib/format.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/format.js')>()),
  downloadBlob: formatMock.downloadBlob,
}));

import { EnvCard } from '../src/components/EnvCard.js';
import { ToastProvider } from '../src/components/Toast.js';
import { EnvironmentTab } from '../src/routes/service/EnvironmentTab.js';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.api.env.list.mockResolvedValue([{ id: 1, key: 'API_URL', value: 'https://api.example.com', isSecret: false }]);
  apiMock.api.previewEnv.list.mockResolvedValue([{ id: 9, key: 'STRIPE_KEY', value: '', isSecret: true }]);
  apiMock.api.previewEnv.create.mockResolvedValue({ id: 10, key: 'API_URL', value: 'https://staging.example.com', isSecret: false });
  apiMock.api.attachments.list.mockResolvedValue([]);
  apiMock.api.webhooks.list.mockResolvedValue([]);
  apiMock.api.jobs.list.mockResolvedValue([]);
});

const GIT = { type: 'docker', repoUrl: 'https://github.com/acme/web.git', previewDeploymentsEnabled: true };

describe('Environment tab — preview deployments section (0.12)', () => {
  it('shows the section for a git-backed service, with the no-secrets explanation', async () => {
    renderWithProviders(<EnvironmentTab serviceId={7} svc={GIT} />, { queryClient: createQueryClient() });
    expect(await screen.findByText('Preview deployments')).toBeInTheDocument();
    expect(screen.getByText(/Previews never receive this service.s secrets/)).toBeInTheDocument();
    expect(await screen.findByText('STRIPE_KEY')).toBeInTheDocument();
    expect(apiMock.api.previewEnv.list).toHaveBeenCalledWith(7);
    // Previews are on: no "turn them on" hint.
    expect(screen.queryByText(/PR previews are off/)).toBeNull();
  });

  it('hides it for an image-only service and for a preview itself', async () => {
    const { unmount } = renderWithProviders(<EnvironmentTab serviceId={7} svc={{ type: 'docker', repoUrl: null }} />, {
      queryClient: createQueryClient(),
    });
    expect(await screen.findByText('API_URL')).toBeInTheDocument();
    expect(screen.queryByText('Preview deployments')).toBeNull();
    unmount();

    renderWithProviders(<EnvironmentTab serviceId={8} svc={{ ...GIT, isEphemeralPreview: true }} />, { queryClient: createQueryClient() });
    expect(await screen.findByText('API_URL')).toBeInTheDocument();
    expect(screen.queryByText('Preview deployments')).toBeNull();
    expect(apiMock.api.previewEnv.list).not.toHaveBeenCalled();
  });

  it('says when previews are off for the service', async () => {
    renderWithProviders(<EnvironmentTab serviceId={7} svc={{ ...GIT, previewDeploymentsEnabled: false }} />, { queryClient: createQueryClient() });
    expect(await screen.findByText(/PR previews are off for this service/)).toBeInTheDocument();
  });

  it('writes through the preview-only API, never the production env', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EnvCard serviceId={7} variant="preview" />, { queryClient: createQueryClient() });
    await screen.findByText('STRIPE_KEY');
    await act(async () => {
      await user.type(screen.getByPlaceholderText('KEY'), 'API_URL');
      await user.type(screen.getByPlaceholderText('value'), 'https://staging.example.com');
    });
    await act(async () => {
      fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    });
    await waitFor(() =>
      expect(apiMock.api.previewEnv.create).toHaveBeenCalledWith(7, { key: 'API_URL', value: 'https://staging.example.com', isSecret: false }),
    );
    fireEvent.click(screen.getByTitle('Delete'));
    await waitFor(() => expect(apiMock.api.previewEnv.remove).toHaveBeenCalledWith(7, 9));
    expect(apiMock.api.env.list).not.toHaveBeenCalled();
    expect(apiMock.api.env.create).not.toHaveBeenCalled();
    expect(apiMock.api.env.remove).not.toHaveBeenCalled();
  });

  it('downloads only non-secret preview values as .env.preview', async () => {
    apiMock.api.previewEnv.list.mockResolvedValue([
      { id: 9, key: 'STRIPE_KEY', value: '', isSecret: true },
      { id: 11, key: 'API_URL', value: 'https://staging.example.com', isSecret: false },
    ]);
    renderWithProviders(<EnvCard serviceId={7} variant="preview" />, { queryClient: createQueryClient() });
    await screen.findByText('API_URL');
    fireEvent.click(screen.getByTitle('Download non-secret env vars as a .env file'));
    expect(formatMock.downloadBlob).toHaveBeenCalledWith('API_URL=https://staging.example.com\n', '.env.preview', 'text/plain');
  });

  it('leaves the raw editor with Cancel and reports a failed delete', async () => {
    apiMock.api.previewEnv.remove.mockRejectedValue(new Error('boom'));
    renderWithProviders(<EnvCard serviceId={7} variant="preview" />, {
      queryClient: createQueryClient(),
      wrapper: (c) => <ToastProvider>{c}</ToastProvider>,
    });
    await screen.findByText('STRIPE_KEY');

    fireEvent.click(screen.getByTitle('Paste or edit the whole .env file as text'));
    expect(screen.getByLabelText('Raw .env content')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Raw .env content')).toBeNull();

    fireEvent.click(screen.getByTitle('Delete'));
    expect(await screen.findByText('Could not delete the variable')).toBeInTheDocument();
    expect(apiMock.api.previewEnv.remove).toHaveBeenCalledWith(7, 9);
  });
});
