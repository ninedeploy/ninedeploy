import { describe, expect, it } from 'vitest';
import {
  CUSTOM_CERTIFICATE_CHAIN_MAX_BYTES,
  CUSTOM_CERTIFICATE_KEY_MAX_BYTES,
  CUSTOM_CERTIFICATES_MAX,
  TRAEFIK_CUSTOM_CONFIG_MAX_BYTES,
  customCertificate,
  customCertificateReplace,
  customCertificateSaved,
  customCertificateUpload,
  traefikCustomConfig,
  traefikCustomConfigApplied,
  traefikCustomConfigInput,
  traefikCustomConfigRefusal,
  traefikCustomConfigValidation,
} from '../src/proxyConfig.js';

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----';

describe('custom dynamic config (0.14)', () => {
  it('accepts content up to 256 KiB and refuses empty or larger', () => {
    expect(traefikCustomConfigInput.parse({ content: 'http: {}\n' })).toEqual({ content: 'http: {}\n' });
    expect(traefikCustomConfigInput.safeParse({ content: '' }).success).toBe(false);
    expect(traefikCustomConfigInput.safeParse({ content: 'a'.repeat(TRAEFIK_CUSTOM_CONFIG_MAX_BYTES) }).success).toBe(true);
    expect(traefikCustomConfigInput.safeParse({ content: 'a'.repeat(TRAEFIK_CUSTOM_CONFIG_MAX_BYTES + 1) }).success).toBe(false);
    expect(traefikCustomConfigInput.safeParse({}).success).toBe(false);
  });

  it('shapes the validation result and the stored state', () => {
    const result = { ok: false, errors: [{ path: 'http.routers.svc_x', message: 'name must start with custom-' }], warnings: [] };
    expect(traefikCustomConfigValidation.parse(result)).toEqual(result);
    const none = { content: null, sha256: null, updatedAt: null, updatedBy: null, status: 'none', lastError: null };
    expect(traefikCustomConfig.parse(none)).toEqual(none);
    expect(traefikCustomConfig.safeParse({ ...none, status: 'pending' }).success).toBe(false);
  });
});

describe('custom certificates (0.14)', () => {
  it('accepts a PEM chain and an unencrypted key of each PEM flavour', () => {
    expect(customCertificateUpload.parse({ name: ' wildcard ', certPem: `${CERT}\n`, keyPem: KEY })).toEqual({
      name: 'wildcard',
      certPem: CERT,
      keyPem: KEY,
    });
    for (const kind of ['RSA ', 'EC ']) {
      const keyPem = `-----BEGIN ${kind}PRIVATE KEY-----\nAAAA\n-----END ${kind}PRIVATE KEY-----`;
      expect(customCertificateUpload.safeParse({ name: 'c', certPem: CERT, keyPem }).success, kind).toBe(true);
    }
  });

  it('refuses encrypted, mismatched or non-PEM keys and non-certificate chains', () => {
    const enc = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----';
    const mismatched = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----';
    for (const keyPem of [enc, mismatched, 'not a key', '']) {
      expect(customCertificateUpload.safeParse({ name: 'c', certPem: CERT, keyPem }).success, keyPem).toBe(false);
    }
    expect(customCertificateUpload.safeParse({ name: 'c', certPem: KEY, keyPem: KEY }).success).toBe(false);
    expect(customCertificateUpload.safeParse({ name: '  ', certPem: CERT, keyPem: KEY }).success).toBe(false);
  });

  it('caps the chain at 64 KiB and the key at 16 KiB', () => {
    const bigCert = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(CUSTOM_CERTIFICATE_CHAIN_MAX_BYTES)}\n-----END CERTIFICATE-----`;
    expect(customCertificateUpload.safeParse({ name: 'c', certPem: bigCert, keyPem: KEY }).success).toBe(false);
    const bigKey = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(CUSTOM_CERTIFICATE_KEY_MAX_BYTES)}\n-----END PRIVATE KEY-----`;
    expect(customCertificateUpload.safeParse({ name: 'c', certPem: CERT, keyPem: bigKey }).success).toBe(false);
    expect(CUSTOM_CERTIFICATES_MAX).toBe(100);
  });

  it('lets a replacement keep its name', () => {
    expect(customCertificateReplace.parse({ certPem: CERT, keyPem: KEY })).toEqual({ certPem: CERT, keyPem: KEY });
    expect(customCertificateReplace.parse({ name: 'n', certPem: CERT, keyPem: KEY }).name).toBe('n');
    expect(customCertificateReplace.safeParse({ name: 'n', certPem: CERT }).success).toBe(false);
  });

  it('shapes the listing without any key material', () => {
    const view = {
      id: 1,
      name: 'wildcard',
      hostnames: ['*.example.com', 'example.com'],
      subject: 'CN=*.example.com',
      issuer: 'CN=Example CA',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      fingerprint: 'ab'.repeat(32),
      expired: false,
      coveredDomains: [{ id: 3, hostname: 'app.example.com', serviceId: 2 }],
    };
    expect(customCertificate.parse({ ...view, keyPem: KEY })).toEqual(view);
  });

  it('shapes the write results', () => {
    const issue = { path: 'http.routers.custom-a.service', message: 'generated name' };
    expect(traefikCustomConfigApplied.parse({ ok: true, status: 'applied', sha256: 'ab', warnings: [issue] }).warnings).toEqual([issue]);
    expect(traefikCustomConfigApplied.safeParse({ ok: false, status: 'applied', sha256: 'ab', warnings: [] }).success).toBe(false);
    expect(traefikCustomConfigRefusal.parse({ error: { code: 'traefik_validation_unavailable', message: 'm' } })).toEqual({
      error: { code: 'traefik_validation_unavailable', message: 'm' },
      errors: [],
      warnings: [],
    });
    const saved = {
      id: 1,
      name: 'n',
      hostnames: ['a.example.com'],
      subject: null,
      issuer: null,
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      fingerprint: 'ab',
      expired: false,
      coveredDomains: [],
      warnings: ['big'],
    };
    expect(customCertificateSaved.parse(saved)).toEqual(saved);
    expect(customCertificateSaved.safeParse({ ...saved, warnings: undefined }).success).toBe(false);
  });
});
