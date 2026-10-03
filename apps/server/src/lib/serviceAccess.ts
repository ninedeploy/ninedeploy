/**
 * Service access helpers.
 *
 * The implementation moved to `resourceAccess.ts`, which is now the single
 * authorization choke-point for every resource kind (service, project,
 * database). This module re-exports the service-specific helpers so existing
 * call sites keep working; prefer importing from `resourceAccess.js` in new
 * code.
 */
export {
  assertCanManageService,
  loadServiceForUser,
  type AuthedUser,
} from './resourceAccess.js';
