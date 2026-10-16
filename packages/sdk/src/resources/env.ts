// Client surface: env, projectEnv, previewEnv.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  EnvVar,
  UpsertEnvVarInput,
} from '@ninedeploy/schemas';
import type { Transport } from '../transport.js';

export interface EnvApi {
  env: {
    list: (serviceId: number) => Promise<EnvVar[]>;
    create: (serviceId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    update: (serviceId: number, varId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    remove: (serviceId: number, varId: number) => Promise<void>;
    /** Bulk import from a .env-formatted string. Returns imported/skipped counts. */
    import: (serviceId: number, content: string) => Promise<{ imported: number; skipped: number; errors: Array<{ line: number; message: string }> }>;
    /** Export non-secret env vars as a .env-formatted string (admin floor). */
    export: (serviceId: number) => Promise<{ content: string; count: number }>;
    /** Cross-scope key search: where a given env key is defined. */
    search: (q: string) => Promise<{ results: Array<{ key: string; isSecret: boolean; scope: string; serviceId: number | null; serviceName: string | null }> }>;
  };
  projectEnv: {
    /** Shared env vars applied to every service in a project (service env wins). */
    list: (projectId: number) => Promise<EnvVar[]>;
    create: (projectId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    update: (projectId: number, varId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    remove: (projectId: number, varId: number) => Promise<void>;
  };
  /**
   * 0.12 preview-only env: values a service hands ONLY to its PR previews
   * (they override the parent's non-secret values there; production never
   * sees them). Same floors as `env`: viewer reads, member writes. A panel
   * older than 0.12 answers 404.
   */
  previewEnv: {
    list: (serviceId: number) => Promise<EnvVar[]>;
    create: (serviceId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    update: (serviceId: number, varId: number, input: UpsertEnvVarInput) => Promise<EnvVar>;
    remove: (serviceId: number, varId: number) => Promise<void>;
  };
}

export function envApi(t: Transport): EnvApi {
  const { get, send, request } = t;
  return {
    env: {
      list: (serviceId) => get<EnvVar[]>(`/v1/services/${serviceId}/env`),
      create: (serviceId, input) => send<EnvVar>('POST', `/v1/services/${serviceId}/env`, input),
      update: (serviceId, varId, input) => send<EnvVar>('PATCH', `/v1/services/${serviceId}/env/${varId}`, input),
      remove: async (serviceId, varId) => {
        await request(`/v1/services/${serviceId}/env/${varId}`, { method: 'DELETE' });
      },
      import: (serviceId, content) =>
        send<{ imported: number; skipped: number; errors: Array<{ line: number; message: string }> }>(
          'POST',
          `/v1/services/${serviceId}/env/import`,
          { content },
        ),
      export: (serviceId) =>
        get<{ content: string; count: number }>(`/v1/services/${serviceId}/env/export`),
      search: (q) =>
        get<{ results: Array<{ key: string; isSecret: boolean; scope: string; serviceId: number | null; serviceName: string | null }> }>(
          `/v1/env/search?q=${encodeURIComponent(q)}`,
        ),
    },
    projectEnv: {
      list: (projectId) => get<EnvVar[]>(`/v1/projects/${projectId}/env`),
      create: (projectId, input) => send<EnvVar>('POST', `/v1/projects/${projectId}/env`, input),
      update: (projectId, varId, input) => send<EnvVar>('PATCH', `/v1/projects/${projectId}/env/${varId}`, input),
      remove: async (projectId, varId) => {
        await request(`/v1/projects/${projectId}/env/${varId}`, { method: 'DELETE' });
      },
    },
    previewEnv: {
      list: (serviceId) => get<EnvVar[]>(`/v1/services/${serviceId}/env/preview`),
      create: (serviceId, input) => send<EnvVar>('POST', `/v1/services/${serviceId}/env/preview`, input),
      update: (serviceId, varId, input) => send<EnvVar>('PATCH', `/v1/services/${serviceId}/env/preview/${varId}`, input),
      remove: async (serviceId, varId) => {
        await request(`/v1/services/${serviceId}/env/preview/${varId}`, { method: 'DELETE' });
      },
    },
  };
}
