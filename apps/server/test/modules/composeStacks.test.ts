import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareComposeStack } from '../../src/modules/composeStacks.js';
import type { Template } from '../../src/templates/registry.js';

/**
 * `prepareComposeStack` is the one-click compose-stack installer
 * called from the templates flow. The exported
 * `composeStacks.ts` module owns:
 *
 *   - the workspace-path derivation (`stackWorkspace`)
 *   - the slug-collision retry loop (up to 5 attempts)
 *   - the same-stack reuse shortcut
 *   - the env merge (template.env + resolved magic tokens)
 *   - the materialisation of `docker-compose.yml` into the
 *     per-service workspace
 *
 * All side effects (DB queries, magic-var resolution, ACME
 * lookup, file writes) are mocked here so the test exercises
 * the orchestration only.
 */

// ── engine/magicVars mocks ─────────────────────────────────────────
const magicVarsMock = vi.hoisted(() => ({
  preflightCompose: vi.fn(() => ({ ok: true, reasons: [] as string[], warnings: [] as string[] })),
  // `parsed` classifies each resolved key: SERVICE_USER_POSTGRES is a
  // generated magic token, PUBLIC_URL is a bare `${PUBLIC_URL}` placeholder
  // the file left open (no entry). The seed builder reads this to decide
  // which values are secrets.
  resolveStackEnvironment: vi.fn((_content: string, opts: { publicUrl: string }) => ({
    values: { PUBLIC_URL: opts.publicUrl, SERVICE_USER_POSTGRES: 'pg-user' },
    parsed: { SERVICE_USER_POSTGRES: { raw: 'SERVICE_USER_POSTGRES', kind: 'user' } },
    openPlaceholders: ['PUBLIC_URL'],
  })),
}));
vi.mock('../../src/engine/magicVars.js', () => magicVarsMock);

// ── engine/proxy mocks (only getAcmeEmail is imported) ─────────────
const proxyMock = vi.hoisted(() => ({
  getAcmeEmail: vi.fn(async () => 'acme@example.com'),
}));
vi.mock('../../src/engine/proxy.js', () => proxyMock);

// r351: the retained-volume probe asks Docker; stubbed here, asserted as wired below.
const retainedMocks = vi.hoisted(() => ({ assertSlugVolumeNotRetained: vi.fn(async (_slug: string, _type: string) => undefined) }));
vi.mock('../../src/lib/retainedSlugVolume.js', () => retainedMocks);

// ── config mocks (the route reads `config.wildcardDomain` to
//     compute the publicUrl; without a wildcard the route
//     hard-codes `http://localhost` regardless of the ACME
//     scheme, so the https-vs-http branch needs a wildcard
//     in scope to be observable) ─────────────────────────────────────
const configMock = vi.hoisted(() => ({
  config: { paths: { reposDir: '/tmp/ninedeploy-test' }, wildcardDomain: 'panel.dev' },
}));
vi.mock('../../src/config.js', () => configMock);

// ── fs mocks: workspace materialisation is asserted via spies ────
const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn((_p: string, _opts?: unknown) => undefined),
  writeFileSync: vi.fn((_p: string, _data: string | Uint8Array, _opts?: unknown) => undefined),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, mkdirSync: fsMock.mkdirSync, writeFileSync: fsMock.writeFileSync };
});

// ── template fixture (composeContent is the only field used here) ─
const COMPOSE_CONTENT = 'services:\n  postgresql:\n    image: postgres:16\n';
const TEMPLATE: Pick<Template, 'id' | 'name' | 'image' | 'port' | 'composeContent' | 'composeService'> & {
  env?: Array<{ key: string; value: string; secret?: boolean }>;
} = {
  id: 'pg-stack',
  name: 'Postgres Stack',
  image: 'postgres:16',
  port: 5432,
  composeContent: COMPOSE_CONTENT,
  composeService: 'postgresql',
};

// ── minimal fake app shape that `prepareComposeStack` reaches into ─
interface FakeApp {
  db: {
    query: {
      services: { findFirst: (args?: unknown) => Promise<unknown> };
    };
    insert: (table: unknown) => {
      values: (v: unknown) => {
        returning: () => Promise<Array<{ id: number; slug: string; name: string; type: string }>>;
      };
    };
    update: (table: unknown) => {
      set: (s: unknown) => {
        where: () => Promise<unknown>;
      };
    };
  };
}

function makeFakeApp(opts: {
  existingService?: { id: number; slug: string; name: string; type: 'compose' | 'docker'; ownerUserId: number; status: string; templateId: string } | null;
  createdService?: { id: number; slug: string; name: string; type: 'compose' | 'docker' };
} = {}): FakeApp {
  const created = opts.createdService ?? { id: 99, slug: 'pg-stack', name: 'Postgres Stack', type: 'compose' as const };
  let findFirstCallCount = 0;
  return {
    db: {
      query: {
        services: {
          // First call: pre-check for an existing service with the
          // candidate slug. Returns `existingService` on call 1,
          // null on subsequent calls (after we resolve the slug).
          findFirst: vi.fn(async (_args?: unknown) => {
            findFirstCallCount += 1;
            if (findFirstCallCount === 1) return opts.existingService ?? null;
            return null;
          }) as unknown as FakeApp['db']['query']['services']['findFirst'],
        },
      },
      insert: () => ({
        values: () => ({
          returning: async () => [created],
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  magicVarsMock.preflightCompose.mockReturnValue({ ok: true, reasons: [], warnings: [] });
  magicVarsMock.resolveStackEnvironment.mockImplementation((_c, opts) => ({
    values: { PUBLIC_URL: opts.publicUrl, SERVICE_USER_POSTGRES: 'pg-user' },
    parsed: { SERVICE_USER_POSTGRES: { raw: 'SERVICE_USER_POSTGRES', kind: 'user' } },
    openPlaceholders: ['PUBLIC_URL'],
  }));
  // getAcmeEmail's default impl is `async () => 'acme@example.com'`
  // (set in the hoisted factory) and `vi.clearAllMocks` does NOT
  // touch implementations — only call history. So this is the
  // test default; the "falls back to http" test overrides with
  // `mockResolvedValue(null)` and the next beforeEach restores
  // the default.
  proxyMock.getAcmeEmail.mockResolvedValue('acme@example.com');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('prepareComposeStack', () => {
  it('creates a new service row and materialises docker-compose.yml on first install', async () => {
    const app = makeFakeApp();
    const result = await prepareComposeStack(
      app as never,
      TEMPLATE as never,
      {},
      { id: 7, isOperator: true },
    );
    expect(result.service.id).toBe(99);
    expect(result.warnings).toEqual([]);
    // Resolved magic-var values + template env rows. The mock
    // resolves PUBLIC_URL and SERVICE_USER_POSTGRES; the
    // fixture has no `env` field, so the merge is just the
    // resolved values.
    const keys = result.stackEnv.map((e) => e.key).sort();
    expect(keys).toEqual(['PUBLIC_URL', 'SERVICE_USER_POSTGRES']);
    // Generated entropy is stored encrypted; a plain `${PUBLIC_URL}`
    // placeholder the user still has to fill in stays readable.
    const byKey = Object.fromEntries(result.stackEnv.map((e) => [e.key, e]));
    expect(byKey['SERVICE_USER_POSTGRES']?.secret).toBe(true);
    expect(byKey['PUBLIC_URL']?.secret).toBe(false);
    // Every resolved value is FINAL: reconcileEnvironment must store it as
    // given instead of minting a fresh random secret over the top.
    expect(result.stackEnv.every((e) => e.generate === false)).toBe(true);
    // File-system side effects: the workspace was created and
    // the compose file was written with the template content
    // and mode 0o600. We use `.calls.length` rather than
    // `toHaveBeenCalledTimes` so the assertion is local to
    // THIS test (the file-scoped fs mocks retain history across
    // tests in the same file).
    expect(fsMock.mkdirSync.mock.calls.length).toBe(1);
    expect(fsMock.writeFileSync.mock.calls.length).toBe(1);
    const writeArgs = fsMock.writeFileSync.mock.calls[0];
    expect(writeArgs?.[1]).toBe(COMPOSE_CONTENT);
    expect(writeArgs?.[2]).toEqual({ mode: 0o600 });
  });

  it('reuses an existing same-stack service instead of inserting a new row', async () => {
    const app = makeFakeApp({
      existingService: {
        id: 50,
        slug: 'pg-stack',
        name: 'Old Name',
        type: 'compose',
        ownerUserId: 7,
        status: 'running',
        templateId: 'pg-stack',
      },
    });
    const result = await prepareComposeStack(
      app as never,
      TEMPLATE as never,
      {},
      { id: 7, isOperator: false },
    );
    // The pre-existing row was returned (NOT a new insert), and
    // the result carries no new id — `result.service.id === 50`
    // not 99.
    expect(result.service.id).toBe(50);
    // File writes still happen — every (re)deploy refetches the
    // compose file from the template registry.
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('r351: gates a NEW stack row on a deleted service\'s retained volume (the reuse path is not gated)', async () => {
    const { HttpError } = await import('../../src/lib/errors.js');
    retainedMocks.assertSlugVolumeNotRetained.mockRejectedValueOnce(new HttpError(409, 'slug_volume_retained', 'retained'));
    const app = makeFakeApp();
    const insert = vi.spyOn(app.db, 'insert');
    await expect(
      prepareComposeStack(app as never, TEMPLATE as never, { name: 'Shop' }, { id: 7, isOperator: true }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'slug_volume_retained' });
    expect(retainedMocks.assertSlugVolumeNotRetained).toHaveBeenCalledWith('shop', 'compose');
    expect(insert).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects the install with 400 when preflightCompose flags the compose content', async () => {
    magicVarsMock.preflightCompose.mockReturnValue({
      ok: false,
      reasons: ['env_file is not allowed'],
      warnings: [],
    });
    const app = makeFakeApp();
    await expect(
      prepareComposeStack(app as never, TEMPLATE as never, {}, { id: 7, isOperator: true }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('env_file is not allowed'),
    });
    // No file-system side effects on a preflight failure.
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('uses http://localhost when no wildcard domain is configured', async () => {
    // When `config.wildcardDomain` is empty/falsy the route
    // hard-codes the publicUrl to `http://localhost` regardless
    // of the ACME scheme. (The branch is `? : 'http://localhost'`
    // — the fallback is http, not the scheme, so a missing
    // wildcard always lands on http. This is by design: a
    // tenant without a public wildcard has no public URL
    // candidate, so the panel's default URL is the localhost
    // placeholder it can later reconfigure.)
    configMock.config.wildcardDomain = '';
    const app = makeFakeApp();
    const result = await prepareComposeStack(
      app as never,
      TEMPLATE as never,
      {},
      { id: 7, isOperator: true },
    );
    const publicUrl = result.stackEnv.find((e) => e.key === 'PUBLIC_URL')?.value;
    expect(publicUrl).toBe('http://localhost');
    // Restore for subsequent tests.
    configMock.config.wildcardDomain = 'panel.dev';
  });

  it('falls back to http (not https) when no ACME email is configured', async () => {
    // The publicUrl scheme is derived from whether getAcmeEmail
    // returns a string. No email → http, email → https. The
    // mocked config sets `wildcardDomain = 'panel.dev'` so the
    // URL is `http(s)://<slug>.panel.dev`; the absence of an
    // ACME email is what makes the scheme `http`.
    proxyMock.getAcmeEmail.mockResolvedValue(null);
    const app = makeFakeApp();
    const result = await prepareComposeStack(
      app as never,
      TEMPLATE as never,
      {},
      { id: 7, isOperator: true },
    );
    const publicUrl = result.stackEnv.find((e) => e.key === 'PUBLIC_URL')?.value;
    expect(publicUrl).toBe('http://pg-stack.panel.dev');
  });

  it('uses https:// when an ACME email is configured', async () => {
    // With `wildcardDomain = 'panel.dev'` and `getAcmeEmail`
    // returning a truthy string, the publicUrl must be
    // `https://<slug>.panel.dev`. The "falls back to http"
    // test is the inverse half of this branch.
    const app = makeFakeApp();
    const result = await prepareComposeStack(
      app as never,
      TEMPLATE as never,
      {},
      { id: 7, isOperator: true },
    );
    const publicUrl = result.stackEnv.find((e) => e.key === 'PUBLIC_URL')?.value;
    expect(publicUrl).toBe('https://pg-stack.panel.dev');
  });

  it('rethrows the sameStack rejection when a colliding slug belongs to a different user', async () => {
    // If a slug match is found AND the owner is NOT the caller
    // AND the caller is not an operator, the route must surface
    // a 400 rather than silently overwriting or allocating
    // silently. The slug-collision loop is an attempt at a fresh
    // allocation, but if it can't find a free slot (5 attempts)
    // it bails with a 400.
    // First findFirst (for the original slug) returns a row
    // owned by a different user; every retry (calls 2-6) ALSO
    // returns a row so the allocation gives up.
    const foreign = {
      id: 50,
      slug: 'pg-stack',
      name: 'Other User Stack',
      type: 'compose' as const,
      ownerUserId: 999,
      status: 'running',
      templateId: 'pg-stack',
    };
    const app = {
      ...makeFakeApp(),
      db: {
        ...makeFakeApp().db,
        query: {
          services: {
            findFirst: vi.fn(async () => foreign) as never,
          },
        },
      },
    };
    await expect(
      prepareComposeStack(app as never, TEMPLATE as never, {}, { id: 7, isOperator: false }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('free service slug'),
    });
  });

  it('throws 400 when the sameStack reuse check sees an unsupported service type (not compose)', async () => {
    // The sameStack shortcut requires the existing row to be
    // `type: 'compose'` AND match the template id. A foreign
    // slug that happens to collide but is a single-container
    // service must NOT be reused — the install must 400 with
    // `slug_taken`.
    const app = makeFakeApp({
      existingService: {
        id: 50,
        slug: 'pg-stack',
        name: 'Pre-existing docker service',
        type: 'docker', // wrong type
        ownerUserId: 7,
        status: 'running',
        templateId: 'some-docker-template',
      },
    });
    await expect(
      prepareComposeStack(app as never, TEMPLATE as never, {}, { id: 7, isOperator: false }),
    ).rejects.toMatchObject({
      statusCode: 400,
      // The HttpError carries a code field; assert it separately
      // because the zod-passthrough HttpError shape is `{ code, message }`.
    });
  });

  it('derives the slug from the template name + timestamp when input.name is omitted', async () => {
    // The slug recipe is `input.name ? slugify(name) :
    // ${slugify(template.name)}-${ts36}`. Omitting `input.name`
    // is the install path that auto-derives a fresh slug every
    // time (used by the templates one-click install). The slug
    // is composed with the last 4 chars of `Date.now().toString(36)`,
    // which is non-deterministic — we assert the regex shape
    // on the inserted slug via the result row (the fake app
    // echoes the input slug back on insert).
    const tpl = { ...TEMPLATE, name: 'Wordpress Stack' };
    const app = makeFakeApp({
      createdService: { id: 99, slug: '__placeholder__', name: 'Wordpress Stack', type: 'compose' },
    });
    // Replace the insert mock so it captures and echoes the
    // actual slug the route computed.
    (app.db as { insert: unknown }).insert = () => ({
      values: (v: { slug: string }) => ({
        returning: async () => [{ id: 99, slug: v.slug, name: 'Wordpress Stack', type: 'compose' as const }],
      }),
    });
    const result = await prepareComposeStack(
      app as never,
      tpl as never,
      {},
      { id: 7, isOperator: true },
    );
    expect(result.service.slug).toMatch(/^wordpress-stack-[a-z0-9]{1,4}$/);
  });

  it('merges template env rows into the stackEnv with secret defaults to false', async () => {
    const tplWithEnv = {
      ...TEMPLATE,
      env: [
        { key: 'LOG_LEVEL', value: 'info' }, // no `secret` flag
        { key: 'API_TOKEN', value: 'opaque', secret: true },
      ],
    };
    const app = makeFakeApp();
    const result = await prepareComposeStack(
      app as never,
      tplWithEnv as never,
      {},
      { id: 7, isOperator: true },
    );
    const logLevel = result.stackEnv.find((e) => e.key === 'LOG_LEVEL');
    const apiToken = result.stackEnv.find((e) => e.key === 'API_TOKEN');
    expect(logLevel?.secret).toBe(false);
    expect(apiToken?.secret).toBe(true);
  });
});
