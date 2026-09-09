import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  convertCoolifyComposeFile,
  extractConfigurableEnv,
  parseHeader,
  pickMainService,
} from '../src/templates/mirror.js';

const UMAMI_LIKE = `# documentation: https://umami.is
# slogan: Simple analytics with privacy.
# category: analytics
# tags: analytics
# logo: svgs/umami.svg
# port: 3000

services:
  umami:
    image: ghcr.io/umami-software/umami:3.0.3
    environment:
      - SERVICE_URL_UMAMI_3000
      - DATABASE_URL=postgres://$SERVICE_USER_POSTGRES:$SERVICE_PASSWORD_POSTGRES@postgresql:5432/$POSTGRES_DB
      - APP_SECRET=$SERVICE_PASSWORD_64_UMAMI
    depends_on:
      postgresql:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:3000/api/heartbeat"]
  postgresql:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=\${POSTGRES_DB:-umami}
`;

describe('upstream header parsing', () => {
  it('extracts metadata and stops at the first YAML line', () => {
    const header = parseHeader(UMAMI_LIKE);
    expect(header.port).toBe('3000');
    expect(header.category).toBe('analytics');
    expect(header.slogan).toBe('Simple analytics with privacy.');
  });
});

describe('main-service selection', () => {
  it('prefers the service named by a SERVICE_URL token with the header port', () => {
    const doc = yaml.load(UMAMI_LIKE) as { services: Parameters<typeof pickMainService>[0] };
    const picked = pickMainService(doc.services, UMAMI_LIKE, 3000)!;
    expect(picked.name).toBe('umami');
    expect(picked.via).toBe('url-token');
  });
});

describe('configurable env extraction', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion is the literal under test
  it('surfaces ${VAR:-default} pairs and skips magic tokens', () => {
    const env = extractConfigurableEnv(UMAMI_LIKE)!;
    expect(env).toEqual([{ key: 'POSTGRES_DB', value: 'umami', secret: false }]);
  });
});

describe('main-service infra guard', () => {
  it('never routes to a backing store when falling back to first service', () => {
    const raw = ['services:', '  db:', '    image: postgres:16', '  web:', '    image: glitchtip/glitchtip:4', ''].join('\n');
    const doc = yaml.load(raw) as { services: Parameters<typeof pickMainService>[0] };
    const picked = pickMainService(doc.services, raw, 9000)!;
    expect(picked.name).toBe('web');
    expect(picked.via).toBe('first-service');
  });
});

describe('upstream file conversion', () => {
  it('converts a routed app+db stack', () => {
    const result = convertCoolifyComposeFile('umami.yaml', UMAMI_LIKE);
    expect(result.skip).toBe(false);
    if (result.skip) return;
    expect(result.mainServiceVia).toBe('url-token');
    const t = result.template;
    expect(t.id).toBe('coolify-umami');
    expect(t.composeService).toBe('umami');
    expect(t.port).toBe(3000);
    expect(t.category).toBe('Analytics');
    expect(t.composeContent).toContain('services:');
    expect(t.image).toBe('ghcr.io/umami-software/umami:3.0.3');
  });

  it('skips upstream-ignored files', () => {
    const result = convertCoolifyComposeFile('x.yaml', '# ignore: true\n# port: 80\nservices:\n  a:\n    image: a:1\n');
    expect(result).toEqual({ skip: true, reason: 'ignored upstream' });
  });

  it('skips files without a routed port header', () => {
    const result = convertCoolifyComposeFile('gitea.yaml', '# slogan: git\nservices:\n  gitea:\n    image: gitea/gitea:latest\n');
    expect(result).toEqual({ skip: true, reason: 'no routed HTTP port (# port header)' });
  });

  it('skips host-port publishers like game servers', () => {
    const raw = `# port: 25565\nservices:\n  mc:\n    image: itzg/minecraft-server\n    ports:\n      - \${PORT}:25565\n`;
    const result = convertCoolifyComposeFile('minecraft.yaml', raw);
    expect(result.skip).toBe(true);
    if (result.skip) expect(result.reason).toContain('host ports');
  });

  it('skips env_file stacks', () => {
    const raw = '# port: 80\nservices:\n  a:\n    image: a:1\n    env_file: shared.env\n';
    const result = convertCoolifyComposeFile('a.yaml', raw);
    expect(result.skip).toBe(true);
    if (result.skip) expect(result.reason).toContain('env_file');
  });

  it('skips build-context-only services', () => {
    const raw = '# port: 80\nservices:\n  a:\n    build: ./docker\n';
    const result = convertCoolifyComposeFile('build.yaml', raw);
    expect(result.skip).toBe(true);
    if (result.skip) expect(result.reason).toContain('build context');
  });

  // r041: the guard used to inspect only SHORT-syntax port entries (strings).
  // The compose LONG syntax expresses the same deterministic host binding as
  // an object — `{ target: 80, published: 8080 }` or an explicit `host_ip` —
  // and those slipped past the check, letting a mirrored third-party template
  // grab an arbitrary host port (80/443/panel included) at deploy time.
  it('skips long-syntax port entries that publish deterministic host ports', () => {
    const published = [
      '# port: 80',
      'services:',
      '  a:',
      '    image: a:1',
      '    ports:',
      '      - target: 80',
      '        published: 8080',
      '',
    ].join('\n');
    const hostIp = [
      '# port: 80',
      'services:',
      '  a:',
      '    image: a:1',
      '    ports:',
      '      - target: 80',
      '        host_ip: 127.0.0.1',
      '',
    ].join('\n');
    const viaPublished = convertCoolifyComposeFile('published.yaml', published);
    expect(viaPublished.skip).toBe(true);
    if (viaPublished.skip) expect(viaPublished.reason).toContain('host ports');
    const viaHostIp = convertCoolifyComposeFile('hostip.yaml', hostIp);
    expect(viaHostIp.skip).toBe(true);
    if (viaHostIp.skip) expect(viaHostIp.reason).toContain('host ports');
  });
});
