import { customCertificateReplace, customCertificateUpload, sharedCertificatesInput, traefikCustomConfigInput } from '@ninedeploy/schemas';
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
  'GET /v1/host-ips': {
    summary: "The panel host's IP addresses, detected and annotated",
    tag: 'traefik',
    description:
      'Global-scope addresses read live from the host (`ip -o addr` in a host-network container), merged with what operators saved: a label, the primary mark (at most one) and the service an address is dedicated to. `detected: false` when the host could not be asked; saved addresses are still listed. Added in 0.16.1.',
    floor: 'operator',
    responseType:
      '{ detected: boolean; addresses: Array<{ ip: string; family: 4 | 6; iface: string | null; detected: boolean; label: string | null; primary: boolean; dedicatedTo: { id: number; name: string } | null }> }',
  },
  'GET /v1/host-ips/primary': {
    summary: 'The primary address of the panel host',
    tag: 'traefik',
    description: 'What DNS records should point at, for the DNS hints in the panel; null until an operator picks one. Added in 0.16.1.',
    floor: 'authed',
    responseType: '{ ip: string | null }',
  },
  'PUT /v1/host-ips/:ip': {
    summary: 'Label an address, make it primary, or dedicate it to a service',
    tag: 'traefik',
    description:
      'A new address must be one the host has (400 `host_ip_unknown`) unless the host cannot be asked. `primary: true` moves the mark from any other address. `serviceId` dedicates it to a docker service on the panel host, refused (409) while another service publishes ports on it explicitly; `null` shares it again. The port mappings of every other service are then refused the address. Audited host_ip.update. Added in 0.16.1.',
    floor: 'operator',
    localBody: 'hostIps.ts#patchBody',
    validation: 'zod',
    responseType: 'HostIpEntry | null',
  },
  'DELETE /v1/host-ips/:ip': {
    summary: 'Forget what was saved about an address',
    tag: 'traefik',
    description: '404 when nothing was saved. Audited host_ip.delete. Added in 0.16.1.',
    floor: 'operator',
    responseType: '{ ok: boolean }',
  },
  'GET /v1/traefik/http3': {
    summary: 'Whether the proxy publishes 443/udp for HTTP/3',
    tag: 'traefik',
    description: 'Off unless an operator turned it on. Added in 0.16.1.',
    floor: 'operator',
    responseType: '{ enabled: boolean }',
  },
  'PUT /v1/traefik/http3': {
    summary: 'Turn HTTP/3 (QUIC on 443/udp) on or off',
    tag: 'traefik',
    description:
      'Recreates Traefik on the panel host with or without `-p 443:443/udp` (about a second of refused connections). A failed recreate puts the switch and the previous container back and answers 502 `traefik_recreate_failed`. Audited traefik.http3.update. Nodes keep their proxy as it is. Added in 0.16.1.',
    floor: 'operator',
    responseType: '{ enabled: boolean }',
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
  'GET /v1/traefik/certificates/shared': {
    summary: "Whether node proxies get the panel's ACME certificates for the hosts they route (G5.7)",
    tag: 'traefik',
    floor: 'operator',
    responseType: '{ enabled: boolean }',
  },
  'PUT /v1/traefik/certificates/shared': {
    summary: "Share the panel's ACME certificates with node proxies, or stop (re-renders every proxy)",
    tag: 'traefik',
    floor: 'operator',
    body: sharedCertificatesInput,
    validation: 'zod',
    responseType: '{ enabled: boolean }',
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
