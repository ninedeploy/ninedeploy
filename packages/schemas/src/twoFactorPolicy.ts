import { z } from 'zod';

// ── Workspace-enforced 2FA (G1.4) ──────────────────────────────────────────
// A workspace can require TOTP or a passkey of every member; a member without
// one is held to the enrolment routes until they set one up.

/** `PUT /v1/workspaces/:id/two-factor`. */
export const workspaceTwoFactorInput = z
  .object({
    required: z.boolean(),
    /** Sessions from an SSO sign-in are exempt (the IdP enforces MFA). */
    ssoExempt: z.boolean().default(false),
  })
  .strict();
export type WorkspaceTwoFactorInput = z.infer<typeof workspaceTwoFactorInput>;

export interface WorkspaceTwoFactorView {
  required: boolean;
  ssoExempt: boolean;
  /** Members (of this workspace) without TOTP or a passkey. */
  membersWithout: number;
}

/** `GET /v1/auth/2fa/requirement`: what the workspace policies ask of this session. */
export interface TwoFactorRequirementView {
  required: boolean;
  enrolled: boolean;
  workspaces: Array<{ id: number; name: string }>;
}
