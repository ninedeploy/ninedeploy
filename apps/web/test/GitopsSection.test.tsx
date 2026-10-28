import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitopsSection } from '../src/routes/settings/GitopsSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const CONFIG = { enabled: true, repoUrl: 'https://github.com/acme/instance', branch: 'main', path: 'ninedeploy-instance.yaml', sourceId: null, intervalMinutes: 15 };

describe('GitopsSection (G5.3)', () => {
  it('shows the drift of the last check and applies the file', async () => {
    mockOf(api.sources.list).mockResolvedValue([] as never);
    mockOf(api.gitops.get).mockResolvedValue({
      config: CONFIG,
      lastCheck: {
        at: '2026-10-28T10:00:00Z',
        commit: 'abc1234def',
        error: null,
        drift: [
          { kind: 'service', key: 'shop/api', change: 'changed', fields: [{ field: 'image', desired: 'nginx:1.27', actual: 'nginx:1.26' }] },
          { kind: 'project', key: 'legacy', change: 'extra' },
        ],
      },
    } as never);
    mockOf(api.gitops.apply).mockResolvedValue({
      steps: [{ item: 'update service shop/api', ok: true }],
      check: { at: '2026-10-28T10:01:00Z', commit: 'abc1234def', error: null, drift: [{ kind: 'project', key: 'legacy', change: 'extra' }] },
    } as never);
    renderWithProviders(<GitopsSection />);
    expect(await screen.findByText('2 difference(s)')).toBeTruthy();
    expect(screen.getByText('image: nginx:1.26 → nginx:1.27')).toBeTruthy();
    expect((screen.getByDisplayValue(CONFIG.repoUrl) as HTMLInputElement).value).toBe(CONFIG.repoUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Apply the file' }));
    await waitFor(() => expect(api.gitops.apply).toHaveBeenCalled());
    expect(await screen.findByText(/update service shop\/api/)).toBeTruthy();
    // Only an extra item is left: there is nothing to apply.
    expect(screen.queryByRole('button', { name: 'Apply the file' })).toBeNull();
  });

  it('shows why the file could not be read', async () => {
    mockOf(api.gitops.get).mockResolvedValue({ config: CONFIG, lastCheck: { at: '2026-10-28T10:00:00Z', commit: null, error: 'ninedeploy-instance.yaml is not in the repository on main', drift: [] } } as never);
    renderWithProviders(<GitopsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('not in the repository');
  });
});
