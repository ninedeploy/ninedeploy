import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/auth.js', async () => (await import('./apiMock.js')).createAuthMock());

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

import { api } from '../src/lib/api.js';
import { AccessGrantsCard, grantTargetLabel } from '../src/components/access/AccessGrantsCard.js';
import { ProjectAccessModal } from '../src/components/access/ProjectAccessModal.js';

const grant = (over: Record<string, unknown> = {}) => ({
  id: 8,
  workspaceId: 1,
  user: { id: 4, email: 'guest@x.test', name: null },
  project: { id: 5, name: 'shop' },
  environment: null,
  role: 'member',
  suspended: false,
  createdAt: '2026-10-08T10:00:00.000Z',
  createdBy: { id: 1, email: 'admin@x.test' },
  isGuest: true,
  ...over,
});

describe('workspace access grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.accessGrants.list).mockResolvedValue([]);
    mockOf(api.projects.list).mockResolvedValue([{ id: 5, name: 'shop' }]);
    mockOf(api.environments.list).mockResolvedValue([
      { id: 9, workspaceId: 1, name: 'production' },
      { id: 10, workspaceId: 2, name: 'elsewhere' },
    ]);
  });

  it('lists grants with guest and suspended badges', async () => {
    mockOf(api.accessGrants.list).mockResolvedValue([
      grant(),
      grant({ id: 9, user: { id: 6, email: 'dev@x.test', name: 'Dev' }, project: null, environment: { id: 9, name: 'production' }, role: 'admin', suspended: true, isGuest: false, createdBy: null }),
    ]);
    renderWithProviders(<AccessGrantsCard workspaceId={1} cap="admin" />);
    expect(await screen.findByText('guest@x.test')).toBeInTheDocument();
    expect(screen.getByText('guest')).toBeInTheDocument();
    expect(screen.getByText('suspended')).toBeInTheDocument();
    expect(screen.getByText(/project shop · granted by admin@x.test/)).toBeInTheDocument();
    expect(screen.getByText(/environment production · suspended by SCIM/)).toBeInTheDocument();
    expect(api.accessGrants.list).toHaveBeenCalledWith(1);
    expect(api.projects.list).toHaveBeenCalledWith('?workspaceId=1');
  });

  it('grants on a project, an environment, or both, with the role capped', async () => {
    mockOf(api.accessGrants.create).mockResolvedValue(grant());
    renderWithProviders(<AccessGrantsCard workspaceId={1} cap="member" />);
    expect(await screen.findByText('No grants yet.')).toBeInTheDocument();
    const roles = within(screen.getByLabelText('Grant role')).getAllByRole('option').map((o) => o.textContent);
    expect(roles).toEqual(['viewer', 'member']);
    const submit = screen.getByRole('button', { name: 'Grant access' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Grant email'), { target: { value: ' guest@x.test ' } });
    await screen.findByRole('option', { name: 'shop' });
    fireEvent.change(screen.getByLabelText('Grant project'), { target: { value: '5' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.accessGrants.create).toHaveBeenCalledWith(1, { email: 'guest@x.test', role: 'member', projectId: 5 }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Access granted', 'success'));

    fireEvent.change(screen.getByLabelText('Grant target'), { target: { value: 'environment' } });
    expect(screen.queryByLabelText('Grant project')).toBeNull();
    const envOptions = within(screen.getByLabelText('Grant environment')).getAllByRole('option').map((o) => o.textContent);
    expect(envOptions).toEqual(['Choose…', 'production']);
    fireEvent.change(screen.getByLabelText('Grant email'), { target: { value: 'b@x.test' } });
    fireEvent.change(screen.getByLabelText('Grant environment'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Grant role'), { target: { value: 'viewer' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.accessGrants.create).toHaveBeenLastCalledWith(1, { email: 'b@x.test', role: 'viewer', environmentId: 9 }));

    fireEvent.change(screen.getByLabelText('Grant target'), { target: { value: 'both' } });
    fireEvent.change(screen.getByLabelText('Grant email'), { target: { value: 'c@x.test' } });
    fireEvent.change(screen.getByLabelText('Grant project'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Grant environment'), { target: { value: '9' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.accessGrants.create).toHaveBeenLastCalledWith(1, { email: 'c@x.test', role: 'viewer', projectId: 5, environmentId: 9 }),
    );
  });

  it('shows a refused grant (the server answers unknown emails like a member add)', async () => {
    mockOf(api.accessGrants.create).mockRejectedValueOnce(new Error('That account cannot be granted access in this workspace')).mockRejectedValueOnce('x');
    renderWithProviders(<AccessGrantsCard workspaceId={1} cap="admin" />);
    fireEvent.change(await screen.findByLabelText('Grant email'), { target: { value: 'nobody@x.test' } });
    await screen.findByRole('option', { name: 'shop' });
    fireEvent.change(screen.getByLabelText('Grant project'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('That account cannot be granted access in this workspace', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not grant access', 'error'));
  });

  it('changes a role and revokes a grant; a grant above the cap is read-only', async () => {
    mockOf(api.accessGrants.list).mockResolvedValue([grant(), grant({ id: 9, user: { id: 6, email: 'boss@x.test', name: null }, role: 'admin' })]);
    mockOf(api.accessGrants.update).mockResolvedValueOnce(grant({ role: 'viewer' })).mockRejectedValueOnce(new Error('grant_exceeds_role'));
    mockOf(api.accessGrants.delete).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('gone'));
    renderWithProviders(<AccessGrantsCard workspaceId={1} cap="member" />);
    const role = await screen.findByLabelText('Role for guest@x.test');
    expect(screen.getByLabelText('Role for boss@x.test')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revoke access for boss@x.test' })).toBeDisabled();
    fireEvent.change(role, { target: { value: 'viewer' } });
    await waitFor(() => expect(api.accessGrants.update).toHaveBeenCalledWith(1, 8, { role: 'viewer' }));
    fireEvent.change(role, { target: { value: 'viewer' } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('grant_exceeds_role', 'error'));

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for guest@x.test' }));
    expect(screen.getByText(/loses the member role on project shop/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.accessGrants.delete).toHaveBeenCalledWith(1, 8));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Access revoked', 'success'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for guest@x.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('gone', 'error'));
  });

  it('shows a load error with retry', async () => {
    mockOf(api.accessGrants.list).mockRejectedValueOnce(new Error('Admin or Owner role required')).mockResolvedValue([]);
    mockOf(api.projects.list).mockResolvedValue(undefined);
    renderWithProviders(<AccessGrantsCard workspaceId={1} cap="admin" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No grants yet.')).toBeInTheDocument();
  });

  it('labels targets', () => {
    expect(grantTargetLabel({ project: { id: 1, name: 'p' }, environment: { id: 2, name: 'e' } })).toBe('project p · environment e');
  });
});

describe('project access view', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists who reaches the project and why', async () => {
    mockOf(api.access.project).mockResolvedValue([
      { user: { id: 1, email: 'op@x.test', name: 'Op' }, role: 'owner', via: ['operator', 'seat'] },
      { user: { id: 4, email: 'guest@x.test', name: null }, role: 'member', via: ['grant'] },
      { user: { id: 5, email: 'maker@x.test', name: null }, role: 'viewer', via: ['creator'] },
    ]);
    const onClose = vi.fn();
    renderWithProviders(<ProjectAccessModal project={{ id: 5, name: 'shop' }} onClose={onClose} />);
    expect(await screen.findByText('Op · op@x.test')).toBeInTheDocument();
    expect(screen.getByText('instance operator')).toBeInTheDocument();
    expect(screen.getByText('access grant')).toBeInTheDocument();
    expect(screen.getByText('creator')).toBeInTheDocument();
    expect(api.access.project).toHaveBeenCalledWith(5);
  });

  it('explains a refusal and other failures', async () => {
    mockOf(api.access.project).mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    const first = renderWithProviders(<ProjectAccessModal project={{ id: 5, name: 'shop' }} onClose={vi.fn()} />);
    expect(await screen.findByText(/Only a project admin can see/)).toBeInTheDocument();
    first.unmount();
    mockOf(api.access.project).mockRejectedValueOnce(new Error('boom'));
    const second = renderWithProviders(<ProjectAccessModal project={{ id: 6, name: 'b' }} onClose={vi.fn()} />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    second.unmount();
    mockOf(api.access.project).mockRejectedValueOnce('weird');
    const third = renderWithProviders(<ProjectAccessModal project={{ id: 7, name: 'c' }} onClose={vi.fn()} />);
    expect(await screen.findByText('Could not load the access list.')).toBeInTheDocument();
    third.unmount();
    mockOf(api.access.project).mockResolvedValueOnce([]);
    renderWithProviders(<ProjectAccessModal project={{ id: 8, name: 'd' }} onClose={vi.fn()} />);
    expect(await screen.findByText(/Nobody besides instance operators/)).toBeInTheDocument();
  });
});
