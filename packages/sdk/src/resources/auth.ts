// Client surface: auth, workspaces, users, scim, sso, accessGrants, access.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  ActiveSession,
  ApiToken,
  PasskeyCredential,
  CreateApiTokenInput,
  CreatedApiToken,
  Login,
  PasswordChange,
  PasswordChangeResult,
  PasswordReset,
  PublicUser,
  Refresh,
  Register,
  Session,
  UserCreate,
  WorkspaceEntry,
  WorkspaceDetail,
  WorkspaceCreateInput,
  WorkspaceUpdateInput,
  WorkspaceMemberEntry,
  WorkspaceMemberInviteEntry,
  WorkspaceMemberAddInput,
  WorkspaceMemberRoleUpdateInput,
  OidcPublicProvider,
  WorkspaceInvitationEntry,
  WorkspaceInvitationPublic,
  WorkspaceRole,
  OidcProviderEntry,
  OidcProviderCreateInput,
  OidcProviderUpdateInput,
  AccessGrant,
  AccessGrantCreate,
  AccessGrantListQuery,
  AccessGrantUpdate,
  AccessMe,
  ProjectAccessEntry,
} from '@ninedeploy/schemas';
import { apiGetUrl } from '../apiPath.js';
import type { TokenIntrospection } from '../types.js';
import type { Transport } from '../transport.js';

export interface AuthApi {
  auth: {
    status: () => Promise<{ initialized: boolean }>;
    /**
     * Introspect the current bearer token. Returns the
     * token's id (when opaque), name, scopes, expiry and
     * the operator flag. Interactive sessions (JWT) report
     * `scopes: ['session']`. The MCP server uses this to
     * discover the token's authority before registering
     * tools.
     */
    introspectToken: () => Promise<TokenIntrospection>;
    setup: (input: Register) => Promise<Session>;
    register: (input: Register) => Promise<Session>;
    login: (input: Login) => Promise<Session>;
    refresh: (input: Refresh) => Promise<Session>;
    logout: () => Promise<{ ok: boolean }>;
    /** Self-service password change; revokes other sessions, returns a fresh token pair
     *  and (r603) how many passkeys still sign in to the account. */
    changePassword: (input: PasswordChange) => Promise<PasswordChangeResult>;
    /** Request a reset link (always 200 — no user enumeration). */
    forgotPassword: (email: string) => Promise<{ ok: boolean }>;
    /** Complete a reset with a single-use token; revokes all sessions. */
    resetPasswordWithToken: (input: { token: string; newPassword: string }) => Promise<{ ok: boolean }>;
    twoFactor: {
      /**
       * Generate a pending secret + otpauth URI (auth required). Since 0.10.36
       * (r502) the server wants step-up proof: the current password, or a
       * sign-in from the last 10 minutes (else 403 `reauth_required`).
       */
      setup: (input?: { password: string }) => Promise<{ secret: string; otpauthUri: string }>;
      /** Turn 2FA on. `password` is the r502 step-up proof (see `setup`). */
      enable: (code: string, password?: string) => Promise<{ ok: boolean; totpEnabled: boolean }>;
      disable: (input: { password: string; code: string }) => Promise<{ ok: boolean; totpEnabled: boolean }>;
    };
    me: () => Promise<PublicUser>;
    tokens: {
      create: (input?: CreateApiTokenInput) => Promise<CreatedApiToken>;
      list: () => Promise<ApiToken[]>;
      remove: (id: number) => Promise<void>;
    };
    passkeys: {
      /**
       * Start a registration ceremony (returns JSON options for the browser
       * API). Since 0.10.36 (r502) registration needs step-up proof: the
       * current password, or a sign-in from the last 10 minutes (else 403
       * `reauth_required`).
       */
      registerOptions: (input?: { password?: string }) => Promise<{ options: string }>;
      /** Complete registration: verify the browser response, store the credential. */
      registerVerify: (input: { name: string; response: unknown; password?: string }) => Promise<PasskeyCredential>;
      list: () => Promise<PasskeyCredential[]>;
      remove: (id: number) => Promise<void>;
      /** Start a passwordless login ceremony (discoverable credentials). */
      loginOptions: () => Promise<{ options: string }>;
      /** Complete passkey login — returns a full session on success. */
      loginVerify: (response: unknown) => Promise<Session>;
    };
    sessions: {
      list: () => Promise<ActiveSession[]>;
      revoke: (id: number) => Promise<{ ok: boolean }>;
    };
    oidc: {
      publicProviders: () => Promise<OidcPublicProvider[]>;
      link: (slug: string) => Promise<{ authUrl: string }>;
      listProviders: () => Promise<OidcProviderEntry[]>;
      list: () => Promise<OidcProviderEntry[]>;
      createProvider: (input: OidcProviderCreateInput) => Promise<OidcProviderEntry>;
      create: (input: OidcProviderCreateInput) => Promise<OidcProviderEntry>;
      updateProvider: (id: number, input: OidcProviderUpdateInput) => Promise<OidcProviderEntry>;
      update: (id: number, input: OidcProviderUpdateInput) => Promise<OidcProviderEntry>;
      deleteProvider: (id: number) => Promise<{ ok: boolean }>;
      delete: (id: number) => Promise<{ ok: boolean }>;
      callback: (slug: string, payload: { code: string; state: string }) => Promise<Session>;
    };
  };
  workspaces: {
    list: () => Promise<WorkspaceEntry[]>;
    get: (id: number) => Promise<WorkspaceDetail>;
    create: (input: WorkspaceCreateInput) => Promise<WorkspaceEntry>;
    update: (id: number, input: WorkspaceUpdateInput) => Promise<WorkspaceEntry>;
    delete: (id: number) => Promise<{ ok: boolean }>;
    /**
     * Add a member by email. r604: only an instance operator gets a direct
     * add (a `WorkspaceMemberEntry`) for a registered address; for everyone
     * else the answer is always an invitation (`kind: 'invitation'`), so the
     * response does not reveal whether the address has an account.
     */
    addMember: (id: number, input: WorkspaceMemberAddInput) => Promise<WorkspaceMemberEntry | WorkspaceMemberInviteEntry>;
    /**
     * Create a pending invitation for an email address that is not a member of
     * the workspace yet (r604: registered or not).
     * r334: the response is the invitation row only — the server does NOT
     * return an `acceptUrl` here (the token travels in the `x-invitation-token`
     * response header and in the invite email). `addMember` returns the accept
     * link in its body for the same case.
     */
    inviteMember: (id: number, input: WorkspaceMemberAddInput) => Promise<WorkspaceInvitationEntry>;
    listInvitations: (id: number) => Promise<WorkspaceInvitationEntry[]>;
    revokeInvitation: (id: number, inviteId: number) => Promise<{ ok: boolean }>;
    /** Look up a pending invitation by its public token (no auth required). */
    previewInvitation: (token: string) => Promise<WorkspaceInvitationPublic>;
    /** Accept an invitation as the currently authenticated user. */
    acceptInvitation: (token: string) => Promise<{ ok: boolean; workspaceId: number; role: WorkspaceRole }>;
    updateMemberRole: (id: number, memberId: number, input: WorkspaceMemberRoleUpdateInput) => Promise<WorkspaceMemberEntry>;
    removeMember: (id: number, memberId: number) => Promise<{ ok: boolean }>;
  };
  users: {
    list: () => Promise<PublicUser[]>;
    /**
     * Operator-only: create a user directly (no registration flow needed).
     * The new account has no workspace memberships — an existing owner/admin
     * must invite it into at least one workspace before it can act.
     */
    create: (input: UserCreate) => Promise<PublicUser>;
    /**
     * Operator-only: delete a user. The `users.role` column was removed when
     * authorization became workspace-only; the legacy `setRole` is gone with
     * it. Role changes go through `workspaces.updateMemberRole`.
     * Workspaces the user owns are transferred, not deleted: to the caller,
     * or to `opts.transferTo` (an existing, active user id).
     */
    remove: (id: number, opts?: { transferTo?: number }) => Promise<void>;
    /** Operator reset of another user's password (revokes their sessions). */
    resetPassword: (id: number, input: PasswordReset) => Promise<{ ok: boolean }>;
    /** Mint a one-time reset link for a user (returned exactly once). */
    resetLink: (id: number) => Promise<{ url: string; expiresAt: string }>;
    /**
     * Operator-only: grant or revoke the INSTANCE-operator flag.
     *
     * Not a workspace role — this is the flag that gates operator-only routes
     * and the host-privilege boundary (PM2/compose deploys, lifecycle hooks,
     * docker-socket templates). Creating a workspace does NOT confer it. The
     * last remaining operator cannot be demoted.
     */
    setOperator: (id: number, isOperator: boolean) => Promise<{ ok: boolean; id: number; isOperator: boolean }>;
  };
  scim: {
    /** SCIM 2.0 provisioning tokens (operator-managed). */
    listTokens: () => Promise<Array<{ id: number; name: string; workspaceId: number; createdAt: string | null; lastUsedAt: string | null; revoked: boolean }>>;
    /** The plaintext token is returned exactly once — only its sha256 persists. */
    createToken: (input: { name: string; workspaceId: number }) => Promise<{ id: number; token: string }>;
    revokeToken: (id: number) => Promise<{ ok: boolean }>;
  };
  sso: {
    /** Every configured OIDC / SAML provider. G-22. */
    listProviders: () => Promise<{
      providers: Array<{ id: number; type: 'oidc' | 'saml'; name: string; createdAt: string }>;
    }>;
    /** Add a provider (OIDC issuer URL or SAML metadata URL lives in `config`). */
    addProvider: (input: {
      type: 'oidc' | 'saml';
      name: string;
      config: Record<string, unknown>;
    }) => Promise<{ ok: boolean; id?: number; name?: string; type?: 'oidc' | 'saml'; error?: string }>;
    /** Remove a provider by id. */
    removeProvider: (id: number) => Promise<{ ok: boolean }>;
  };
  /** Project and environment access grants (0.15, raise-only). Workspace admin floor. */
  accessGrants: {
    list: (workspaceId: number, query?: Partial<AccessGrantListQuery>) => Promise<AccessGrant[]>;
    create: (workspaceId: number, input: AccessGrantCreate) => Promise<AccessGrant>;
    /**
     * Change the role, suspend (`suspended: true`) or reinstate
     * (`suspended: false`), or both. A grant the user's identity provider
     * suspended cannot be reinstated here (409 `grant_suspended_by_idp`).
     */
    update: (workspaceId: number, grantId: number, input: AccessGrantUpdate) => Promise<AccessGrant>;
    delete: (workspaceId: number, grantId: number) => Promise<{ ok: boolean }>;
  };
  access: {
    /** The caller's own grants and the workspaces reached only through them. */
    me: () => Promise<AccessMe>;
    /** Who reaches a project and how (project admin). */
    project: (projectId: number) => Promise<ProjectAccessEntry[]>;
  };
}

export function authApi(t: Transport): AuthApi {
  const { get, send, request } = t;
  return {
    auth: {
      status: () => get<{ initialized: boolean }>('/v1/auth/status'),
      introspectToken: () => get<TokenIntrospection>('/v1/auth/token'),
      setup: (input) => send<Session>('POST', '/v1/setup', input),
      register: (input) => send<Session>('POST', '/v1/auth/register', input),
      login: (input) => send<Session>('POST', '/v1/auth/login', input),
      refresh: (input) => send<Session>('POST', '/v1/auth/refresh', input),
      /** Revoke this user's outstanding JWTs server-side (tokenVersion bump). */
      logout: () => send<{ ok: boolean }>('POST', '/v1/auth/logout', {}),
      changePassword: (input) => send<PasswordChangeResult>('POST', '/v1/auth/password', input),
      forgotPassword: (email) => send<{ ok: boolean }>('POST', '/v1/auth/forgot-password', { email }),
      resetPasswordWithToken: (input) => send<{ ok: boolean }>('POST', '/v1/auth/reset-password', input),
      twoFactor: {
        setup: (input?: { password: string }) => send<{ secret: string; otpauthUri: string }>('POST', '/v1/auth/2fa/setup', input ?? {}),
        enable: (code, password) =>
          send<{ ok: boolean; totpEnabled: boolean }>('POST', '/v1/auth/2fa/enable', password ? { code, password } : { code }),
        disable: (input) => send<{ ok: boolean; totpEnabled: boolean }>('POST', '/v1/auth/2fa/disable', input),
      },
      me: () => get<PublicUser>('/v1/auth/me'),
      tokens: {
        create: (input) => send<CreatedApiToken>('POST', '/v1/auth/tokens', input ?? {}),
        list: () => get<ApiToken[]>('/v1/auth/tokens'),
        remove: async (id) => {
          await request(`/v1/auth/tokens/${id}`, { method: 'DELETE' });
        },
      },
      passkeys: {
        registerOptions: (input) =>
          send<{ options: string }>('POST', '/v1/auth/passkey/register/options', input?.password ? { password: input.password } : undefined),
        registerVerify: (input) =>
          send<PasskeyCredential>('POST', '/v1/auth/passkey/register/verify', {
            name: input.name,
            response: input.response as Record<string, unknown>,
            ...(input.password ? { password: input.password } : {}),
          }),
        list: () => get<PasskeyCredential[]>('/v1/auth/passkey'),
        remove: async (id) => {
          await request(`/v1/auth/passkey/${id}`, { method: 'DELETE' });
        },
        loginOptions: () => send<{ options: string }>('POST', '/v1/auth/passkey/login/options'),
        loginVerify: (response) =>
          send<Session>('POST', '/v1/auth/passkey/login/verify', { response: response as Record<string, unknown> }),
      },
      sessions: {
        list: () => get<ActiveSession[]>('/v1/auth/sessions'),
        revoke: (id) => send<{ ok: boolean }>('DELETE', `/v1/auth/sessions/${id}`),
      },
      oidc: {
        publicProviders: () => get<OidcPublicProvider[]>('/v1/auth/oidc/providers/public'),
        link: (slug) => request<{ authUrl: string }>(`/v1/auth/oidc/${encodeURIComponent(slug)}/link`, { method: 'POST', credentials: 'include' }),
        listProviders: () => get<OidcProviderEntry[]>('/v1/auth/oidc/providers'),
        list: () => get<OidcProviderEntry[]>('/v1/auth/oidc/providers'),
        createProvider: (input) => send<OidcProviderEntry>('POST', '/v1/auth/oidc/providers', input),
        create: (input) => send<OidcProviderEntry>('POST', '/v1/auth/oidc/providers', input),
        updateProvider: (id, input) => send<OidcProviderEntry>('PATCH', `/v1/auth/oidc/providers/${id}`, input),
        update: (id, input) => send<OidcProviderEntry>('PATCH', `/v1/auth/oidc/providers/${id}`, input),
        deleteProvider: (id) => send<{ ok: boolean }>('DELETE', `/v1/auth/oidc/providers/${id}`),
        delete: (id) => send<{ ok: boolean }>('DELETE', `/v1/auth/oidc/providers/${id}`),
        callback: (slug, payload) => send<Session>('POST', `/v1/auth/oidc/${slug}/callback`, payload),
      },
    },
    workspaces: {
      list: () => get<WorkspaceEntry[]>('/v1/workspaces'),
      get: (id) => get<WorkspaceDetail>(`/v1/workspaces/${id}`),
      create: (input) => send<WorkspaceEntry>('POST', '/v1/workspaces', input),
      update: (id, input) => send<WorkspaceEntry>('PATCH', `/v1/workspaces/${id}`, input),
      delete: (id) => send<{ ok: boolean }>('DELETE', `/v1/workspaces/${id}`),
      addMember: (id, input) =>
        send<WorkspaceMemberEntry | WorkspaceMemberInviteEntry>('POST', `/v1/workspaces/${id}/members`, input),
      inviteMember: (id, input) =>
        send<WorkspaceInvitationEntry>('POST', `/v1/workspaces/${id}/invitations`, input),
      listInvitations: (id) => get<WorkspaceInvitationEntry[]>(`/v1/workspaces/${id}/invitations`),
      revokeInvitation: (id, inviteId) =>
        send<{ ok: boolean }>('DELETE', `/v1/workspaces/${id}/invitations/${inviteId}`),
      previewInvitation: (token) => get<WorkspaceInvitationPublic>(`/v1/invitations/${token}`),
      acceptInvitation: (token) =>
        send<{ ok: boolean; workspaceId: number; role: WorkspaceRole }>(
          'POST',
          `/v1/invitations/${token}/accept`,
        ),
      updateMemberRole: (id, memberId, input) => send<WorkspaceMemberEntry>('PATCH', `/v1/workspaces/${id}/members/${memberId}`, input),
      removeMember: (id, memberId) => send<{ ok: boolean }>('DELETE', `/v1/workspaces/${id}/members/${memberId}`),
    },
    users: {
      list: () => get<PublicUser[]>('/v1/users'),
      create: (input) => send<PublicUser>('POST', '/v1/users', input),
      resetPassword: (id, input) => send<{ ok: boolean }>('PATCH', `/v1/users/${id}/password`, input),
      resetLink: (id) => send<{ url: string; expiresAt: string }>('POST', `/v1/users/${id}/reset-link`),
      setOperator: (id, isOperator) =>
        send<{ ok: boolean; id: number; isOperator: boolean }>('PATCH', `/v1/users/${id}/operator`, { isOperator }),
      remove: async (id, opts) => {
        // r540: owned workspaces go to the caller unless `transferTo` names another user.
        const q = opts?.transferTo != null ? `?transferTo=${encodeURIComponent(String(opts.transferTo))}` : '';
        await request(`/v1/users/${id}${q}`, { method: 'DELETE' });
      },
    },
    scim: {
      listTokens: () =>
        get<Array<{ id: number; name: string; workspaceId: number; createdAt: string | null; lastUsedAt: string | null; revoked: boolean }>>('/v1/scim/tokens'),
      createToken: (input) =>
        send<{ id: number; token: string }>('POST', '/v1/scim/tokens', input),
      revokeToken: (id) => send<{ ok: boolean }>('DELETE', `/v1/scim/tokens/${id}`),
    },
    sso: {
      listProviders: () => get<{
        providers: Array<{ id: number; type: 'oidc' | 'saml'; name: string; createdAt: string }>;
      }>('/v1/sso/providers'),
      addProvider: (input) => send<{
        ok: boolean;
        id?: number;
        name?: string;
        type?: 'oidc' | 'saml';
        error?: string;
      }>('POST', '/v1/sso/providers', input),
      removeProvider: (id) => send<{ ok: boolean }>('DELETE', `/v1/sso/providers/${id}`),
    },
    accessGrants: {
      list: (workspaceId, query) =>
        get<AccessGrant[]>(apiGetUrl(`/v1/workspaces/${workspaceId}/access-grants`, { ...query })),
      create: (workspaceId, input) => send<AccessGrant>('POST', `/v1/workspaces/${workspaceId}/access-grants`, input),
      update: (workspaceId, grantId, input) =>
        send<AccessGrant>('PATCH', `/v1/workspaces/${workspaceId}/access-grants/${grantId}`, input),
      delete: (workspaceId, grantId) =>
        send<{ ok: boolean }>('DELETE', `/v1/workspaces/${workspaceId}/access-grants/${grantId}`),
    },
    access: {
      me: () => get<AccessMe>('/v1/access/me'),
      project: (projectId) => get<ProjectAccessEntry[]>(`/v1/projects/${projectId}/access`),
    },
  };
}
