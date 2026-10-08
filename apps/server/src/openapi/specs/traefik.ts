import { customCertificateReplace, customCertificateUpload, traefikCustomConfigInput } from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: traefik (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const traefikSpecs: RouteSpecMap = {
  'GET /v1/traefik': {
    summary: 'Proxy overview (routers and certificates for operators)',
    tag: 'traefik',
    description: 'Non-operators get the container status only; routers and certificates are operator only.',
    floor: 'authed',
    responseType: 'TraefikInfo',
  },
  'GET /v1/traefik/status': {
    summary: 'Proxy container status',
    tag: 'traefik',
    floor: 'operator',
    responseType: 'TraefikStatus',
  },
  'GET /v1/traefik/version': {
    summary: 'Proxy version and update availability',
    tag: 'traefik',
    floor: 'operator',
    responseType: 'TraefikVersionInfo',
  },
  'GET /v1/traefik/config': {
    summary: 'Rendered proxy configuration',
    tag: 'traefik',
    floor: 'operator',
    responseType: 'TraefikRoutingConfig',
  },
  'GET /v1/traefik/logs': {
    summary: 'Recent proxy logs',
    tag: 'traefik',
    floor: 'operator',
    queryType: '{ lines?: string }',
    responseType: '{ logs: string[] }',
    validation: 'handler',
  },
  'POST /v1/traefik/restart': {
    summary: 'Restart the proxy',
    tag: 'traefik',
    floor: 'operator',
    responseType: '{ ok: boolean; message: string }',
  },
  'POST /v1/traefik/update': {
    summary: 'Pull the proxy image and recreate it',
    tag: 'traefik',
    floor: 'operator',
    responseType: '{ ok: boolean; newVersion: string | null }',
  },
  'POST /v1/traefik/backup-certs': {
    summary: 'Back up the ACME certificate store',
    tag: 'traefik',
    floor: 'operator',
    responseType: '{ ok: boolean; backupPath: string }',
  },
  'GET /v1/traefik/certificates': {
    summary: 'List certificates',
    tag: 'traefik',
    floor: 'operator',
    responseType: 'TraefikCertificate[]',
  },
  'GET /v1/traefik/certificates/expiring': {
    summary: 'Certificates expiring within N days',
    tag: 'traefik',
    floor: 'operator',
    queryType: '{ days?: string }',
    validation: 'handler',
  },
  'GET /v1/traefik/certificates/inventory': {
    summary: 'Certificate inventory',
    tag: 'traefik',
    floor: 'operator',
    queryType: '{ threshold?: string }',
    validation: 'handler',
    mcp: { name: 'certificate_inventory', description: 'TLS certificate inventory: hostnames, issuer, expiry and renewal state. Operator only.', readOnly: true },
  },
  'GET /v1/traefik/custom-config': {
    summary: 'The custom dynamic configuration',
    tag: 'traefik',
    floor: 'operator',
    responseType: 'TraefikCustomConfig',
  },
  'POST /v1/traefik/custom-config/validate': {
    summary: 'Validate a custom dynamic configuration',
    tag: 'traefik',
    floor: 'operator',
    body: traefikCustomConfigInput,
    responseType: 'TraefikCustomConfigValidation',
    validation: 'zod',
  },
  'PUT /v1/traefik/custom-config': {
    summary: 'Save the custom dynamic configuration',
    tag: 'traefik',
    floor: 'operator',
    body: traefikCustomConfigInput,
    responseType: 'TraefikCustomConfigApplied',
    validation: 'zod',
  },
  'DELETE /v1/traefik/custom-config': {
    summary: 'Remove the custom dynamic configuration',
    tag: 'traefik',
    floor: 'operator',
    responseType: '{ ok: boolean; cleared: boolean }',
  },
  'GET /v1/traefik/certificates/custom': {
    summary: 'List custom certificates',
    tag: 'traefik',
    floor: 'operator',
    responseType: 'CustomCertificate[]',
  },
  'POST /v1/traefik/certificates/custom': {
    summary: 'Upload a custom certificate',
    tag: 'traefik',
    floor: 'operator',
    body: customCertificateUpload,
    responseType: 'CustomCertificateSaved',
    validation: 'zod',
  },
  'PUT /v1/traefik/certificates/custom/:id': {
    summary: 'Replace a custom certificate',
    tag: 'traefik',
    floor: 'operator',
    body: customCertificateReplace,
    responseType: 'CustomCertificateSaved',
    validation: 'zod',
  },
  'DELETE /v1/traefik/certificates/custom/:id': {
    summary: 'Delete a custom certificate',
    tag: 'traefik',
    floor: 'operator',
    responseType: '{ ok: boolean }',
  },
};
