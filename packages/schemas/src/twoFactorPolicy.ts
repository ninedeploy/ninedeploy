import { z } from 'zod';

// ── Workspace-enforced 2FA (G1.4) ──────────────────────────────────────────
// A workspace can require every member's session to prove a second factor
// (TOTP, a recovery code or a passkey); other sessions are held to enrolment.

/** An SSO provider a workspace trusts to enforce MFA: `oidc:<id>` (Settings → SSO) or `sso:<id>`. */
export const ssoProviderRef = z.string().regex(/^(oidc|sso):\d{1,10}$/);

/** `PUT /v1/workspaces/:id/two-factor`. */
export const workspaceTwoFactorInput = z
  .object({
    required: z.boolean(),
    /** Sessions signed in through these providers are exempt (the IdP enforces MFA). GitHub sign-ins never are. */
    ssoExemptProviders: z.array(ssoProviderRef).max(20).default([]),
  })
  .strict();
export type WorkspaceTwoFactorInput = z.input<typeof workspaceTwoFactorInput>;

export interface WorkspaceTwoFactorView {
  required: boolean;
  ssoExemptProviders: string[];
  /** Members (of this workspace) without TOTP or a passkey. */
  membersWithout: number;
}

/** `GET /v1/auth/2fa/requirement`: what the workspace policies ask of this session. */
export interface TwoFactorRequirementView {
  required: boolean;
  /** The account has TOTP or a passkey. */
  enrolled: boolean;
  /** This session proved a second factor when it signed in. */
  verified: boolean;
  workspaces: Array<{ id: number; name: string }>;
}
