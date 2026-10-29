import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { convertDokployBlueprint, hostBindRefusal, type DokployBlueprint } from '../src/templates/dokployMirror.js';

/** G4.7 converter: the refusal and conversion branches the main suite does not reach. */

const domains = [{ serviceName: 'web', port: 3000, host: '${main_domain}' }];
const baseVars = { main_domain: '${domain}' };
const WEB = 'services:\n  web:\n    image: example/web:1\n';

const bp = (over: {
  id?: string;
  meta?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  env?: unknown;
  domains?: unknown;
  mounts?: unknown;
  config?: unknown;
  compose?: string;
} = {}): DokployBlueprint => ({
  id: over.id ?? 'web',
  meta: over.meta ?? { name: 'Web', description: 'A small web application used by the converter tests.', tags: ['cms'] },
  config: 'config' in over ? over.config : {
    variables: over.variables ?? baseVars,
    config: { domains: over.domains ?? domains, env: over.env, mounts: over.mounts },
  },
  compose: over.compose ?? WEB,
});

const converted = (b: DokployBlueprint) => {
  const r = convertDokployBlueprint(b);
  if (r.skip) throw new Error(`skipped: ${r.reason}`);
  return r.template;
};
const reason = (b: DokployBlueprint) => {
  const r = convertDokployBlueprint(b);
  return r.skip ? r.reason : null;
};
const envOf = (compose: string, service = 'web') =>
  (yaml.load(compose) as { services: Record<string, { environment: unknown }> }).services[service]!.environment;
/** A compose file whose web service reads each listed env key. */
const composeReading = (...keys: string[]) =>
  `services:\n  web:\n    image: example/web:1\n    environment:\n${keys.map((k) => `      ${k}: \${${k}}\n`).join('')}`;

describe('Dokploy mirror — routing refusals', () => {
  it('refuses a blueprint without config or with an invalid routed port', () => {
    expect(reason(bp({ config: null }))).toBe('no routed HTTP service (config.domains)');
    expect(reason(bp({ domains: [{ serviceName: '', port: 80 }] }))).toBe('no routed HTTP service (config.domains)');
    expect(reason(bp({ domains: [{ serviceName: 'web', port: 0 }] }))).toBe('no valid routed port');
    expect(reason(bp({ domains: [{ serviceName: 'web', port: 70000 }] }))).toBe('no valid routed port');
    expect(reason(bp({ domains: [{ serviceName: 'web', port: 'http' }] }))).toBe('no valid routed port');
  });

  it('accepts a root path and a literal host; an empty mounts list is fine', () => {
    const t = converted(bp({ domains: [{ serviceName: 'web', port: 3000, path: '/', host: 'example.com' }], mounts: [], variables: {} }));
    expect(t.port).toBe(3000);
    expect(t.composeService).toBe('web');
  });
});

describe('Dokploy mirror — env and generator branches', () => {
  it('reads env arrays of KEY=VALUE strings and {KEY = VALUE} tables, skipping invalid entries', () => {
    const t = converted(bp({
      env: ['A=1', { B: 2, C: true, 'bad-key': 'x', D: { nested: 1 } }, 'noequals', '=leading', 5, null],
      compose: composeReading('A', 'B', 'C'),
    }));
    expect(envOf(t.composeContent!)).toEqual({ A: '1', B: '2', C: 'true' });
  });

  it('keeps numeric and boolean variables and drops other kinds', () => {
    const t = converted(bp({
      variables: { ...baseVars, port: 8080, flag: false, skipped: { a: 1 } },
      env: { PORT: '${port}', FLAG: '${flag}' },
      compose: composeReading('PORT', 'FLAG'),
    }));
    expect(envOf(t.composeContent!)).toEqual({ PORT: '8080', FLAG: 'false' });
    expect(reason(bp({ variables: { ...baseVars, skipped: { a: 1 } }, env: { X: '${skipped}' }, compose: composeReading('X') })))
      .toBe('references ${skipped}, which the blueprint does not define');
  });

  it('gives each inline generator in one value its own token, and an inline ${domain} the routed host', () => {
    const t = converted(bp({ env: { X: '${password}-${password:24}', HOST: 'https://${domain}' }, compose: composeReading('X', 'HOST') }));
    expect(envOf(t.composeContent!)).toEqual({
      X: '${SERVICE_PASSWORD_16_X}-${SERVICE_PASSWORD_24_X_2}',
      HOST: 'https://${SERVICE_FQDN_WEB}',
    });
  });

  it('maps hash and base64 sizes that have an equivalent, and a weird variable name to a safe token key', () => {
    const t = converted(bp({
      variables: { ...baseVars, '-h': '${hash:64}', b: '${base64:128}', '__': '${password}' },
      env: { H: '${-h}', B: '${b}', U: '${__}' },
      compose: composeReading('H', 'B', 'U'),
    }));
    expect(envOf(t.composeContent!)).toEqual({ H: '${SERVICE_HEX_64_H}', B: '${SERVICE_REALBASE64_128_B}', U: '${SERVICE_PASSWORD_16_VALUE}' });
  });

  it.each([
    ['${password:4}', 'uses ${password:4}'],
    ['${password:abc}', 'uses ${password:abc}'],
    ['${hash}', 'uses ${hash} (only 32, 64 or 128 characters have an equivalent)'],
    ['${hash:16}', 'uses ${hash:16} (only 32, 64 or 128 characters have an equivalent)'],
    ['${username:x}', 'uses ${username:x}, which has no equivalent here'],
    ['${email:x}', 'uses ${email:x}, which has no equivalent here'],
    ['${domain:x}', 'uses ${domain:x}, which has no equivalent here'],
    ['${jwt}', 'uses ${jwt}, which has no equivalent here'],
    ['${randomPort}', 'uses ${randomPort}, which has no equivalent here'],
  ])('refuses %s', (value, why) => {
    expect(reason(bp({ env: { X: value }, compose: composeReading('X') }))).toBe(why);
  });

  it('refuses self-referencing variables and env keys', () => {
    expect(reason(bp({ variables: { ...baseVars, a: 'x${a}' }, env: { X: '${a}' }, compose: composeReading('X') }))).toBe('variable a refers to itself');
    expect(reason(bp({ env: { X: '${Y}', Y: '${X}' }, compose: composeReading('X') }))).toBe('env X refers to itself');
  });

  it('resolves env-to-env references with and without defaults like compose does', () => {
    const t = converted(bp({
      env: {
        EMPTY: '',
        FULL: 'v',
        A: '${EMPTY:-dflt}', // empty + :- → the default
        B: '${EMPTY-dflt}', // empty but set + - → empty
        C: '${FULL:-dflt}', // set → the value
        D: '${MISSING-dflt}', // unset → the default
        E: '${E}', // the shell's own (unset) E → empty
        F: '${F-own}', // the shell's own F with a default → the default
      },
      compose: composeReading('A', 'B', 'C', 'D', 'E', 'F'),
    }));
    expect(envOf(t.composeContent!)).toEqual({ A: 'dflt', B: '', C: 'v', D: 'dflt', E: '', F: 'own' });
  });

  it('folds bare $KEY and keeps a ${KEY:-default} default when the folded value is empty', () => {
    const t = converted(bp({
      env: { EMPTY: '', NAME: 'app' },
      compose: 'services:\n  web:\n    image: example/web:1\n    command: ["run", "$NAME", "${EMPTY:-fallback}", "${EMPTY}"]\n    init: true\n    scale: 1\n',
    }));
    const doc = yaml.load(t.composeContent!) as { services: { web: { command: string[]; init: boolean; scale: number } } };
    expect(doc.services.web).toMatchObject({ command: ['run', 'app', 'fallback', ''], init: true, scale: 1 });
  });
});

describe('Dokploy mirror — compose refusals', () => {
  it('refuses unparsable YAML and a compose file without services', () => {
    expect(reason(bp({ compose: 'services: [\n' }))).toMatch(/^unparsable YAML: /);
    expect(reason(bp({ compose: '' }))).toBe('no services');
    expect(reason(bp({ compose: 'services: {}\n' }))).toBe('no services');
  });

  it('refuses what the compose preflight refuses (inline file content)', () => {
    expect(reason(bp({ compose: `${WEB}    labels:\n      content: inline\n` }))).toMatch(/inline 'content:' are not supported/);
  });

  it('re-checks the folded file: an env value cannot turn on a build', () => {
    expect(reason(bp({ env: { PP: 'build' }, compose: `${WEB}    pull_policy: \${PP}\n` }))).toBe("service 'web' uses pull_policy build");
  });

  it('rethrows an error that is not a refusal', () => {
    expect(() => convertDokployBlueprint({ ...bp(), meta: null as unknown as Record<string, unknown> })).toThrow(TypeError);
  });
});

describe('Dokploy mirror — metadata fallbacks', () => {
  it('derives name, description, tagline, category, emoji and image when meta is sparse', () => {
    const t = converted(bp({
      id: 'My_App.v2',
      meta: { tags: 'not-an-array', links: 'nope' },
      compose: 'services:\n  web:\n    command: ["serve"]\n',
    }));
    expect(t).toMatchObject({
      id: 'dokploy-my-app-v2',
      name: 'My App V2',
      description: 'My App V2 compose stack',
      tagline: 'My App V2 compose stack',
      category: 'Tools',
      emoji: '🧩',
      image: 'docker.io/library/web',
    });
    expect(t.website).toBeUndefined();
    expect(t.docs).toBeUndefined();
  });

  it('takes docs from the github link, and exposes configurable ${KEY:-default} env', () => {
    const t = converted(bp({
      meta: { name: 'X', description: 'Short.', tags: ['unknowncat', 3], links: { github: 'https://github.com/x/x' } },
      compose: `${WEB}    environment:\n      TZ: \${TZ:-UTC}\n`,
    }));
    expect(t.tagline).toBe('Short.');
    expect(t.category).toBe('Unknowncat');
    expect(t.docs).toBe('https://github.com/x/x');
    expect(t.env).toEqual([{ key: 'TZ', value: 'UTC', secret: false }]);
  });
});

describe('hostBindRefusal — direct', () => {
  const svc = (entry: unknown) => hostBindRefusal({ services: { s: entry } });
  const vol = (v: unknown) => svc({ image: 'x', volumes: [v] });

  it('tolerates empty or odd documents', () => {
    expect(hostBindRefusal(null)).toBeNull();
    expect(hostBindRefusal(undefined)).toBeNull();
    expect(hostBindRefusal({ services: 'nope' })).toBeNull();
    expect(svc({ image: 'x', 'x-meta': { a: 1 }, volumes: 'not-a-list' })).toBeNull();
  });

  it('allows bridge/none network modes and refuses others', () => {
    expect(svc({ image: 'x', network_mode: 'bridge' })).toBeNull();
    expect(svc({ image: 'x', network_mode: ' none ' })).toBeNull();
    expect(svc({ image: 'x', network_mode: '' })).toBeNull();
    expect(svc({ image: 'x', network_mode: 'host' })).toBe("service 's' joins network mode host");
    expect(svc({ image: 'x', pull_policy: 'always' })).toBeNull();
  });

  it('reasons about every volume shape', () => {
    expect(vol('/anonymous')).toBeNull();
    expect(vol({ type: 'volume', source: 'data', target: '/d' })).toBeNull();
    expect(vol({ type: 'tmpfs', target: '/t' })).toBeNull();
    expect(vol({ source: 'data', target: '/d' })).toBeNull();
    expect(vol(42)).toBeNull();
    expect(vol({ type: 'npipe', source: '\\\\.\\pipe\\docker_engine', target: '/p' })).toBe("service 's' uses a npipe mount");
    expect(vol({ type: 'bind', source: '/etc/localtime', target: '/etc/localtime', read_only: true })).toBeNull();
    expect(vol({ type: 'bind', source: '/etc/localtime', target: '/etc/localtime' })).toBe("service 's' mounts the host path /etc/localtime");
    expect(vol({ type: 'bind', target: '/x' })).toBe("service 's' mounts an unusual source ()");
    expect(vol({ type: 'bind', source: 'C:\\Users', target: '/x' })).toBe("service 's' mounts the host path C:\\Users");
    expect(vol({ type: 'bind', source: '\\\\server\\share', target: '/x' })).toBe("service 's' mounts the host path \\\\server\\share");
    expect(vol({ type: 'bind', source: 'a\\..\\b', target: '/x' })).toBe("service 's' mounts a path outside the stack (a\\..\\b)");
    expect(vol('..:/x')).toBe("service 's' mounts a path outside the stack (..)");
    expect(vol('@weird:/x')).toBe("service 's' mounts an unusual source (@weird)");
    expect(vol('/etc/timezone:/etc/timezone:ro,z')).toBeNull();
    expect(vol('./conf:/conf:rw')).toBeNull();
  });

  it('checks top-level networks and volumes', () => {
    const top = (doc: Record<string, unknown>) => hostBindRefusal({ services: { s: { image: 'x' } }, ...doc });
    expect(top({ networks: { a: null, b: { driver: 'bridge', external: false } } })).toBeNull();
    expect(top({ networks: { n: { driver_opts: { mtu: '1400' } } } })).toBe("network 'n' sets driver options");
    expect(top({ volumes: { a: null, b: { driver: 'local', external: false } } })).toBeNull();
    expect(top({ networks: 'x', volumes: 'y' })).toBeNull();
  });
});

describe('hostBindRefusal on a service that is not a mapping', () => {
  it('refuses it instead of crashing', async () => {
    const { hostBindRefusal } = await import('../src/templates/dokployMirror.js');
    expect(hostBindRefusal({ services: { s: null } })).toBe("service 's' is not a mapping");
    expect(hostBindRefusal({ services: { s: 'nginx' } })).toBe("service 's' is not a mapping");
    expect(hostBindRefusal({ services: { s: [] } })).toBe("service 's' is not a mapping");
  });
});
