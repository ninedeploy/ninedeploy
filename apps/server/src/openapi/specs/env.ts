import { envImport, upsertEnvVar } from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: env (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const envSpecs: RouteSpecMap = {
  'GET /v1/services/:id/env': {
    summary: "List a service's environment variables",
    tag: 'env',
    floor: 'viewer',
    responseType: 'EnvVar[]',
    sensitive: true,
  },
  'POST /v1/services/:id/env': {
    summary: 'Add an environment variable to a service',
    tag: 'env',
    floor: 'member',
    body: upsertEnvVar,
    responseType: 'EnvVar',
    validation: 'zod',
  },
  'PATCH /v1/services/:id/env/:varId': {
    summary: 'Update a service environment variable',
    tag: 'env',
    floor: 'member',
    body: upsertEnvVar,
    responseType: 'EnvVar',
    validation: 'zod',
  },
  'DELETE /v1/services/:id/env/:varId': {
    summary: 'Delete a service environment variable',
    tag: 'env',
    floor: 'member',
  },
  'GET /v1/services/:id/env/export': {
    summary: "Export a service's environment as a .env file",
    tag: 'env',
    floor: 'admin',
    responseType: '{ content: string; count: number }',
    sensitive: true,
  },
  'POST /v1/services/:id/env/import': {
    summary: 'Import environment variables from .env content',
    tag: 'env',
    floor: 'member',
    body: envImport,
    responseType: '{ imported: number; skipped: number; errors: Array<{ line: number; message: string }> }',
    validation: 'zod',
  },
  'GET /v1/services/:id/env/preview': {
    summary: "List a service's preview-only environment variables",
    tag: 'env',
    floor: 'viewer',
    responseType: 'EnvVar[]',
    sensitive: true,
  },
  'POST /v1/services/:id/env/preview': {
    summary: 'Add a preview-only environment variable',
    tag: 'env',
    floor: 'member',
    body: upsertEnvVar,
    responseType: 'EnvVar',
    validation: 'zod',
  },
  'PATCH /v1/services/:id/env/preview/:varId': {
    summary: 'Update a preview-only environment variable',
    tag: 'env',
    floor: 'member',
    body: upsertEnvVar,
    responseType: 'EnvVar',
    validation: 'zod',
  },
  'DELETE /v1/services/:id/env/preview/:varId': {
    summary: 'Delete a preview-only environment variable',
    tag: 'env',
    floor: 'member',
  },
  'GET /v1/projects/:id/env': {
    summary: "List a project's shared environment variables",
    tag: 'env',
    floor: 'viewer',
    responseType: 'EnvVar[]',
    sensitive: true,
  },
  'POST /v1/projects/:id/env': {
    summary: 'Add a project environment variable',
    tag: 'env',
    floor: 'member',
    body: upsertEnvVar,
    responseType: 'EnvVar',
    validation: 'zod',
  },
  'PATCH /v1/projects/:id/env/:varId': {
    summary: 'Update a project environment variable',
    tag: 'env',
    floor: 'member',
    body: upsertEnvVar,
    responseType: 'EnvVar',
    validation: 'zod',
  },
  'DELETE /v1/projects/:id/env/:varId': {
    summary: 'Delete a project environment variable',
    tag: 'env',
    floor: 'member',
  },
  'GET /v1/env/search': {
    summary: 'Search environment variable keys across visible services',
    tag: 'env',
    floor: 'authed',
    queryType: '{ q?: string }',
    validation: 'handler',
  },
};
