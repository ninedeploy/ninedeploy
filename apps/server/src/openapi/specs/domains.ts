import { createDomain, domainPatch } from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: domains (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const domainsSpecs: RouteSpecMap = {
  'GET /v1/services/:id/domains': {
    summary: "List a service's domains",
    tag: 'domains',
    floor: 'viewer',
    responseType: 'Domain[]',
  },
  'POST /v1/services/:id/domains': {
    summary: 'Add a domain to a service',
    tag: 'domains',
    floor: 'member',
    body: createDomain,
    responseType: 'CreatedDomain',
    validation: 'zod',
  },
  'PATCH /v1/services/:id/domains/:domainId': {
    summary: "Update a domain's routing options",
    tag: 'domains',
    floor: 'member',
    body: domainPatch,
    responseType: 'Domain',
    validation: 'zod',
  },
  'DELETE /v1/services/:id/domains/:domainId': {
    summary: 'Remove a domain',
    tag: 'domains',
    floor: 'member',
  },
  'GET /v1/services/:id/domains/:domainId/dns': {
    summary: 'DNS status of a domain',
    tag: 'domains',
    floor: 'viewer',
  },
  'POST /v1/services/:id/domains/:domainId/verify': {
    summary: 'Verify a pending domain and bring it live',
    tag: 'domains',
    floor: 'member',
    responseType: 'DomainVerifyResult',
  },
  'GET /v1/domains': {
    summary: 'Every domain the caller can see',
    tag: 'domains',
    floor: 'authed',
    responseType: 'DomainEntry[]',
  },
  'PATCH /v1/domains/:id': {
    summary: 'Toggle TLS on a domain',
    tag: 'domains',
    floor: 'member',
    bodyType: '{ ssl?: unknown }',
    responseType: '{ id: number; ssl: boolean }',
    validation: 'handler',
  },
  'POST /v1/domains/:id/transfer': {
    summary: 'Start a domain transfer to another user',
    tag: 'domains',
    floor: 'admin',
    localBody: 'domainTransfers.ts#startBody',
    responseType: 'StartDomainTransferResult',
    validation: 'zod',
  },
  'GET /v1/domain-transfers/:token': {
    summary: 'Preview a domain transfer by its token',
    tag: 'domains',
    floor: 'token',
    responseType: 'DomainTransferPreview',
  },
  'POST /v1/domain-transfers/:token/accept': {
    summary: 'Accept a domain transfer',
    tag: 'domains',
    floor: 'token',
    localBody: 'domainTransfers.ts#acceptBody',
    responseType: 'AcceptDomainTransferResult',
    validation: 'zod',
  },
  'POST /v1/domain-transfers/:token/cancel': {
    summary: 'Cancel a domain transfer',
    tag: 'domains',
    floor: 'token',
    responseType: "{ transferId: number; status: 'cancelled' }",
  },
  'GET /v1/domain-presets': {
    summary: 'List DNS provider presets',
    tag: 'domains',
    floor: 'authed',
    responseType: '{ providers: string[] }',
  },
  'POST /v1/domain-presets/apply': {
    summary: 'Apply a DNS provider preset',
    tag: 'domains',
    floor: 'operator',
    localBody: 'domainPresets.ts#applySchema',
    validation: 'zod',
  },
};
