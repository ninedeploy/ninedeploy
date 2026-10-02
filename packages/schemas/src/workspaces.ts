import { z } from 'zod';
import { slug } from './common.js';

export const workspaceRoleEnum = z.enum(['owner', 'admin', 'member', 'viewer']);
export type WorkspaceRole = z.infer<typeof workspaceRoleEnum>;

/** Roles that may be GRANTED directly when adding a member or creating an
 *  invitation. 'owner' is deliberately excluded: the PATCH member route is
 *  the only place that performs the full ownership transfer (demote the
 *  current owner, re-key `workspaces.ownerId`) — an owner-rank row inserted
 *  through add/invite would mint owner authority without that bookkeeping. */
export const assignableWorkspaceRoleEnum = z.enum(['admin', 'member', 'viewer']);
export type AssignableWorkspaceRole = z.infer<typeof assignableWorkspaceRoleEnum>;

export const workspaceCreate = z.object({
  name: z.string().trim().min(2).max(63),
  slug: slug.optional(),
  description: z.string().trim().max(500).optional(),
});
export type WorkspaceCreate = z.infer<typeof workspaceCreate>;
export type WorkspaceCreateInput = WorkspaceCreate;

export const workspaceUpdate = z
  .object({
    name: z.string().trim().min(2).max(63).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type WorkspaceUpdate = z.infer<typeof workspaceUpdate>;
export type WorkspaceUpdateInput = WorkspaceUpdate;

export const workspaceMemberAdd = z.object({
  email: z.string().email(),
  role: assignableWorkspaceRoleEnum.default('member'),
});
export type WorkspaceMemberAdd = z.infer<typeof workspaceMemberAdd>;
export type WorkspaceMemberAddInput = WorkspaceMemberAdd;

export const workspaceMemberRoleUpdate = z.object({
  role: workspaceRoleEnum,
});
export type WorkspaceMemberRoleUpdate = z.infer<typeof workspaceMemberRoleUpdate>;
export type WorkspaceMemberRoleUpdateInput = WorkspaceMemberRoleUpdate;

export interface WorkspaceMemberEntry {
  id: number;
  workspaceId: number;
  userId: number;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  createdAt: string;
}

/**
 * Response from POST /v1/workspaces/:id/members when the address is NOT a
 * registered user yet. The server creates a pending invitation and returns
 * the accept URL (also emailed when an SMTP channel is configured).
 */
export interface WorkspaceMemberInviteEntry {
  kind: 'invitation';
  id: number;
  workspaceId: number;
  email: string;
  role: WorkspaceRole;
  acceptUrl: string;
  expiresAt: string;
  createdAt: string;
}

export interface WorkspaceEntry {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  ownerId: number;
  myRole: WorkspaceRole;
  memberCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}
export type Workspace = WorkspaceEntry;

export interface WorkspaceDetail extends WorkspaceEntry {
  members: WorkspaceMemberEntry[];
}

// ─── Workspace Invitations ──────────────────────────────────────────────────
// A pending invite lets an owner/admin onboard an address that may or may not
// have a `users` row yet. While the row is outstanding, the only way the
// address becomes a workspace member is by visiting the accept URL (or by
// being promoted by an auto-accept hook on first login / OIDC).
export const workspaceInvitationCreate = z.object({
  email: z.string().email().max(254),
  role: assignableWorkspaceRoleEnum.default('member'),
});
export type WorkspaceInvitationCreate = z.infer<typeof workspaceInvitationCreate>;
export type WorkspaceInvitationCreateInput = WorkspaceInvitationCreate;

export interface WorkspaceInvitationEntry {
  id: number;
  workspaceId: number;
  email: string;
  role: WorkspaceRole;
  invitedByUserId: number;
  invitedByName: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByUserId: number | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Public view of an invitation (token is only returned once at create time). */
export interface WorkspaceInvitationPublic {
  workspaceId: number;
  workspaceName: string;
  workspaceSlug: string;
  email: string;
  role: WorkspaceRole;
  invitedByName: string | null;
  expiresAt: string;
}

// ─── OIDC & OAuth2 SSO Schemas ───────────────────────────────────────────────
/**
 * r507: one allowed email domain for an SSO provider (`corp.com`; a leading
 * `@` is tolerated and dropped). Matching is exact — list subdomains you mean.
 */
export const oidcAllowedDomain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .min(3)
      .max(253)
      .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, 'must be a domain like corp.com'),
  );
const oidcAllowedDomains = z.array(oidcAllowedDomain).max(50);

export const oidcProviderCreate = z.object({
  name: z.string().trim().min(2).max(63),
  slug: slug,
  issuerUrl: z.string().url().nullable().optional(),
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().trim().min(1).max(500),
  scopes: z.string().trim().default('openid profile email'),
  enabled: z.boolean().default(true),
  autoEnroll: z.boolean().default(true),
  defaultRole: z.enum(['admin', 'member']).default('member'),
  /** r507: empty (the default) = any verified email the IdP vouches for. */
  allowedDomains: oidcAllowedDomains.optional(),
});
export type OidcProviderCreate = z.infer<typeof oidcProviderCreate>;
export type OidcProviderCreateInput = OidcProviderCreate;

export const oidcProviderUpdate = z
  .object({
    name: z.string().trim().min(2).max(63).optional(),
    issuerUrl: z.string().url().nullable().optional(),
    clientId: z.string().trim().min(1).max(255).optional(),
    clientSecret: z.string().trim().min(1).max(500).optional(),
    scopes: z.string().trim().optional(),
    enabled: z.boolean().optional(),
    autoEnroll: z.boolean().optional(),
    defaultRole: z.enum(['admin', 'member']).optional(),
    allowedDomains: oidcAllowedDomains.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type OidcProviderUpdate = z.infer<typeof oidcProviderUpdate>;
export type OidcProviderUpdateInput = OidcProviderUpdate;

export interface OidcProviderEntry {
  id: number;
  name: string;
  slug: string;
  issuerUrl: string | null;
  clientId: string;
  scopes: string;
  enabled: boolean;
  autoEnroll: boolean;
  defaultRole: 'admin' | 'member';
  /** r507: email domains allowed to sign in / enroll; empty = unrestricted. */
  allowedDomains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OidcPublicProvider {
  id: number;
  name: string;
  slug: string;
  authUrl: string;
}
