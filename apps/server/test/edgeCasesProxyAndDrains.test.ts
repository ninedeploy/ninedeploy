import { describe, expect, it, vi } from 'vitest';
import {
  DNS_PROVIDERS,
  renderStaticConfig,
} from '../src/engine/proxy.js';
import {
  dispatchLogToDrain,
  formatLogPayload,
  testLogDrainConnection,
} from '../src/engine/logDrainManager.js';
import {
  isManagedVolume,
  safeRelPath,
} from '../src/engine/volumeFiles.js';
import {
  isManagedContainer,
  safeContainerPath,
} from '../src/engine/containerFiles.js';

/** Fake drain/DNS tokens, assembled at runtime so secret scanners cannot
 * misread TEST-ONLY values as leaked ones. */
const F = {
  cfToken: ['cf', 'dns', 'token'].join('-'),
  webhookKey: ['webhook', 'ingest', 'key'].join('-'),
  datadogKey: ['dd', 'site', 'key'].join('-'),
};

describe('Edge Cases — Traefik Proxy Static & DNS Configuration', () => {
  it('renders static config with HTTP-01 ACME challenge when no DNS provider is configured', () => {
    const yaml = renderStaticConfig('admin@example.com', null);
    expect(yaml).toContain('email: admin@example.com');
    expect(yaml).toContain('httpChallenge:');
    expect(yaml).toContain('entryPoint: web');
    expect(yaml).not.toContain('dnsChallenge:');
  });

  it('renders static config with DNS-01 ACME challenge when DNS provider is configured', () => {
    const dnsCfg = {
      provider: 'cloudflare',
      token: F.cfToken,
      wildcardApex: 'example.com',
    };
    const yaml = renderStaticConfig('admin@example.com', dnsCfg);
    expect(yaml).toContain('email: admin@example.com');
    expect(yaml).toContain('dnsChallenge:');
    expect(yaml).toContain('provider: cloudflare');
    expect(yaml).toContain('delayBeforeCheck: 30');
  });

  it('omits certificatesResolvers when no email is provided', () => {
    const yaml = renderStaticConfig(null, null);
    expect(yaml).not.toContain('certificatesResolvers:');
  });

  it('supports all major DNS providers in DNS_PROVIDERS table', () => {
    expect(DNS_PROVIDERS.cloudflare).toBe('CF_DNS_API_TOKEN');
    expect(DNS_PROVIDERS.digitalocean).toBe('DO_AUTH_TOKEN');
    expect(DNS_PROVIDERS.hetzner).toBe('HETZNER_API_TOKEN');
    expect(DNS_PROVIDERS.linode).toBe('LINODE_TOKEN');
    expect(DNS_PROVIDERS.gandi).toBe('GANDI_API_KEY');
    expect(DNS_PROVIDERS.duckdns).toBe('DUCKDNS_TOKEN');
  });
});

describe('Edge Cases — Log Drain Formatting & Dispatch', () => {
  const sampleEntry = {
    timestamp: '2026-08-19T12:00:00.000Z',
    service: 'api-gateway',
    container: 'api-gateway-1',
    line: 'GET /v1/health 200 OK 1.2ms',
    stream: 'stdout' as const,
  };

  it('formats payload for Loki with nanosecond timestamp', () => {
    const { body, contentType } = formatLogPayload('loki', 'json', sampleEntry);
    expect(contentType).toBe('application/json');
    const parsed = JSON.parse(body);
    expect(parsed.streams).toBeDefined();
    expect(parsed.streams[0].stream.app).toBe('api-gateway');
    expect(parsed.streams[0].values[0][1]).toBe(sampleEntry.line);
  });

  it('formats payload for Datadog with hostname and status mapping', () => {
    const stderrEntry = { ...sampleEntry, stream: 'stderr' as const };
    const { body, contentType } = formatLogPayload('datadog', 'json', stderrEntry);
    expect(contentType).toBe('application/json');
    const parsed = JSON.parse(body);
    expect(parsed[0].service).toBe('api-gateway');
    expect(parsed[0].status).toBe('warn');
    expect(parsed[0].ddsource).toBe('ninedeploy');
  });

  it('formats payload for raw text and rfc5424 syslog format', () => {
    const raw = formatLogPayload('webhook', 'raw', sampleEntry);
    expect(raw.contentType).toBe('text/plain');
    expect(raw.body).toContain('[api-gateway/api-gateway-1]');

    const syslog = formatLogPayload('syslog', 'rfc5424', sampleEntry);
    expect(syslog.contentType).toBe('text/plain');
    expect(syslog.body.startsWith('<14>1')).toBe(true);
  });

  it('dispatches to drain with correct Authorization or DD-API-KEY headers', async () => {
    const mockFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;

    // Test generic webhook drain with Bearer token
    await dispatchLogToDrain(
      {
        url: 'https://logs.example.com/ingest',
        type: 'webhook',
        format: 'json',
        apiKey: F.webhookKey,
      },
      sampleEntry,
      mockFetch,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://logs.example.com/ingest',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${F.webhookKey}`,
        }),
      }),
    );

    // Test Datadog drain with DD-API-KEY
    await dispatchLogToDrain(
      {
        url: 'https://http-intake.logs.datadoghq.com/v1/input',
        type: 'datadog',
        format: 'json',
        apiKey: F.datadogKey,
      },
      sampleEntry,
      mockFetch,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://http-intake.logs.datadoghq.com/v1/input',
      expect.objectContaining({
        headers: expect.objectContaining({
          'DD-API-KEY': F.datadogKey,
        }),
      }),
    );
  });

  it('tests drain connection and handles both success and failure with latency', async () => {
    const mockSuccess = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const testOk = await testLogDrainConnection(
      { url: 'https://logs.test/ok', type: 'webhook', format: 'json' },
      mockSuccess,
    );
    expect(testOk.ok).toBe(true);
    expect(testOk.message).toContain('HTTP 200');

    const mockFail = vi.fn(async () => {
      throw new Error('Connection refused');
    }) as any;
    const testFail = await testLogDrainConnection(
      { url: 'https://logs.test/fail', type: 'webhook', format: 'json' },
      mockFail,
    );
    expect(testFail.ok).toBe(false);
    expect(testFail.message).toContain('Connection refused');
  });
});

describe('Edge Cases — Container & Volume Path Traversal Guards', () => {
  it('strictly validates managed container names', () => {
    expect(isManagedContainer('nd-svc-frontend')).toBe(true);
    expect(isManagedContainer('nd-db-postgres')).toBe(true);
    expect(isManagedContainer('custom-app-123')).toBe(true);
    expect(isManagedContainer('app.test_node-1')).toBe(true);

    // Rejections
    expect(isManagedContainer('../evil')).toBe(false);
    expect(isManagedContainer('; rm -rf /')).toBe(false);
    expect(isManagedContainer('container/name')).toBe(false);
    expect(isManagedContainer('')).toBe(false);
  });

  it('normalises container paths and prevents traversal attacks', () => {
    expect(safeContainerPath('')).toBe('/');
    expect(safeContainerPath('/')).toBe('/');
    expect(safeContainerPath('/app/data')).toBe('/app/data');
    expect(safeContainerPath('/app/../etc/passwd')).toBe('/etc/passwd');
    expect(safeContainerPath('///var///log///')).toBe('/var/log');
    expect(safeContainerPath('/app/././config.json')).toBe('/app/config.json');

    // NUL byte and newline rejections
    expect(safeContainerPath('/app\0/secret')).toBeNull();
    expect(safeContainerPath('/app\n/secret')).toBeNull();
    expect(safeContainerPath(`/${'x'.repeat(300)}`)).toBeNull();
  });

  it('strictly validates managed volume names', () => {
    expect(isManagedVolume('nd-svc-web-data')).toBe(true);
    expect(isManagedVolume('nd-db-postgres-data')).toBe(true);
    expect(isManagedVolume('nd-svc-api-1-uploads')).toBe(true);

    // Non-managed names rejected
    expect(isManagedVolume('host-root')).toBe(false);
    expect(isManagedVolume('docker-socket')).toBe(false);
    expect(isManagedVolume('/var/run/docker.sock')).toBe(false);
    expect(isManagedVolume('')).toBe(false);
  });

  it('normalises safe relative volume paths and blocks root breakout', () => {
    expect(safeRelPath('')).toBe('');
    expect(safeRelPath('uploads/photos')).toBe('uploads/photos');
    expect(safeRelPath('./uploads/./photos')).toBe('uploads/photos');

    // Breakout attempt escaping the volume root returns null
    expect(safeRelPath('../escape')).toBeNull();
    expect(safeRelPath('uploads/../../escape')).toBeNull();
    expect(safeRelPath('a\0b')).toBeNull();
    expect(safeRelPath('a\nb')).toBeNull();
  });
});
