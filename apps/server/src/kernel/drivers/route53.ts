import { signRequest } from '../../lib/awsSigV4.js';
import { quotedTxt, ttlOrDefault, zoneForHost } from '../../lib/dnsProviderCredentials.js';
import { guardedFetch } from '../../lib/egressGuard.js';
import { encodeXmlEntities, findChild, findChildren, parseXml, type XmlElement } from '../../lib/xml.js';
import type { DomainRecordResult, DomainRecordSpec, DomainRecordType, DomainZone, IDomainProvider } from '../types.js';

export type Route53CredentialsProvider = () => Promise<{ accessKeyId: string; secretAccessKey: string } | null>;

const ENDPOINT = 'https://route53.amazonaws.com/2013-04-01';
const NS = 'https://route53.amazonaws.com/doc/2013-04-01/';

/** What it takes to delete a Route53 record: the API has no record ids. */
interface RecordRef {
  n: string;
  t: DomainRecordType;
  ttl: number;
  v: string;
}

const encodeRef = (ref: RecordRef): string => Buffer.from(JSON.stringify(ref)).toString('base64url');

function decodeRef(id: string): RecordRef | null {
  try {
    const ref = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as RecordRef;
    return typeof ref.n === 'string' && typeof ref.t === 'string' && typeof ref.ttl === 'number' && typeof ref.v === 'string' ? ref : null;
  } catch {
    return null;
  }
}

const text = (el: XmlElement | undefined, name: string): string => (el ? (findChild(el, name)?.text ?? '') : '');

/**
 * `IDomainProvider` for Amazon Route 53 (G3.5), signed with SigV4
 * (`lib/awsSigV4.ts`, no SDK). Private hosted zones are skipped: a public
 * hostname's record never belongs in one.
 *
 * Route 53 deletes a record by repeating it exactly (name, type, TTL,
 * value), so the record id this driver returns is that tuple, encoded.
 */
export class Route53Provider implements IDomainProvider {
  readonly name = 'route53';

  constructor(private readonly credentials: Route53CredentialsProvider) {}

  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<XmlElement> {
    const creds = await this.credentials();
    if (!creds) throw new Error('Route 53 is not configured. Save an IAM access key under Settings → Integrations → DNS records.');
    const url = `${ENDPOINT}${path}`;
    const headers: Record<string, string> = body ? { 'content-type': 'application/xml' } : {};
    const signed = signRequest({ method, url, headers, ...(body ? { body } : {}), service: 'route53', region: 'us-east-1' }, creds);
    const { host: _host, ...sendHeaders } = signed.headers;
    void _host;
    const res = await guardedFetch(url, { method, headers: sendHeaders, ...(body ? { body } : {}), signal: AbortSignal.timeout(15_000) });
    const raw = await res.text();
    if (!res.ok) {
      const code = /<Code>([^<]*)<\/Code>/.exec(raw)?.[1];
      const message = /<Message>([^<]*)<\/Message>/.exec(raw)?.[1];
      throw new Error(`Route 53 API error: ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`);
    }
    return parseXml(raw);
  }

  async listZones(): Promise<DomainZone[]> {
    const zones: DomainZone[] = [];
    let marker: string | null = null;
    do {
      const root = await this.request('GET', `/hostedzone?maxitems=100${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`);
      for (const z of findChildren(findChild(root, 'HostedZones') ?? root, 'HostedZone')) {
        if (text(findChild(z, 'Config'), 'PrivateZone') === 'true') continue;
        zones.push({ id: text(z, 'Id').replace(/^\/hostedzone\//, ''), name: text(z, 'Name').replace(/\.$/, '') });
      }
      marker = text(root, 'IsTruncated') === 'true' ? text(root, 'NextMarker') || null : null;
    } while (marker);
    return zones;
  }

  async findZoneForHost(hostname: string): Promise<DomainZone | null> {
    return zoneForHost(await this.listZones(), hostname);
  }

  private async change(zoneId: string, action: 'CREATE' | 'DELETE', ref: RecordRef): Promise<void> {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ChangeResourceRecordSetsRequest xmlns="${NS}"><ChangeBatch><Changes><Change>` +
      `<Action>${action}</Action><ResourceRecordSet>` +
      `<Name>${encodeXmlEntities(ref.n)}</Name><Type>${ref.t}</Type><TTL>${ref.ttl}</TTL>` +
      `<ResourceRecords><ResourceRecord><Value>${encodeXmlEntities(ref.v)}</Value></ResourceRecord></ResourceRecords>` +
      `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
    await this.request('POST', `/hostedzone/${encodeURIComponent(zoneId)}/rrset`, body);
  }

  async createRecord(zoneId: string, spec: DomainRecordSpec): Promise<DomainRecordResult> {
    const ref: RecordRef = {
      n: `${spec.hostname.toLowerCase()}.`,
      t: spec.type,
      ttl: ttlOrDefault(spec.ttl, 60, 300),
      v: spec.type === 'TXT' ? quotedTxt(spec.content) : spec.content,
    };
    try {
      await this.change(zoneId, 'CREATE', ref);
    } catch (err) {
      if (/already exists/i.test(err instanceof Error ? err.message : '')) {
        throw new Error(`Route 53 already has a ${spec.type} record for ${spec.hostname}; it was left unchanged`);
      }
      throw err;
    }
    return { recordId: encodeRef(ref), hostname: spec.hostname, type: spec.type };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const ref = decodeRef(recordId);
    if (!ref) return;
    try {
      await this.change(zoneId, 'DELETE', ref);
    } catch (err) {
      // InvalidChangeBatch "… it was not found": already gone, or changed by hand.
      if (!/not found/i.test(err instanceof Error ? err.message : '')) throw err;
    }
  }
}
