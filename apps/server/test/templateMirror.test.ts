import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  convertCoolifyComposeFile,
  declareImplicitVolumes,
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

  // F317: `network_mode: host` binds every container port on the host with no
  // `ports:` key at all — the same host binding r041 refuses, by another route.
  it('skips host-networked services, including interpolated network modes', () => {
    const stack = (mode: string) => `# port: 8123\nservices:\n  app:\n    image: a:1\n    network_mode: ${mode}\n`;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation is the literal under test
    for (const mode of ['host', '"host"', '${NET:-host}']) {
      const result = convertCoolifyComposeFile('ha.yaml', stack(mode));
      expect(result).toEqual({ skip: true, reason: "service 'app' uses host networking" });
    }
    expect(convertCoolifyComposeFile('br.yaml', stack('bridge')).skip).toBe(false);
  });
});

// Coolify-only compose keys make Docker Compose reject the whole file
// ("additional properties 'exclude_from_hc' not allowed"), so they cannot ship.
describe('Coolify-only keys and variables', () => {
  const convert = (raw: string) => {
    const result = convertCoolifyComposeFile('x.yaml', raw);
    if (result.skip) throw new Error(`skipped: ${result.reason}`);
    return result.template;
  };

  it('removes exclude_from_hc and is_directory and keeps everything around them', () => {
    const raw = [
      '# port: 80',
      'services:',
      '  app:',
      '    image: a:1',
      '    exclude_from_hc: true # one-shot job',
      '    volumes:',
      '      - type: bind',
      '        source: ./data',
      '        target: /data',
      '        is_directory: true',
      '  job:',
      '    image: j:1',
      '    exclude_from_hc: false',
      '',
    ].join('\n');
    const out = convert(raw).composeContent!;
    expect(out).not.toMatch(/exclude_from_hc|is_directory/);
    const doc = yaml.load(out) as { services: Record<string, { image: string; volumes?: unknown[] }> };
    expect(doc.services.app?.image).toBe('a:1');
    expect(doc.services.app?.volumes).toEqual([{ type: 'bind', source: './data', target: '/data' }]);
    expect(doc.services.job?.image).toBe('j:1');
  });

  it('leaves a file without those keys byte-for-byte alone', () => {
    const raw = '# port: 80\nservices:\n  app:\n    image: a:1\n';
    expect(convert(raw).composeContent).toBe(raw);
  });

  it('shows the default tag of an interpolated image instead of the variable', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation is the literal under test
    const raw ='# port: 80\nservices:\n  app:\n    image: ghcr.io/x/server:${APP_TAG:-2026.5.6}\n';
    expect(convert(raw).image).toBe('ghcr.io/x/server:2026.5.6');
    // the stack itself keeps the variable, so an operator can still pin a tag
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation is the literal under test
    expect(convert(raw).composeContent).toContain('${APP_TAG:-2026.5.6}');
  });

  it('skips a stack that needs a variable only Coolify provides', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation is the literal under test
    const raw = "# port: 80\nservices:\n  app:\n    image: a:1\n    volumes:\n      - '${COOLIFY_VOLUME_APP}:/data'\n";
    expect(convertCoolifyComposeFile('kv.yaml', raw)).toEqual({ skip: true, reason: 'uses COOLIFY_VOLUME_APP, a variable only Coolify provides' });
  });
});

// Coolify declares the named volumes of a stack itself, so an upstream file may
// reference `data:/x` with no top-level `volumes:` entry. Docker Compose
// refuses such a file ("refers to undefined volume"), so the converter must
// declare them or every one of those templates fails at deploy.
describe('implicit named volumes', () => {
  const declared = (raw: string): string[] =>
    Object.keys((yaml.load(declareImplicitVolumes(raw)) as { volumes?: Record<string, unknown> }).volumes ?? {}).sort();
  const stack = (...volumes: string[]) => ['services:', '  app:', '    image: a:1', '    volumes:', ...volumes.map((v) => `      - ${v}`), ''].join('\n');

  it('declares a short-syntax named volume when the file has no volumes block', () => {
    const raw = stack('actual_data:/data');
    expect(declared(raw)).toEqual(['actual_data']);
    expect(declareImplicitVolumes(raw).startsWith(raw)).toBe(true);
  });

  it('declares long-syntax volume sources and leaves bind mounts and anonymous volumes alone', () => {
    const raw = [
      'services:',
      '  app:',
      '    image: a:1',
      '    volumes:',
      '      - type: volume',
      '        source: long_data',
      '        target: /a',
      '      - type: bind',
      '        source: ./conf',
      '        target: /b',
      '      - ./relative:/c',
      '      - /abs/path:/d',
      '      - /anonymous',
      '      - ~/home:/e',
      '      - named:/f:ro',
      '',
    ].join('\n');
    expect(declared(raw)).toEqual(['long_data', 'named']);
  });

  it('adds only the missing names to an existing block, in the block’s own indentation', () => {
    const raw = `${stack('kept:/k', 'missing:/m')}volumes:\n    kept:\n`;
    const out = declareImplicitVolumes(raw);
    expect(declared(raw)).toEqual(['kept', 'missing']);
    expect(out).toContain('\n    missing:');
  });

  it('handles an empty or inline volumes mapping and keeps a trailing comment', () => {
    const base = stack('v:/x');
    expect(declared(`${base}volumes: {}\n`)).toEqual(['v']);
    expect(declared(`${base}volumes:\n`)).toEqual(['v']);
    expect(declareImplicitVolumes(`${base}volumes: # data\n`)).toContain('volumes: # data\n  v:');
  });

  it('keeps CRLF line endings', () => {
    const out = declareImplicitVolumes(stack('v:/x').replace(/\n/g, '\r\n'));
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain('volumes:\r\n  v:\r\n');
  });

  it('does not touch a file that already declares everything, external volumes included', () => {
    const ok = `${stack('v:/x')}volumes:\n  v:\n    external: true\n`;
    expect(declareImplicitVolumes(ok)).toBe(ok);
  });

  it('skips sources it cannot name (interpolated) and unparsable files', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation is the literal under test
    const raw = stack('${DATA_DIR}:/x', '"$OTHER:/y"');
    expect(declareImplicitVolumes(raw)).toBe(raw);
    expect(declareImplicitVolumes('services: [')).toBe('services: [');
  });

  it('is applied by the converter, which keeps the upstream header', () => {
    const raw = `# port: 5006\nservices:\n  actual:\n    image: a:1\n    environment:\n      - SERVICE_URL_ACTUAL_5006\n    volumes:\n      - actual_data:/data\n`;
    const result = convertCoolifyComposeFile('actual.yaml', raw);
    expect(result.skip).toBe(false);
    if (result.skip) return;
    expect(Object.keys((yaml.load(result.template.composeContent!) as { volumes: Record<string, unknown> }).volumes)).toEqual(['actual_data']);
    expect(result.template.composeContent!.startsWith('# port: 5006')).toBe(true);
  });
});
