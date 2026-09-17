import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { template as templateSchema } from '@ninedeploy/schemas';
import bundledRegistry from '../../src/templates/registry.json' with { type: 'json' };
import { parseBundle } from '../../src/templates/registry.js';
import { scanRequiredPlaceholders } from '../../src/engine/magicVars.js';

describe('bundled Hub template contract', () => {
  const templates = parseBundle(bundledRegistry);

  it('has a versioned, unique, schema-valid curated catalog', () => {
    expect(bundledRegistry.version).toBeGreaterThanOrEqual(2);
    expect(templates.length).toBeGreaterThan(50);
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    for (const template of templates) expect(templateSchema.safeParse(template).success).toBe(true);
  });

  it('uses valid ports, image references, env names and persistent paths', () => {
    const image = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+(?::[A-Za-z0-9._-]+)?$/;
    const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const template of templates) {
      expect(template.port, template.id).toBeGreaterThanOrEqual(1);
      expect(template.port, template.id).toBeLessThanOrEqual(65535);
      expect(template.image, template.id).toMatch(image);
      if (template.volumeMount) expect(template.volumeMount, template.id).toMatch(/^\//);
      for (const entry of template.env ?? []) expect(entry.key, template.id).toMatch(envName);
      for (const key of Object.keys(template.databaseEnv ?? {})) expect(key, template.id).toMatch(envName);
    }
  });

  it('defines explicit application env mappings for every managed database template', () => {
    const databaseTemplates = templates.filter((template) => template.dbEngine);
    expect(databaseTemplates.map((template) => template.id).sort()).toEqual([
      'bookstack', 'directus', 'fider', 'ghost', 'hasura', 'matomo',
      'speedtest-tracker', 'umami', 'vikunja', 'wordpress', 'yourls',
    ]);
    for (const template of databaseTemplates) {
      expect(Object.keys(template.databaseEnv ?? {}).length, template.id).toBeGreaterThan(0);
    }

    expect(templates.find((template) => template.id === 'wordpress')?.databaseEnv).toEqual({
      // 'host' (internal bridge alias), NOT 'hostPort': WordPress writes
      // DB_HOST into wp-config.php INSIDE its persistent volume on first boot
      // and never rewrites it — the mapping must resolve to something that
      // stays valid across database container recreation.
      WORDPRESS_DB_HOST: 'host',
      WORDPRESS_DB_USER: 'username',
      WORDPRESS_DB_PASSWORD: 'password',
      WORDPRESS_DB_NAME: 'database',
    });
    expect(templates.find((template) => template.id === 'ghost')).toMatchObject({
      dbEngine: 'mysql',
      databaseEnv: {
        database__connection__host: 'host',
        database__connection__port: 'port',
        database__connection__user: 'username',
        database__connection__password: 'password',
        database__connection__database: 'database',
      },
    });
  });

  it('does not advertise known multi-container components as one-click services', () => {
    const ids = new Set(templates.map((template) => template.id));
    for (const unsupported of [
      'affine', 'appwrite', 'authentik', 'dify', 'discourse', 'immich',
      'langfuse', 'mastodon', 'plane', 'posthog', 'signoz', 'strapi', 'taiga', 'zulip',
    ]) expect(ids.has(unsupported), unsupported).toBe(false);
  });

  it('pins corrected upstream image names and runnable commands', () => {
    const byId = new Map(templates.map((template) => [template.id, template]));
    expect(byId.get('memos')?.image).toBe('neosmemo/memos:stable');
    expect(byId.get('forgejo')?.image).toBe('codeberg.org/forgejo/forgejo:16');
    expect(byId.get('kavita')?.image).toBe('jvmilazz0/kavita:latest');
    expect(byId.get('minio')?.cmd).toEqual(['server', '/data', '--console-address', ':9001']);
  });

  it('resolves in-file defaulted placeholders consistently across every compose stack', () => {
    for (const template of templates.filter((candidate) => candidate.composeContent)) {
      const content = template.composeContent!;
      const defaulted = new Set([...content.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-/g)].map((m) => m[1]!));
      // The resolver exports defaultless placeholders as '' — a stack that also
      // carries a ${NAME:-default} form of the SAME variable gets two different
      // values in one deploy: '' for the bare ref, the default for the other.
      // Deployment #91: umami-stack pointed DATABASE_URL at `$POSTGRES_DB`
      // (→ '') while postgres provisioned `umami`, so umami connected to a
      // nonexistent database and crash-looped against a healthy postgres.
      for (const name of scanRequiredPlaceholders(content)) {
        expect(defaulted.has(name), `${template.id} references $${name} both bare and as a defaulted \${${name}:-…}`).toBe(false);
      }
      if (template.id === 'umami-stack') {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolation is the literal under test
        expect(content).toContain('@postgresql:5432/${POSTGRES_DB:-umami}');
      }
    }
  });

  it('advertises only templates that passed an isolated runtime smoke test', () => {
    // The verified set is DERIVED from the committed smoke-run evidence, not
    // hand-pinned: the next `smoke-template-runtime` run refreshes the JSON
    // and this contract follows it automatically.
    const run = JSON.parse(
      readFileSync(new URL('../../../../runtime-verify-2026-09-16.json', import.meta.url), 'utf8'),
    ) as { results: Array<{ id: string; ok: boolean }> };
    const okIds = new Set(run.results.filter((r) => r.ok).map((r) => r.id));
    const verifiedIds = new Set(templates.filter((t) => t.runtimeVerified).map((t) => t.id));
    // Every smoke-verified template is advertised…
    for (const id of okIds) expect(verifiedIds.has(id), id).toBe(true);
    // …and nothing else claims verification (no exceptions — a compose-only
    // template passing an interpolation test is still not runtime-verified).
    const unexpected = [...verifiedIds].filter((id) => !okIds.has(id));
    expect(unexpected).toEqual([]);
    for (const template of templates.filter((candidate) => candidate.runtimeVerified)) {
      expect(template.verifiedAt, template.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
