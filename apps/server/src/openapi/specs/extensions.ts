import { aiConfigUpdate, analyzeRepoInput, deployTemplate, installPluginSchema } from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: extensions (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const extensionsSpecs: RouteSpecMap = {
  'GET /v1/plugins': {
    summary: 'List plugins',
    tag: 'plugins',
    floor: 'authed',
    responseType: 'PluginListResponse',
  },
  'GET /v1/plugins/marketplace': {
    summary: 'Marketplace catalog',
    tag: 'plugins',
    floor: 'authed',
    queryType: '{ refresh?: string }',
    validation: 'handler',
  },
  'POST /v1/plugins/marketplace/refresh': {
    summary: 'Refresh the marketplace catalog',
    tag: 'plugins',
    floor: 'operator',
  },
  'GET /v1/plugins/:id/inspect': {
    summary: 'Inspect a plugin',
    tag: 'plugins',
    floor: 'authed',
    responseType: 'PluginInspectResponse',
  },
  'POST /v1/plugins/install': {
    summary: 'Install a plugin',
    tag: 'plugins',
    floor: 'operator',
    body: installPluginSchema,
    responseType: '{ ok: boolean; id: string; status: string }',
    validation: 'zod',
  },
  'POST /v1/plugins/:id/enable': {
    summary: 'Enable a plugin',
    tag: 'plugins',
    floor: 'operator',
    responseType: '{ ok: boolean; id: string; status: string }',
  },
  'POST /v1/plugins/:id/disable': {
    summary: 'Disable a plugin',
    tag: 'plugins',
    floor: 'operator',
    responseType: '{ ok: boolean; id: string; status: string }',
  },
  'POST /v1/plugins/:id/reload': {
    summary: 'Reload a plugin',
    tag: 'plugins',
    floor: 'operator',
    responseType: '{ ok: boolean; id: string; status: string }',
  },
  'POST /v1/plugins/:id/uninstall': {
    summary: 'Uninstall a plugin',
    tag: 'plugins',
    floor: 'operator',
    responseType: '{ ok: boolean; id: string }',
  },
  'GET /v1/menus': {
    summary: 'Navigation menu items from plugins',
    tag: 'plugins',
    floor: 'authed',
    queryType: '{ slot?: MenuSlot }',
    responseType: 'MenuListResponse',
    validation: 'handler',
  },
  'GET /v1/templates': {
    summary: 'List templates',
    tag: 'templates',
    floor: 'authed',
    responseType: 'TemplateSummary[]',
  },
  'GET /v1/templates/:id': {
    summary: 'Get a template',
    tag: 'templates',
    floor: 'authed',
    responseType: 'Template',
  },
  'POST /v1/templates/:id/prepare': {
    summary: 'Deploy a template (alias of deploy)',
    tag: 'templates',
    floor: 'member',
    body: deployTemplate,
    responseType: 'TemplatePrepareResult',
    validation: 'zod',
  },
  'POST /v1/templates/:id/deploy': {
    summary: 'Deploy a template',
    tag: 'templates',
    floor: 'member',
    body: deployTemplate,
    responseType: 'TemplateDeployResult',
    validation: 'zod',
  },
  'GET /v1/templates/community': {
    summary: 'List community templates',
    tag: 'templates',
    floor: 'authed',
    responseType: 'CommunityTemplateListResult',
  },
  'POST /v1/templates/community/import': {
    summary: 'Import a community template',
    tag: 'templates',
    floor: 'operator',
    bodyType: '{ content?: string; replace?: boolean }',
    responseType: '{ ok: boolean; id: string; file: string; bytes: number }',
    validation: 'handler',
  },
  'DELETE /v1/templates/community/:id': {
    summary: 'Remove a community template',
    tag: 'templates',
    floor: 'operator',
    responseType: '{ ok: boolean; id: string; removed: boolean }',
  },
  'GET /v1/ai/config': {
    summary: 'AI assistant configuration status',
    tag: 'ai',
    floor: 'authed',
    responseType: 'AiConfigStatus',
  },
  'PUT /v1/ai/config': {
    summary: 'Configure the AI assistant',
    tag: 'ai',
    floor: 'operator',
    body: aiConfigUpdate,
    responseType: '{ ok: boolean }',
    validation: 'zod',
  },
  'POST /v1/ai/suggest-manifest': {
    summary: 'Suggest a .ninedeploy manifest from a description',
    tag: 'ai',
    floor: 'operator',
    localBody: 'ai.ts#suggestManifest',
    responseType: '{ manifest: Record<string, unknown>; model: string }',
    validation: 'zod',
  },
  'POST /v1/insights': {
    summary: 'Analyse a repository',
    tag: 'insights',
    floor: 'authed',
    body: analyzeRepoInput,
    responseType: 'RepoInsights',
    validation: 'zod',
  },
};
