// Client surface: sources, githubApps.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  CreateSourceInput,
  Source,
  GithubApp,
  GithubAppCreate,
  GithubAppInstallation,
  GithubAppManifestRequest,
  GithubAppManifestResponse,
  GithubAppPatch,
} from '@ninedeploy/schemas';
import type { GithubAppInstallationSync, SourceRepo, SourceUpdateInput } from '../types.js';
import type { Transport } from '../transport.js';

export interface SourcesApi {
  sources: {
    list: () => Promise<Source[]>;
    create: (input: CreateSourceInput) => Promise<Source>;
    update: (id: number, input: SourceUpdateInput) => Promise<Source>;
    remove: (id: number) => Promise<void>;
    repos: (id: number) => Promise<SourceRepo[]>;
    /**
     * `repos` plus the server's diagnostic for the list (F1010): a list capped
     * at the page limit, a later page that failed, a classic token without the
     * `repo` scope, or a provider error. The server sends it in the
     * `x-nd-source-error` response header; `warning` is null when absent.
     */
    reposWithDiagnostics: (id: number) => Promise<{
      repos: Awaited<ReturnType<SourcesApi['sources']['repos']>>;
      warning: string | null;
    }>;
    branches: (id: number, repo: string) => Promise<string[]>;
    /**
     * Live credential check — proves a stored token still authenticates.
     * GitHub successes also say what the token can see (F1008): `tokenKind`,
     * the classic token's `scopes` (from `x-oauth-scopes`) and `warnings`
     * explaining why private repositories may be missing. Never the token.
     */
    test: (id: number) => Promise<{
      ok: boolean;
      provider?: string;
      login?: string;
      name?: string | null;
      status?: number;
      error?: string;
      tokenKind?: 'classic' | 'fine-grained' | 'oauth' | 'unknown';
      scopes?: string[];
      warnings?: string[];
      /** GitHub App sources (0.13): the installation's repository selection, permissions and state. */
      repositorySelection?: string;
      permissions?: Record<string, string>;
      suspended?: boolean;
    }>;
    /**
     * Server-side generation of an ed25519 deploy key pair. The private key
     * is encrypted into the source row and never leaves the server; only the
     * public key and fingerprint are returned (the operator pastes the public
     * key into the Git provider's "Deploy keys" UI).
     */
    generateDeployKey: (id: number) => Promise<{ publicKey: string; fingerprint: string }>;
  };
  /**
   * GitHub App registration and installations (0.13). Operator-only. No
   * response carries the private key, webhook secret or client secret.
   */
  githubApps: {
    list: () => Promise<GithubApp[]>;
    get: (id: number) => Promise<GithubApp>;
    /** Manual entry (GitHub Enterprise Server, or an existing App). Omit both base URLs for github.com. */
    create: (input: GithubAppCreate) => Promise<GithubApp>;
    /**
     * Start the one-click manifest flow. Submit `manifest` (JSON-encoded) as
     * the `manifest` field of a form POSTed to `postUrl`; GitHub then sends
     * the browser to `/github-apps/callback?code&state`.
     */
    manifest: (input: GithubAppManifestRequest) => Promise<GithubAppManifestResponse>;
    /** Finish the manifest flow with the `code` and `state` GitHub returned. Same user only, single use. */
    completeManifest: (input: { code: string; state: string }) => Promise<GithubApp>;
    patch: (id: number, input: GithubAppPatch) => Promise<GithubApp>;
    /** Replace the private key; the server proves it with `GET /app` first. */
    rotateKey: (id: number, privateKey: string) => Promise<GithubApp>;
    /** Re-point the App's webhook at this panel (after a panel domain change). */
    webhookSync: (id: number) => Promise<GithubApp>;
    rotateWebhookSecret: (id: number) => Promise<GithubApp>;
    /** Forget the App; its generated sources stay and their clones fail closed. */
    remove: (id: number) => Promise<void>;
    syncInstallations: (id: number) => Promise<GithubAppInstallationSync>;
    installations: (id: number) => Promise<GithubAppInstallation[]>;
  };
}

export function sourcesApi(t: Transport): SourcesApi {
  const { get, send, request, requestWithHeaders } = t;
  return {
    sources: {
      list: () => get<Source[]>('/v1/sources'),
      create: (input) => send<Source>('POST', '/v1/sources', input),
      update: (id, input) => send<Source>('PATCH', `/v1/sources/${id}`, input),
      remove: async (id) => {
        await request(`/v1/sources/${id}`, { method: 'DELETE' });
      },
      repos: (id) => get<SourceRepo[]>(`/v1/sources/${id}/repos`),
      reposWithDiagnostics: async (id) => {
        const { data, header } = await requestWithHeaders<Awaited<ReturnType<SourcesApi['sources']['repos']>>>(`/v1/sources/${id}/repos`);
        const warning = header('x-nd-source-error')?.trim();
        return { repos: Array.isArray(data) ? data : [], warning: warning ? warning : null };
      },
      branches: (id, repo) => get<string[]>(`/v1/sources/${id}/branches?repo=${encodeURIComponent(repo)}`),
      test: (id) => get<Awaited<ReturnType<SourcesApi['sources']['test']>>>(`/v1/sources/${id}/test`),
      generateDeployKey: (id) => send<{ publicKey: string; fingerprint: string }>('POST', `/v1/sources/${id}/generate-deploy-key`),
    },
    githubApps: {
      list: () => get<GithubApp[]>('/v1/github-apps'),
      get: (id) => get<GithubApp>(`/v1/github-apps/${id}`),
      create: (input) => send<GithubApp>('POST', '/v1/github-apps', input),
      manifest: (input) => send<GithubAppManifestResponse>('POST', '/v1/github-apps/manifest', input),
      completeManifest: (input) => send<GithubApp>('POST', '/v1/github-apps/manifest/complete', input),
      patch: (id, input) => send<GithubApp>('PATCH', `/v1/github-apps/${id}`, input),
      rotateKey: (id, privateKey) => send<GithubApp>('PUT', `/v1/github-apps/${id}/private-key`, { privateKey }),
      webhookSync: (id) => send<GithubApp>('POST', `/v1/github-apps/${id}/webhook/sync`),
      rotateWebhookSecret: (id) => send<GithubApp>('POST', `/v1/github-apps/${id}/webhook-secret/rotate`),
      remove: async (id) => {
        await request(`/v1/github-apps/${id}`, { method: 'DELETE' });
      },
      syncInstallations: (id) => send<GithubAppInstallationSync>('POST', `/v1/github-apps/${id}/installations/sync`),
      installations: (id) => get<GithubAppInstallation[]>(`/v1/github-apps/${id}/installations`),
    },
  };
}
