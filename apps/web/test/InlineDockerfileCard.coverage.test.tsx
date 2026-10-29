import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineDockerfileCard } from '../src/routes/service/InlineDockerfileCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const svc = { id: 5, type: 'docker', image: null, composeContent: null, repoUrl: 'https://github.com/acme/api' } as never;
const STORED = 'FROM node:22-alpine';

describe('InlineDockerfileCard (coverage)', () => {
  beforeEach(() => {
    mockOf(api.services.inlineDockerfile.get).mockReset().mockResolvedValue({ content: STORED } as never);
    mockOf(api.services.inlineDockerfile.set).mockReset();
  });

  it('removes a stored Dockerfile and says the next deploy builds from the repository', async () => {
    mockOf(api.services.inlineDockerfile.set).mockResolvedValue({ content: null } as never);
    renderWithProviders(<InlineDockerfileCard svc={svc} />);
    expect(await screen.findByLabelText('Inline Dockerfile')).toHaveValue(STORED);
    expect(screen.getByText(/instead of the one in the repository/)).toBeInTheDocument();
    // Unchanged text cannot be saved again.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.services.inlineDockerfile.set).toHaveBeenCalledWith(5, null));
    expect(await screen.findByText('Inline Dockerfile removed; the next deploy builds from the repository')).toBeInTheDocument();
    expect(screen.getByLabelText('Inline Dockerfile')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('saves whitespace-only text as a removal', async () => {
    mockOf(api.services.inlineDockerfile.set).mockResolvedValue({ content: null } as never);
    renderWithProviders(<InlineDockerfileCard svc={svc} />);
    const box = await screen.findByLabelText('Inline Dockerfile');
    await userEvent.clear(box);
    await userEvent.type(box, '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.services.inlineDockerfile.set).toHaveBeenCalledWith(5, null));
  });

  it('shows a rejected save as an error toast and keeps the text', async () => {
    mockOf(api.services.inlineDockerfile.set).mockRejectedValue(new Error('Dockerfile is too large'));
    renderWithProviders(<InlineDockerfileCard svc={svc} />);
    const box = await screen.findByLabelText('Inline Dockerfile');
    await userEvent.type(box, ' AS base');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Dockerfile is too large')).toBeInTheDocument();
    expect(api.services.inlineDockerfile.set).toHaveBeenCalledWith(5, 'FROM node:22-alpine AS base');
    expect(box).toHaveValue('FROM node:22-alpine AS base');
  });
});
