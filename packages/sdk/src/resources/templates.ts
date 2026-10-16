// Client surface: templates.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  DeployTemplateInput,
  Template,
  TemplateSummary,
  CommunityTemplateListResult,
} from '@ninedeploy/schemas';
import type { TemplateDeployResult, TemplatePrepareResult } from '../types.js';
import type { Transport } from '../transport.js';

export interface TemplatesApi {
  templates: {
    list: () => Promise<TemplateSummary[]>;
    get: (id: string) => Promise<Template>;
    prepare: (id: string, input?: DeployTemplateInput) => Promise<TemplatePrepareResult>;
    deploy: (id: string, input?: DeployTemplateInput) => Promise<TemplateDeployResult>;
    /**
     * Community contributions (G-13). The `list` call
     * already merges community entries with the curated
     * catalog; the dedicated `community` namespace lets
     * the panel surface errors and the operator import
     * a new template from a PR comment or a file.
     */
    community: {
      list: () => Promise<CommunityTemplateListResult>;
      import: (content: string, opts?: { replace?: boolean }) => Promise<{ ok: boolean; id: string; file: string; bytes: number }>;
      remove: (id: string) => Promise<{ ok: boolean; id: string; removed: boolean }>;
    };
  };
}

export function templatesApi(t: Transport): TemplatesApi {
  const { get, send } = t;
  return {
    templates: {
      list: () => get<TemplateSummary[]>('/v1/templates'),
      get: (id) => get<Template>(`/v1/templates/${encodeURIComponent(id)}`),
      prepare: (id, input) => send<TemplatePrepareResult>('POST', `/v1/templates/${encodeURIComponent(id)}/prepare`, input ?? {}),
      deploy: (id, input) => send<TemplateDeployResult>('POST', `/v1/templates/${encodeURIComponent(id)}/deploy`, input ?? {}),
      community: {
        list: () => get<CommunityTemplateListResult>('/v1/templates/community'),
        import: (content, opts) =>
          send<{ ok: boolean; id: string; file: string; bytes: number }>(
            'POST',
            '/v1/templates/community/import',
            { content, ...(opts ?? {}) },
          ),
        remove: (id) =>
          send<{ ok: boolean; id: string; removed: boolean }>('DELETE', `/v1/templates/community/${encodeURIComponent(id)}`),
      },
    },
  };
}
