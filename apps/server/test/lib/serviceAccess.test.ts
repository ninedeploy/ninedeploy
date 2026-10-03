import { describe, expect, it } from 'vitest';
import { assertCanManageService, loadServiceForUser } from '../../src/lib/serviceAccess.js';

function makeDb(opts: { service: unknown; workspaceTags?: Array<{ workspaceId: number }>; memberships?: Array<{ workspaceId: number }> }) {
  return {
    query: {
      services: { findFirst: async () => opts.service },
      serviceWorkspaces: { findMany: async () => opts.workspaceTags ?? [] },
      workspaceMembers: { findMany: async () => opts.memberships ?? [] },
    },
  };
}

describe('serviceAccess', () => {
  describe('assertCanManageService', () => {
    it('allows operators to manage any service', () => {
      expect(() =>
        assertCanManageService({ ownerUserId: 99 }, { id: 1, isOperator: true }),
      ).not.toThrow();
    });

    it('allows owners to manage their own service', () => {
      expect(() =>
        assertCanManageService({ ownerUserId: 5 }, { id: 5, isOperator: false }),
      ).not.toThrow();
    });

    it('throws forbidden when member does not own the service', () => {
      expect(() =>
        assertCanManageService({ ownerUserId: 10 }, { id: 5, isOperator: false }),
      ).toThrow('You do not have access to this service');
    });

    it('defers to the loader when service owner is null for non-operator', () => {
      // An unowned service is NOT defensively blocked here — `loadServiceForUser`
      // is the single source of truth and will 404 for non-operators. This
      // helper is only a fast-path for already-validated rows.
      expect(() =>
        assertCanManageService({ ownerUserId: null as never }, { id: 5, isOperator: false }),
      ).not.toThrow();
    });
  });

  describe('loadServiceForUser', () => {
    it('loads service for operator when it exists', async () => {
      // The "operator" status is verified by querying workspace_members for
      // owner/admin seats. The mock below returns an owner seat so
      // `isOperator(db, user)` returns true.
      const db = makeDb({
        service: { id: 1, name: 'web', ownerUserId: 2 },
        memberships: [{ workspaceId: 1, role: 'owner' }],
      });
      const svc = await loadServiceForUser(db as never, 1, { id: 99, isOperator: true });
      expect(svc).toEqual({ id: 1, name: 'web', ownerUserId: 2 });
    });

    it('throws notFound for operator when service does not exist', async () => {
      const db = makeDb({ service: null });
      await expect(
        loadServiceForUser(db as never, 999, { id: 1, isOperator: true }),
      ).rejects.toThrow('Service not found');
    });

    it('loads service for member when member owns it', async () => {
      const db = makeDb({ service: { id: 2, name: 'api', ownerUserId: 5 } });
      const svc = await loadServiceForUser(db as never, 2, { id: 5, isOperator: false });
      expect(svc).toEqual({ id: 2, name: 'api', ownerUserId: 5 });
    });

    it('throws notFound for member when service is owned by someone else', async () => {
      const db = makeDb({ service: { id: 2, name: 'api', ownerUserId: 10 } });
      await expect(
        loadServiceForUser(db as never, 2, { id: 5, isOperator: false }),
      ).rejects.toThrow('Service not found');
    });

    it('throws notFound for member when service does not exist', async () => {
      const db = makeDb({ service: null });
      await expect(
        loadServiceForUser(db as never, 999, { id: 5, isOperator: false }),
      ).rejects.toThrow('Service not found');
    });

    it('loads a service tagged into a workspace the member belongs to', async () => {
      const db = makeDb({
        service: { id: 3, name: 'shared', ownerUserId: 99 },
        workspaceTags: [{ workspaceId: 7 }],
        memberships: [{ workspaceId: 7 }],
      });
      const svc = await loadServiceForUser(db as never, 3, { id: 5, isOperator: false });
      expect(svc).toEqual({ id: 3, name: 'shared', ownerUserId: 99 });
    });
  });
});
