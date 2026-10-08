import { createLabel, createProject, labelPatch, projectPatch } from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: projects (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const projectsSpecs: RouteSpecMap = {
  'GET /v1/projects': {
    summary: 'List projects',
    tag: 'projects',
    floor: 'authed',
    queryType: '{ workspaceId?: string }',
    validation: 'handler',
  },
  'POST /v1/projects': {
    summary: 'Create a project',
    tag: 'projects',
    floor: 'member',
    body: createProject,
    responseType: 'ProjectEntry',
    validation: 'zod',
  },
  'PATCH /v1/projects/:id': {
    summary: 'Update a project',
    tag: 'projects',
    floor: 'admin',
    body: projectPatch,
    responseType: 'ProjectEntry',
    validation: 'zod',
  },
  'DELETE /v1/projects/:id': {
    summary: 'Delete a project',
    tag: 'projects',
    floor: 'admin',
    responseType: '{ ok: boolean }',
  },
  'GET /v1/labels': {
    summary: 'List labels',
    tag: 'labels',
    floor: 'authed',
    queryType: '{ workspaceId?: string }',
    validation: 'handler',
    mcp: { name: 'list_labels', description: 'List labels across the workspaces the caller belongs to.', readOnly: true },
  },
  'POST /v1/labels': {
    summary: 'Create a label',
    tag: 'labels',
    floor: 'member',
    body: createLabel,
    responseType: 'Label',
    validation: 'zod',
  },
  'PATCH /v1/labels/:id': {
    summary: 'Update a label',
    tag: 'labels',
    floor: 'member',
    body: labelPatch,
    responseType: 'Label',
    validation: 'zod',
  },
  'DELETE /v1/labels/:id': {
    summary: 'Delete a label',
    tag: 'labels',
    floor: 'member',
    responseType: '{ ok: boolean }',
  },
  'GET /v1/environments': {
    summary: 'List environments with service counts',
    tag: 'environments',
    floor: 'authed',
    responseType: 'Environment[]',
    mcp: { name: 'list_environments', description: 'List deployment environments (lanes) across the workspaces the caller belongs to, with live service counts.', readOnly: true },
  },
  'POST /v1/environments': {
    summary: 'Create an environment',
    tag: 'environments',
    floor: 'member',
    localBody: 'environments.ts#environmentCreate',
    responseType: 'Environment',
    validation: 'zod',
  },
  'PATCH /v1/environments/:id': {
    summary: 'Rename an environment',
    tag: 'environments',
    floor: 'member',
    localBody: 'environments.ts#environmentPatch',
    responseType: 'Environment',
    validation: 'zod',
  },
  'DELETE /v1/environments/:id': {
    summary: 'Delete an environment (its services stay, detached)',
    tag: 'environments',
    floor: 'admin',
    responseType: '{ ok: boolean }',
  },
};
