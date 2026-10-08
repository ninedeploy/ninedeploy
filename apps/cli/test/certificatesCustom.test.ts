import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  certificatesCustomDelete,
  certificatesCustomList,
  certificatesCustomReplace,
  certificatesCustomUpload,
} from '../src/commands/certificates.js';

/** 0.14: `ninedeploy certificates custom list|upload|replace|delete`. */

const h = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: vi.fn() }));

const ESC = String.fromCharCode(27);

const CERT = {
  id: 5,
  name: `wild${ESC}[2Jcard`,
  hostnames: ['*.example.com', `example.com${ESC}]8;;x`],
  subject: 'CN=*.example.com',
  issuer: `Acme CA${ESC}[5m`,
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2027-01-01T00:00:00.000Z',
  fingerprint: 'ab:cd',
  expired: false,
  coveredDomains: [{ id: 1, hostname: 'app.example.com', serviceId: 2 }],
};

function makeClient() {
  return { traefik: { customCertificates: { list: vi.fn(), upload: vi.fn(), replace: vi.fn(), delete: vi.fn() } } };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
let dir: string;
let cert: string;
let key: string;

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
  dir = mkdtempSync(path.join(tmpdir(), 'nd-certs-'));
  cert = path.join(dir, 'chain.pem');
  key = path.join(dir, 'key.pem');
  writeFileSync(cert, '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n');
  writeFileSync(key, '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('certificates custom list', () => {
  it('lists certificates with sanitised names, expiry and covered domains', async () => {
    const client = makeClient();
    client.traefik.customCertificates.list.mockResolvedValue([
      CERT,
      { ...CERT, id: 6, expired: true, issuer: null, coveredDomains: [] },
    ]);
    await certificatesCustomList(client as never);
    const text = out();
    expect(text).toContain('wildcard');
    expect(text).toContain('Acme CA');
    expect(text).toContain('app.example.com');
    expect(text).toContain('expired');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).not.toContain(`${ESC}[5m`);
  });

  it('shows the empty state and errors', async () => {
    const client = makeClient();
    client.traefik.customCertificates.list.mockResolvedValueOnce([]);
    await certificatesCustomList(client as never);
    expect(out()).toContain('No certificates uploaded');
    client.traefik.customCertificates.list.mockRejectedValue(new Error('Operator access required'));
    await certificatesCustomList(client as never);
    expect(err()).toContain('Operator access required');
  });
});

describe('certificates custom upload / replace', () => {
  it('uploads the PEM files and prints warnings', async () => {
    const client = makeClient();
    client.traefik.customCertificates.upload.mockResolvedValue({ ...CERT, warnings: ['about 900 KiB'] });
    await certificatesCustomUpload(client as never, { name: ' wildcard ', cert, key });
    expect(client.traefik.customCertificates.upload).toHaveBeenCalledWith({
      name: 'wildcard',
      certPem: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
      keyPem: '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----',
    });
    expect(out()).toContain('uploaded (id: 5)');
    expect(out()).toContain('about 900 KiB');
    expect(out()).toContain('app.example.com');
  });

  it('refuses missing flags and unreadable files, and relays errors', async () => {
    const client = makeClient();
    await certificatesCustomUpload(client as never, { cert, key });
    expect(err()).toContain('Usage: ninedeploy certificates custom upload');
    await certificatesCustomUpload(client as never, { name: 'n', cert });
    await certificatesCustomUpload(client as never, { name: 'n', cert, key: path.join(dir, 'nope.pem') });
    expect(err()).toContain('Could not read the PEM files');
    expect(client.traefik.customCertificates.upload).not.toHaveBeenCalled();
    client.traefik.customCertificates.upload.mockRejectedValue(new Error('the key does not match the certificate'));
    await certificatesCustomUpload(client as never, { name: 'n', cert, key });
    expect(err()).toContain('does not match');
  });

  it('replaces with or without a new name', async () => {
    const client = makeClient();
    client.traefik.customCertificates.replace.mockResolvedValue({ ...CERT, coveredDomains: [], warnings: [] });
    await certificatesCustomReplace(client as never, '5', { cert, key });
    expect(client.traefik.customCertificates.replace).toHaveBeenLastCalledWith(5, expect.not.objectContaining({ name: expect.anything() }));
    expect(out()).toContain('no domains yet');
    await certificatesCustomReplace(client as never, '5', { cert, key, name: 'renewed' });
    expect(client.traefik.customCertificates.replace).toHaveBeenLastCalledWith(5, expect.objectContaining({ name: 'renewed' }));
    expect(out()).toContain('Certificate #5 replaced');
    await certificatesCustomReplace(client as never, 'x', { cert, key });
    expect(err()).toContain('Usage: ninedeploy certificates custom replace');
    await certificatesCustomReplace(client as never, '5', {});
    client.traefik.customCertificates.replace.mockRejectedValue(new Error('certificate not found'));
    await certificatesCustomReplace(client as never, '5', { cert, key });
    expect(err()).toContain('certificate not found');
  });
});

describe('certificates custom delete', () => {
  it('confirms, deletes and relays errors', async () => {
    const client = makeClient();
    await certificatesCustomDelete(client as never, '0');
    expect(err()).toContain('Usage: ninedeploy certificates custom delete');
    h.prompt.mockResolvedValueOnce('nope');
    await certificatesCustomDelete(client as never, '5');
    expect(out()).toContain('Aborted');
    h.prompt.mockResolvedValueOnce('delete');
    client.traefik.customCertificates.delete.mockResolvedValueOnce({ ok: true });
    await certificatesCustomDelete(client as never, '5');
    expect(out()).toContain('Certificate #5 deleted');
    client.traefik.customCertificates.delete.mockRejectedValue(new Error('denied'));
    await certificatesCustomDelete(client as never, '5', { yes: true });
    expect(err()).toContain('denied');
  });
});
