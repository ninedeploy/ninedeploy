import type { DB } from '@ninedeploy/db';
import type { DomainRecordType, DomainZone } from '../kernel/types.js';
import { decrypt, encrypt } from './crypto.js';
import { getSettingString, setSettingString } from './settings.js';
import { findChild, findChildren, parseXml } from './xml.js';
import { guardedFetch } from './egressGuard.js';

/**
 * Namecheap DNS API client (zero-dependency: plain `fetch` + form-encoded
 * bodies + a hand-rolled XML parser).
 *
 * ## Why a different shape than the DNSimple helper
 *
 * Namecheap's domain-DNS API has no "create a single record" endpoint.
 * The only mutation is `namecheap.domains.dns.setHosts`, which is a
 * wholesale PUT — it replaces the *entire* host list for a domain in
 * one round-trip. To add a record the driver has to:
 *
 *   1. `getHosts(domain)` — fetch the current list,
 *   2. append a new `<Host>` entry (with no `HostId`; Namecheap assigns one),
 *   3. `setHosts(domain, merged)` — push the merged list back,
 *   4. `getHosts(domain)` again — read the new `HostId` back, because
 *      `setHosts` does not echo the assigned ids.
 *
 * That's two extra round-trips per `createRecord` call, but it keeps
 * the `IDomainProvider` contract unchanged: the kernel still sees
 * "create record X under zone Y, get back an id, later delete it by
 * id". The cost is paid by Namecheap's atomic-write model, not by
 * the kernel.
 *
 * ## Why `ClientIp`
 *
 * Namecheap's API is IP-whitelisted. The operator has to add the
 * server's public IP to the Namecheap account panel before any of
 * these calls will work. The value is part of the encrypted settings
 * blob — same lifecycle as the API key.
 *
 * ## Zero npm dependencies
 *
 * The XML parsing is shared with `lib/saml.ts` via `lib/xml.ts`. The
 * request bodies are `application/x-www-form-urlencoded`, which
 * `URLSearchParams` handles natively. No new dep tree.
 */

const ENDPOINT = 'https://api.namecheap.com/xml.response';

const FETCH_TIMEOUT_MS = 15_000;

export interface NamecheapCredentials {
  apiUser: string;
  apiKey: string;
  /** Whitelisted public IP of the server. */
  clientIp: string;
}

/** Settings keys that hold the operator's Namecheap credentials. */
const KEY_API_USER = 'namecheap_api_user';
const KEY_API_KEY = 'namecheap_api_key_encrypted';
const KEY_CLIENT_IP = 'namecheap_client_ip';

/** Resolve the configured credentials, or return `null` when the operator
 *  has not finished the Namecheap onboarding (Settings → DNS). */
export async function getNamecheapConfig(db: DB): Promise<NamecheapCredentials | null> {
  const [apiUser, clientIp, apiKeyEncrypted] = await Promise.all([
    getSettingString(db, KEY_API_USER, ''),
    getSettingString(db, KEY_CLIENT_IP, ''),
    getSettingString(db, KEY_API_KEY, ''),
  ]);
  if (!apiUser || !clientIp || !apiKeyEncrypted) return null;
  try {
    const apiKey = decrypt(apiKeyEncrypted);
    return { apiUser, apiKey, clientIp };
  } catch {
    return null;
  }
}

/** Persist Namecheap credentials. The key is encrypted at rest, the
 *  username and client IP are stored in plaintext because they are
 *  not secret on their own. */
export async function setNamecheapConfig(
  db: DB,
  creds: { apiUser: string; apiKey: string; clientIp: string },
): Promise<void> {
  if (!creds.apiUser || !creds.apiKey || !creds.clientIp) {
    throw new Error('Namecheap apiUser, apiKey, and clientIp are all required');
  }
  await setSettingString(db, KEY_API_USER, creds.apiUser);
  await setSettingString(db, KEY_API_KEY, encrypt(creds.apiKey));
  await setSettingString(db, KEY_CLIENT_IP, creds.clientIp);
}

interface NamecheapError {
  number: string;
  message: string;
}

function parseErrors(root: ReturnType<typeof parseXml>): NamecheapError[] {
  const errorsEl = findChild(root, 'Errors');
  if (!errorsEl) return [];
  return findChildren(errorsEl, 'Error').map((e) => ({
    number: e.attrs['Number'] ?? '',
    message: e.text.trim(),
  }));
}

/** One row in Namecheap's host list (`namecheap.domains.dns.getHosts`). */
export interface NamecheapHost {
  /** Numeric id Namecheap assigns. Omitted on a brand-new host entry. */
  hostId?: string;
  name: string;
  type: DomainRecordType | string;
  address: string;
  ttl: string;
  /** MX priority. r244: dropped by the old round-trip, so every write reset
   *  the zone's MX preferences to Namecheap's default. */
  mxPref?: string;
}

function parseHosts(hostsEl: ReturnType<typeof parseXml>): NamecheapHost[] {
  return findChildren(hostsEl, 'host').map((h) => ({
    hostId: h.attrs['HostId'],
    name: h.attrs['Name'] ?? '',
    type: h.attrs['Type'] ?? 'A',
    address: h.attrs['Address'] ?? '',
    ttl: h.attrs['TTL'] ?? '1800',
    ...(h.attrs['MXPref'] ? { mxPref: h.attrs['MXPref'] } : {}),
  }));
}

/** Build the common auth/query param block. Every Namecheap call needs
 *  ApiUser + ApiKey + UserName (defaults to ApiUser) + ClientIp. */
function authParams(creds: NamecheapCredentials, command: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set('ApiUser', creds.apiUser);
  p.set('ApiKey', creds.apiKey);
  p.set('UserName', creds.apiUser);
  p.set('ClientIp', creds.clientIp);
  p.set('Command', command);
  return p;
}

async function namecheapRequest(_creds: NamecheapCredentials, params: URLSearchParams): Promise<ReturnType<typeof parseXml>> {
  const url = `${ENDPOINT}?${params.toString()}`;
  const res = await guardedFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Namecheap API HTTP ${res.status}`);
  const text = await res.text();
  let root: ReturnType<typeof parseXml>;
  try {
    root = parseXml(text);
  } catch (err) {
    throw new Error(`Namecheap returned malformed XML: ${err instanceof Error ? err.message : err}`);
  }
  const status = root.attrs['Status'];
  const errors = parseErrors(root);
  if (status !== 'OK' || errors.length > 0) {
    const detail = errors.map((e) => `[${e.number}] ${e.message}`).join('; ');
    throw new Error(`Namecheap API error: ${detail || 'unknown'}`);
  }
  return root;
}

/** List every domain in the account (`namecheap.domains.getList`). */
export async function listNamecheapDomains(creds: NamecheapCredentials): Promise<DomainZone[]> {
  const root = await namecheapRequest(creds, authParams(creds, 'namecheap.domains.getList'));
  const result = findChild(root, 'CommandResponse');
  if (!result) return [];
  // The `<Domain>` children live under `<DomainGetListResult>`; fall
  // through to a direct child scan for resilience against a wrapping
  // element the schema might add in a future API revision.
  const container = findChild(result, 'DomainGetListResult') ?? result;
  return findChildren(container, 'Domain')
    .map((d) => d.attrs['Name'])
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .map((name) => ({ id: name, name }));
}

/** Fetch the current host list for `domain` (`namecheap.domains.dns.getHosts`). */
export async function getNamecheapHosts(creds: NamecheapCredentials, domain: string): Promise<NamecheapHost[]> {
  return (await readNamecheapHostList(creds, domain)).hosts;
}

/**
 * The host list plus the domain's `EmailType`. `setHosts` REPLACES the zone,
 * and without `EmailType=MX` Namecheap discards the MX rows it is sent, so a
 * read-modify-write that does not carry the email type back silently deletes
 * the domain's mail routing (r244).
 */
export async function readNamecheapHostList(
  creds: NamecheapCredentials,
  domain: string,
): Promise<{ hosts: NamecheapHost[]; emailType?: string }> {
  const params = authParams(creds, 'namecheap.domains.dns.getHosts');
  params.set('SLD', sldOf(domain));
  params.set('TLD', tldOf(domain));
  const root = await namecheapRequest(creds, params);
  const result = findChild(root, 'CommandResponse');
  if (!result) return { hosts: [] };
  const domainEl = findChild(result, 'DomainDNSGetHostsResult') ?? result;
  // The host list lives under `<DomainDNSGetHostsResult><hosts>…</hosts></…>`.
  // If the wrapping `<hosts>` is missing, treat the result element itself
  // as the container — keeps the driver working against test fixtures
  // that elide the wrapper.
  const hostsContainer = findChild(domainEl, 'hosts') ?? domainEl;
  const emailType = domainEl.attrs['EmailType'];
  return { hosts: parseHosts(hostsContainer), ...(emailType ? { emailType } : {}) };
}

/** Replace the entire host list for `domain` (`namecheap.domains.dns.setHosts`).
 *
 *  The Namecheap parameter naming uses `SLD` (second-level domain, e.g.
 *  `example`) and `TLD` (top-level domain, e.g. `com`) rather than the
 *  full `example.com`. The driver splits the host before sending. */
export async function setNamecheapHosts(
  creds: NamecheapCredentials,
  domain: string,
  hosts: NamecheapHost[],
  opts: { emailType?: string } = {},
): Promise<void> {
  const params = authParams(creds, 'namecheap.domains.dns.setHosts');
  params.set('SLD', sldOf(domain));
  params.set('TLD', tldOf(domain));
  hosts.forEach((h, i) => {
    const n = i + 1;
    if (h.hostId) params.set(`HostId${n}`, h.hostId);
    params.set(`HostName${n}`, h.name);
    params.set(`RecordType${n}`, h.type);
    params.set(`Address${n}`, h.address);
    params.set(`TTL${n}`, h.ttl);
    if (h.type === 'MX') params.set(`MXPref${n}`, h.mxPref ?? '10');
  });
  // An MX row is only kept when the email type says so; carry the domain's
  // own setting back, and default to MX when MX rows are being written.
  const emailType = opts.emailType ?? (hosts.some((h) => h.type === 'MX') ? 'MX' : undefined);
  if (emailType) params.set('EmailType', emailType);
  await namecheapRequest(creds, params);
}

/** Split a domain into its second-level + TLD pair. `example.co.uk` is
 *  NOT handled correctly by the simple split — Namecheap accepts the
 *  multi-part TLD via repeated `TLD` keys in some endpoints, but for
 *  the common case of `.com` / `.net` / `.org` / `.io` this is enough. */
function sldOf(domain: string): string {
  const parts = domain.split('.');
  return parts.length >= 2 ? parts.slice(0, -1).join('.') : domain;
}

function tldOf(domain: string): string {
  const parts = domain.split('.');
  return parts.length >= 2 ? parts[parts.length - 1]! : '';
}
