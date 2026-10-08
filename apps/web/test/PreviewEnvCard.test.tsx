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

import { EnvCard } from '../src/components/EnvCard.js';
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
});
