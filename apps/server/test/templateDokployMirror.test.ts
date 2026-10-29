import yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parseMagicToken, scanMagicTokens } from '../src/engine/magicVars.js';
import { convertDokployBlueprint, type DokployBlueprint } from '../src/templates/dokployMirror.js';
import { parseBundle } from '../src/templates/registry.js';

/** G4.7: Dokploy blueprint → NineDeploy compose template. */

const v = (body: string) => ['$', '{', body, '}'].join('');

const N8N_TOML = `
[variables]
main_domain = "${v('domain')}"

[config]
mounts = []

[[config.domains]]
serviceName = "n8n"
port = 5_678
host = "${v('main_domain')}"

[config.env]
N8N_HOST = "${v('main_domain')}"
N8N_PORT = "5678"
`;

const N8N_COMPOSE = `services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:1.104.0
    environment:
      - N8N_HOST=${v('N8N_HOST')}
      - N8N_PORT=$N8N_PORT
      - WEBHOOK_URL=https://${v('N8N_HOST')}/
    volumes:
      - n8n_data:/home/node/.n8n
`;

const bp = (over: Partial<DokployBlueprint> & { toml?: string } = {}): DokployBlueprint => ({
  id: over.id ?? 'n8n',
  meta: over.meta ?? {
    name: 'n8n',
    description: 'n8n is an open-source, low-code platform for automating workflows. Self-host it in minutes.',
    tags: ['automation'],
    links: { github: 'https://github.com/n8n-io/n8n', website: 'https://n8n.io/', docs: 'https://docs.n8n.io/' },
  },
  config: over.config ?? parseToml(over.toml ?? N8N_TOML),
  compose: over.compose ?? N8N_COMPOSE,
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
const envOf = (compose: string, service: string) =>
  ((yaml.load(compose) as { services: Record<string, { environment: unknown }> }).services[service]!.environment);

describe('Dokploy mirror (G4.7)', () => {
  it('folds the .env into the compose file and routes the domain service', () => {
    const t = converted(bp());
    expect(t).toMatchObject({
      id: 'dokploy-n8n',
      name: 'n8n',
      tagline: 'n8n is an open-source, low-code platform for automating workflows.',
      category: 'Automation',
      emoji: '🤖',
      image: 'docker.n8n.io/n8nio/n8n:1.104.0',
      port: 5678,
      composeService: 'n8n',
      website: 'https://n8n.io/',
      docs: 'https://docs.n8n.io/',
    });
    expect(t.requires).toContain('Dokploy mirror (MIT)');
    expect(envOf(t.composeContent!, 'n8n')).toEqual([
      `N8N_HOST=${v('SERVICE_FQDN_N8N')}`,
      'N8N_PORT=5678',
      `WEBHOOK_URL=https://${v('SERVICE_FQDN_N8N')}/`,
    ]);
    // The production bundle parser accepts it.
    expect(parseBundle({ version: 2, templates: [t] })).toHaveLength(1);
  });

  it('turns each generator into the magic token that makes the same kind of value', () => {
    const toml = `
[variables]
main_domain = "${v('domain')}"
db_password = "${v('password:32')}"
secret_key = "${v('base64:64')}"
api_hash = "${v('hash:32')}"
admin_user = "${v('username')}"
admin_email = "${v('email')}"
db_url = "postgres://app:${v('db_password')}@db:5432/app"

[[config.domains]]
serviceName = "web"
port = 3000
host = "${v('main_domain')}"

[config]
env = [
  "DB_PASSWORD=${v('db_password')}",
  "DATABASE_URL=${v('db_url')}",
  "SECRET_KEY=${v('secret_key')}",
  "API_HASH=${v('api_hash')}",
  "ADMIN=${v('admin_user')}",
  "ADMIN_EMAIL=${v('admin_email')}",
  "INLINE=${v('password')}",
  "B64=${v('base64')}",
]
`;
    const compose = `services:
  web:
    image: example/web:1
    environment:
      DB_PASSWORD: ${v('DB_PASSWORD')}
      DATABASE_URL: ${v('DATABASE_URL')}
      SECRET_KEY: ${v('SECRET_KEY')}
      API_HASH: ${v('API_HASH')}
      ADMIN: ${v('ADMIN')}
      ADMIN_EMAIL: ${v('ADMIN_EMAIL')}
      INLINE: ${v('INLINE')}
      B64: ${v('B64')}
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: ${v('DB_PASSWORD')}
`;
    const t = converted(bp({ toml, compose }));
    expect(envOf(t.composeContent!, 'web')).toEqual({
      DB_PASSWORD: v('SERVICE_PASSWORD_32_DB_PASSWORD'),
      DATABASE_URL: `postgres://app:${v('SERVICE_PASSWORD_32_DB_PASSWORD')}@db:5432/app`,
      SECRET_KEY: v('SERVICE_REALBASE64_64_SECRET_KEY'),
      API_HASH: v('SERVICE_HEX_32_API_HASH'),
      ADMIN: v('SERVICE_LOWERCASEUSER_ADMIN_USER'),
      ADMIN_EMAIL: `${v('SERVICE_LOWERCASEUSER_ADMIN_EMAIL')}@example.com`,
      INLINE: v('SERVICE_PASSWORD_16_INLINE'),
      B64: v('SERVICE_REALBASE64_32_B64'),
    });
    // The same variable is the same token everywhere: the db gets the app's password.
    expect(envOf(t.composeContent!, 'db')).toEqual({ POSTGRES_PASSWORD: v('SERVICE_PASSWORD_32_DB_PASSWORD') });
    // Every token is one the deploy-time resolver generates, with the right size.
    const kinds = Object.fromEntries(scanMagicTokens(t.composeContent!).map((tok) => [tok, parseMagicToken(tok)]));
    expect(kinds['SERVICE_PASSWORD_32_DB_PASSWORD']).toMatchObject({ kind: 'password', size: 32 });
    expect(kinds['SERVICE_REALBASE64_64_SECRET_KEY']).toMatchObject({ kind: 'realBase64', size: 64 });
    expect(kinds['SERVICE_HEX_32_API_HASH']).toMatchObject({ kind: 'hex', size: 32 });
    expect(kinds['SERVICE_PASSWORD_16_INLINE']).toMatchObject({ kind: 'password', size: 16 });
    expect(kinds['SERVICE_LOWERCASEUSER_ADMIN_USER']).toMatchObject({ kind: 'lowercaseUser' });
    expect(Object.values(kinds).every((k) => k !== null)).toBe(true);
  });

  it('interpolates like compose: inside parsed strings, with defaults, env-to-env and literal dollars', () => {
    const toml = `
[variables]
main_domain = "${v('domain')}"
username = "${v('username')}"

[[config.domains]]
serviceName = "app"
port = 80
host = "${v('main_domain')}"

[config.env]
TRICKY = "a: b # not a comment"
DOLLAR = "pa$word"
EMPTY = ""
USER = "${v('username')}"
DSN = "user=${v('USER')} host=db"
PUID = "${v('PUID:-1000')}"
`;
    const compose = `services:
  app:
    image: example/app:1
    environment:
      TRICKY: ${v('TRICKY')}
      DOLLAR: ${v('DOLLAR')}
      FALLBACK: ${v('EMPTY:-kept')}
      PLAIN_EMPTY: ${v('EMPTY-ignored')}
      DSN: ${v('DSN')}
      PUID: ${v('PUID')}
      UNKNOWN: ${v('NOT_IN_ENV:-x')}
      ESCAPED: $$HOME
`;
    const t = converted(bp({ toml, compose }));
    expect(envOf(t.composeContent!, 'app')).toEqual({
      TRICKY: 'a: b # not a comment',
      DOLLAR: 'pa$$word',
      FALLBACK: 'kept',
      PLAIN_EMPTY: '',
      // Dokploy checks generator names first: ${username} in an env value is a fresh user.
      DSN: `user=${v('SERVICE_LOWERCASEUSER_USER')} host=db`,
      PUID: '1000',
      UNKNOWN: v('NOT_IN_ENV:-x'),
      ESCAPED: '$$HOME',
    });
  });

  it('skips what it cannot convert faithfully, with the reason', () => {
    const domainToml = (extra: string, domains = `[[config.domains]]\nserviceName = "n8n"\nport = 5678\nhost = "${v('main_domain')}"`) =>
      `[variables]\nmain_domain = "${v('domain')}"\n${extra}\n\n${domains}\n`;
    expect(reason(bp({ toml: `${domainToml('')}\n[[config.mounts]]\nfilePath = "a.conf"\ncontent = "x"\n` }))).toBe('writes files into the stack (config.mounts)');
    expect(reason(bp({ toml: domainToml('', '') }))).toBe('no routed HTTP service (config.domains)');
    expect(
      reason(bp({ toml: domainToml('', `[[config.domains]]\nserviceName = "n8n"\nport = 5678\n\n[[config.domains]]\nserviceName = "api"\nport = 8080`) })),
    ).toBe('routes more than one service or port');
    expect(reason(bp({ toml: domainToml('', `[[config.domains]]\nserviceName = "n8n"\nport = 5678\npath = "/app"`) }))).toBe('routes a sub-path');
    expect(reason(bp({ toml: domainToml(`id = "${v('uuid')}"`) + `\n[config.env]\nX = "${v('id')}"` }))).toBe('uses ${uuid}, which has no equivalent here');
    expect(reason(bp({ toml: domainToml(`k = "${v('base64:48')}"`) + `\n[config.env]\nX = "${v('k')}"` }))).toBe(
      'uses ${base64:48} (only 32, 64 or 128 bytes have an equivalent)',
    );
    expect(reason(bp({ toml: domainToml(`other = "${v('domain')}"`) + `\n[config.env]\nX = "${v('other')}"` }))).toBe('has a second public hostname (other)');
    expect(reason(bp({ toml: domainToml('') + `\n[config.env]\nX = "${v('missing')}"` }))).toBe('references ${missing}, which the blueprint does not define');
    expect(reason(bp({ compose: `services:\n  n8n:\n    image: x\n    ports:\n      - "8080:80"\n` }))).toBe("service 'n8n' publishes host ports");
    expect(reason(bp({ compose: `services:\n  n8n:\n    image: x\n    environment:\n      - U=${v('DOKPLOY_URL')}\n` }))).toBe(
      'uses DOKPLOY_URL, a variable only Dokploy provides',
    );
    expect(reason(bp({ compose: `services:\n  web:\n    image: x\n` }))).toBe("routed service 'n8n' is not in the compose file");
    expect(reason(bp({ compose: `services:\n  n8n:\n    image: x\n    env_file: .env\n` }))).toMatch(/^env_file is not supported/);
  });

  it('refuses a bind mount of the host or outside the stack (security review)', () => {
    const withVolume = (v: string) => reason(bp({ compose: `services:\n  n8n:\n    image: x\n    volumes:\n      - ${v}\n` }));
    expect(withVolume('/root:/home/node/data')).toBe("service 'n8n' mounts the host path /root");
    expect(withVolume('/etc/timezone:/etc/timezone')).toBe("service 'n8n' mounts the host path /etc/timezone");
    expect(withVolume('../files/db:/database')).toBe("service 'n8n' mounts a path outside the stack (../files/db)");
    expect(withVolume('~/x:/x')).toBe("service 'n8n' mounts a path outside the stack (~/x)");
    expect(withVolume('"$${HOME}:/x"')).toBe("service 'n8n' interpolates a bind mount source");
    const long = reason(bp({ compose: `services:\n  n8n:\n    image: x\n    volumes:\n      - type: bind\n        source: /var/run/docker.sock\n        target: /s\n` }));
    expect(long).toBe("service 'n8n' mounts the host path /var/run/docker.sock");
    // Named volumes, paths inside the stack and the read-only clock files stay.
    for (const ok of ['data:/home/node/data', './config:/config', '/etc/localtime:/etc/localtime:ro']) expect(withVolume(ok) ?? '').not.toMatch(/mounts|interpolates/);
  });
});
