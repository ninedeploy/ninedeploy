import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineDockerfileCard } from '../src/routes/service/InlineDockerfileCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('InlineDockerfileCard (G1.1)', () => {
  it('saves a pasted Dockerfile for a service without a repository', async () => {
    mockOf(api.services.inlineDockerfile.set).mockResolvedValue({ content: 'FROM busybox\n' } as never);
    renderWithProviders(<InlineDockerfileCard svc={{ id: 5, type: 'docker', image: null, composeContent: null, repoUrl: null } as never} />);
    expect(await screen.findByText(/This service has no repository/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Inline Dockerfile'), { target: { value: 'FROM busybox\n' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.services.inlineDockerfile.set).toHaveBeenCalledWith(5, 'FROM busybox\n'));
  });

  it('is hidden for an image service', () => {
    const { container } = renderWithProviders(<InlineDockerfileCard svc={{ id: 6, type: 'docker', image: 'nginx' } as never} />);
    expect(container.textContent).toBe('');
  });
});
