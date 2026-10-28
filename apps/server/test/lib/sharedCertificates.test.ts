/** G5.7 certificates shared across node proxies (`lib/sharedCertificates.ts`). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { certificatesForNode, parseAcmeStorage } from '../../src/lib/sharedCertificates.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/certs/${name}`, import.meta.url), 'utf8');
/** As Traefik stores them: base64 of the PEM text. */
const b64 = (pem: string) => Buffer.from(pem).toString('base64');
const acmeJson = (certs: Array<[string, string]>) =>
  JSON.stringify({
    letsencrypt: {
      Account: { Email: 'ops@example.test' },
      Certificates: certs.map(([crt, key]) => ({ domain: { main: 'x' }, certificate: b64(fixture(crt)), key: b64(fixture(key)), Store: 'default' })),
    },
  });

describe('parseAcmeStorage', () => {
  it('reads certificates with their keys and names, and skips what does not parse', () => {
    const certs = parseAcmeStorage(acmeJson([['valid.crt', 'valid.key'], ['wildcard.crt', 'wildcard.key']]));
    expect(certs.map((c) => c.hostnames)).toEqual([['app.example.test', 'www.app.example.test'], ['*.example.test']]);
    expect(certs[0]!.keyPem).toContain('PRIVATE KEY');
    expect(parseAcmeStorage('not json')).toEqual([]);
    expect(parseAcmeStorage(JSON.stringify({ letsencrypt: { Certificates: [{ certificate: 'junk', key: 'junk' }] } }))).toEqual([]);
    expect(parseAcmeStorage(JSON.stringify({ letsencrypt: { Certificates: null } }))).toEqual([]);
  });
});

describe('certificatesForNode', () => {
  const acme = parseAcmeStorage(
    acmeJson([
      ['valid.crt', 'valid.key'],
      ['wildcard.crt', 'wildcard.key'],
      ['expired.crt', 'expired.key'],
    ]),
  );
  const none = () => false;

  it('gives only certificates that cover a host the node routes', () => {
    expect(certificatesForNode(acme, ['app.example.test'], none).map((c) => c.hostnames[0])).toEqual(['app.example.test']);
    expect(certificatesForNode(acme, ['api.example.test'], none).map((c) => c.hostnames[0])).toEqual(['*.example.test']);
    expect(certificatesForNode(acme, ['other.example.org'], none)).toEqual([]);
  });

  it('never gives an expired certificate', () => {
    expect(certificatesForNode(acme, ['expired.example.test'], none).map((c) => c.hostnames[0])).toEqual(['*.example.test']);
  });

  it('gives one certificate for hosts it covers together, and none where an upload already covers the host', () => {
    expect(certificatesForNode(acme, ['a.example.test', 'b.example.test'], none)).toHaveLength(1);
    expect(certificatesForNode(acme, ['a.example.test'], (h) => h === 'a.example.test')).toEqual([]);
  });
});
