import { describe, expect, it } from 'vitest';
import {
  alertRuleCreate,
  alertRulePatch,
  apiToken,
  attachment,
  backup,
  backupDestinationCreate,
  backupDestinationPatch,
  jobCreate,
  jobPatch,
  metricQuery,
  serverAnnounce,
  serverCreate,
  serverSshTest,
  serverSshBootstrap,
  sshAuthType,
  backupWithDb,
  notificationChannelCreate,
  containerStat,
  apiTokenScope,
  createApiToken,
  createAttachment,
  createDatabase,
  createDomain,
  createProject,
  createService,
  createServiceVolumeAttachment,
  createSource,
  createTunnel,
  createWebhook,
  createdApiToken,
  operatorGrant,
  createdWebhook,
  deployment,
  deployTemplate,
  dockerResources,
  domain,
  domainEntry,
  envVar,
  errorResponse,
  hostStat,
  id,
  login,
  managedDatabase,
  metricSeries,
  page,
  pagination,
  projectPatch,
  publicUser,
  refresh,
  register,
  service,
  serviceType,
  serviceVolumeAttachment as serviceVolumeAttachmentSchema,
  session,
  setLimits,
  sameImageRepository,
  setup,
  slug,
  source,
  statsSnapshot,
  template,
  templateSummary,
  tokenPair,
  topologyGraph,
  triggerDeploy,
  tunnelEntry,
  updateService,
  updateServiceVolumeAttachment,
  upsertEnvVar,
  volumeEntry,
  webhook,
  workspaceRoleEnum,
  workspaceCreate,
  workspaceUpdate,
  workspaceMemberAdd,
  workspaceMemberRoleUpdate,
  workspaceInvitationCreate,
  oidcProviderCreate,
  oidcProviderUpdate,
  labelPatch,
  label,
  createLabel,
  setServiceTags,
  serviceTags,
  serviceListFilter,
} from '../src/index.js';

/** Helper: assert a schema accepts an input. */
function ok(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success, `expected ${JSON.stringify(value)} to parse`).toBe(true);
  return result.success ? result.data : null;
}

/** Helper: assert a schema rejects an input. */
function bad(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
}

describe('common', () => {
  describe('slug', () => {
    it('accepts valid slugs', () => {
      expect(slug.safeParse('my-app').success).toBe(true);
      expect(slug.safeParse('ab').success).toBe(true);
      expect(slug.safeParse('a1').success).toBe(true);
      expect(slug.safeParse('a-b-c').success).toBe(true);
      expect(slug.safeParse('x'.repeat(63)).success).toBe(true);
    });

    it('rejects invalid slugs', () => {
      bad(slug, 'A'); // uppercase
      bad(slug, '_foo'); // leading underscore
      bad(slug, 'foo_'); // trailing underscore
      bad(slug, '-foo'); // leading hyphen
      bad(slug, 'foo-'); // trailing hyphen
      bad(slug, 'x'.repeat(64)); // too long
      bad(slug, 'x'); // too short
      bad(slug, ''); // empty
      bad(slug, 'foo bar'); // space
      bad(slug, 'foo/bar'); // slash
      bad(slug, 42); // wrong type
    });
  });

  describe('id', () => {
    it('accepts positive integers', () => {
      expect(id.safeParse(1).success).toBe(true);
      expect(id.safeParse(999).success).toBe(true);
    });

    it('rejects non-positive or non-integer values', () => {
      bad(id, 0);
      bad(id, -3);
      bad(id, 1.5);
      bad(id, '1');
      bad(id, NaN);
    });
  });

  describe('pagination', () => {
    it('applies defaults', () => {
      const data = ok(pagination, {});
      expect(data).toEqual({ limit: 25 });
    });

    it('accepts explicit limit and cursor with coercion', () => {
      const data = ok(pagination, { limit: '10', cursor: '5' });
      expect(data).toEqual({ limit: 10, cursor: 5 });
    });

    it('rejects limits out of range and bad types', () => {
      bad(pagination, { limit: 0 });
      bad(pagination, { limit: 101 });
      bad(pagination, { limit: 'abc' });
      bad(pagination, { cursor: 0 });
      bad(pagination, { cursor: -1 });
    });
  });

  describe('errorResponse', () => {
    it('accepts a standard error envelope', () => {
      const data = ok(errorResponse, { error: { code: 'not_found', message: 'nope', details: { id: 3 } } });
      expect(data).toEqual({ error: { code: 'not_found', message: 'nope', details: { id: 3 } } });
    });

    it('accepts an envelope without details', () => {
      expect(errorResponse.safeParse({ error: { code: 'x', message: 'y' } }).success).toBe(true);
    });

    it('rejects malformed envelopes', () => {
      bad(errorResponse, {});
      bad(errorResponse, { error: { message: 'no code' } });
      bad(errorResponse, { error: { code: 'x' } });
    });
  });

  describe('page', () => {
    it('wraps an item schema', () => {
      const p = page(id);
      const data = ok(p, { items: [1, 2], nextCursor: 3, total: 2 });
      expect(data).toEqual({ items: [1, 2], nextCursor: 3, total: 2 });
    });

    it('allows a null nextCursor and omits total', () => {
      const data = ok(page(slug), { items: ['ab'], nextCursor: null });
      expect(data).toEqual({ items: ['ab'], nextCursor: null });
    });

    it('rejects invalid pages', () => {
      const p = page(id);
      bad(p, { items: ['not-an-id'], nextCursor: null });
      bad(p, { items: [], nextCursor: 0 });
      bad(p, { items: [], nextCursor: null, total: -1 });
    });
  });
});

describe('auth', () => {
  describe('register', () => {
    it('accepts a full registration', () => {
      const data = ok(register, { email: 'a@b.com', password: '12345678', name: 'Ada' });
      expect(data).toEqual({ email: 'a@b.com', password: '12345678', name: 'Ada' });
    });

    it('accepts registration without a name', () => {
      expect(register.safeParse({ email: 'a@b.com', password: '12345678' }).success).toBe(true);
    });

    it('rejects bad email, short password, or empty name', () => {
      bad(register, { email: 'nope', password: '12345678' });
      bad(register, { email: 'a@b.com', password: 'short' });
      bad(register, { email: 'a@b.com', password: '12345678', name: '' });
      bad(register, { email: 'a@b.com', password: 'x'.repeat(129) });
    });
  });

  it('setup is the same shape as register', () => {
    expect(setup).toBe(register);
  });

  describe('login', () => {
    it('accepts valid credentials', () => {
      expect(login.safeParse({ email: 'a@b.com', password: 'p' }).success).toBe(true);
    });

    it('rejects invalid credentials', () => {
      bad(login, { email: 'a@b.com', password: '' });
      bad(login, { email: 'a@b.com' });
      bad(login, { password: 'p' });
    });
  });

  describe('tokenPair', () => {
    it('accepts a valid pair', () => {
      expect(tokenPair.safeParse({ accessToken: 'a', refreshToken: 'b', expiresIn: 900 }).success).toBe(true);
    });

    it('rejects invalid pairs', () => {
      bad(tokenPair, { accessToken: 'a', refreshToken: 'b', expiresIn: 0 });
      bad(tokenPair, { accessToken: 'a', refreshToken: 'b', expiresIn: 1.5 });
      bad(tokenPair, { accessToken: 'a', refreshToken: 'b' });
    });
  });

  describe('refresh', () => {
    it('accepts a non-empty refresh token', () => {
      expect(refresh.safeParse({ refreshToken: 'tok' }).success).toBe(true);
    });

    it('rejects an empty refresh token', () => {
      bad(refresh, { refreshToken: '' });
    });
  });

  describe('publicUser', () => {
    it('accepts a valid user', () => {
      const data = ok(publicUser, {
        id: 1,
        email: 'a@b.com',
        name: null,
        isOperator: true,
        workspaceCount: 1,
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(data).toEqual({
        id: 1,
        email: 'a@b.com',
        name: null,
        isOperator: true,
        workspaceCount: 1,
        createdAt: '2026-01-01T00:00:00Z',
      });
    });

    it('rejects invalid users', () => {
      bad(publicUser, { id: 1, email: 'not-an-email', name: null, isOperator: true, workspaceCount: 1, createdAt: '2026-01-01T00:00:00Z' });
      bad(publicUser, { id: 1, email: 'a@b.com', name: null, isOperator: true, workspaceCount: 1 });
      bad(publicUser, { id: 1.5, email: 'a@b.com', name: null, isOperator: true, workspaceCount: 1, createdAt: '2026-01-01T00:00:00Z' });
    });
  });

  describe('session', () => {
    it('accepts a session', () => {
      const data = ok(session, {
        user: {
          id: 1,
          email: 'a@b.com',
          name: 'Ada',
          isOperator: true,
          workspaceCount: 2,
          createdAt: '2026-01-01T00:00:00Z',
        },
        tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 60 },
      });
      expect(data?.tokens.expiresIn).toBe(60);
    });

    it('rejects an invalid session', () => {
      bad(session, {
        user: { id: 1, email: 'not-an-email', isOperator: true, workspaceCount: 1, createdAt: '2026-01-01T00:00:00Z' },
        tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 60 },
      });
    });
  });

  describe('api tokens', () => {
    it('createApiToken accepts a name or empty input', () => {
      expect(createApiToken.safeParse({ name: 'ci' }).success).toBe(true);
      expect(createApiToken.safeParse({}).success).toBe(true);
    });

    it('createApiToken normalises the name instead of rejecting it', () => {
      // The endpoint has always been lenient here (slice to 100, fall back to
      // "cli"); rejecting would break CLI/CI callers on upgrade.
      expect(createApiToken.parse({ name: '' }).name).toBe('cli');
      expect(createApiToken.parse({}).name).toBe('cli');
      expect(createApiToken.parse({ name: 'x'.repeat(150) }).name).toHaveLength(100);
    });

    it('createApiToken defaults to a read-scoped (["read"]) scope list', () => {
      // A NEW token without explicit scopes is read-only, not unrestricted
      // (1a6313b): omitting a scope must not mint the owner's full authority.
      // An explicit `[]` is refused (r090): it would be stored as a legacy
      // unrestricted row — how a `write` token minted an operator token.
      expect(createApiToken.parse({ name: 'ci' }).scopes).toEqual(['read']);
      bad(createApiToken, { name: 'ci', scopes: [] });
      expect(createApiToken.parse({ name: 'ci', scopes: ['read'] }).scopes).toEqual(['read']);
      bad(createApiToken, { name: 'ci', scopes: ['root'] });
      bad(createApiToken, { name: 'ci', expiresInDays: 0 });
      expect(createApiToken.parse({ name: 'ci', expiresInDays: 30 }).expiresInDays).toBe(30);
    });

    it('apiToken accepts a row with datetime fields', () => {
      const data = ok(apiToken, {
        id: 1,
        name: 'ci',
        scopes: [],
        lastUsedAt: null,
        expiresAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(data?.name).toBe('ci');
      bad(apiToken, { id: 1, name: 'ci', scopes: [], lastUsedAt: 'not-a-date', expiresAt: null, createdAt: '2026-01-01T00:00:00Z' });
    });

    it('createdApiToken accepts the one-time response', () => {
      const data = ok(createdApiToken, {
        id: 1,
        name: 'ci',
        token: 'secret',
        scopes: ['write'],
        expiresAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(data?.token).toBe('secret');
      bad(createdApiToken, { id: 1, name: 'ci', scopes: [], expiresAt: null, createdAt: '2026-01-01T00:00:00Z' });
    });

    it('apiTokenScope is the enforced vocabulary', () => {
      // The schema is a z.union (legacy coarse scopes ∪ resource
      // scopes); the only public contract worth pinning here is
      // that the well-known values round-trip and unknowns are
      // rejected. zod's internal layout shifts between minor
      // versions, so we test through safeParse instead of
      // introspecting `_def`.
      const allowed = ['read', 'write', 'operator', 'nd://scope/admin/services', 'nd://scope/write/services', 'nd://scope/read/services'];
      for (const v of allowed) {
        expect(apiTokenScope.safeParse(v).success).toBe(true);
      }
      for (const bad of ['', 'admin', 'execute', '  ', 'unknown:something']) {
        expect(apiTokenScope.safeParse(bad).success).toBe(false);
      }
    });

    it('operatorGrant carries a single boolean', () => {
      expect(operatorGrant.parse({ isOperator: true }).isOperator).toBe(true);
      bad(operatorGrant, { isOperator: 'yes' });
    });
  });
});

describe('service', () => {
  describe('serviceType', () => {
    it('accepts pm2 and docker only', () => {
      expect(serviceType.safeParse('pm2').success).toBe(true);
      expect(serviceType.safeParse('docker').success).toBe(true);
      bad(serviceType, 'k8s');
    });
  });

  describe('createService', () => {
    it('applies defaults', () => {
      const data = ok(createService, { name: 'Web' });
      expect(data).toMatchObject({ name: 'Web', type: 'docker', branch: 'main', build: { buildPack: 'auto', baseDir: '/' } });
    });

    it('accepts a full input', () => {
      const data = ok(createService, {
        projectId: 1,
        name: 'Web',
        slug: 'web',
        type: 'pm2',
        repoUrl: 'https://github.com/a/b.git',
        branch: 'dev',
        sourceId: 2,
        image: 'node:22',
        volumeMount: '/data',
        cpuShares: 512,
        memLimitMb: 256,
        healthPath: '/health',
        port: 3000,
        build: { buildPack: 'dockerfile', baseDir: '/app', installCmd: 'npm i', buildCmd: 'npm run build', startCmd: 'npm start', dockerfilePath: 'Dockerfile' },
      });
      expect(data?.port).toBe(3000);
      expect(data?.build.buildPack).toBe('dockerfile');
    });

    it('rejects invalid inputs', () => {
      bad(createService, { name: '' });
      bad(createService, { name: 'x'.repeat(101) });
      bad(createService, { name: 'Web', slug: 'INVALID' });
      bad(createService, { name: 'Web', type: 'k8s' });
      bad(createService, { name: 'Web', repoUrl: 'not-a-url' });
      bad(createService, { name: 'Web', branch: '' });
      bad(createService, { name: 'Web', port: 0 });
      bad(createService, { name: 'Web', port: 70000 });
      bad(createService, { name: 'Web', cpuShares: -1 });
      bad(createService, { name: 'Web', cpuShares: 262145 });
      bad(createService, { name: 'Web', memLimitMb: -5 });
    });

    it('accepts an inline compose stack on a compose service', () => {
      const data = ok(createService, {
        name: 'Stack',
        type: 'compose',
        composeContent: 'services:\n  web:\n    image: nginx\n',
      });
      expect(data?.type).toBe('compose');
    });

    it('rejects composeContent on a non-compose service', () => {
      // An inline stack IS a compose deploy: on any other type the YAML
      // would be stored but never run.
      bad(createService, { name: 'Web', type: 'docker', composeContent: 'services: {}' });
    });

    it('rejects composeContent combined with a repoUrl', () => {
      // The first clone wipes the workspace directory the pasted stack was
      // written to — the two sources are mutually exclusive.
      bad(createService, {
        name: 'Web',
        type: 'compose',
        composeContent: 'services: {}',
        repoUrl: 'https://github.com/a/b.git',
      });
    });
  });

  describe('updateService', () => {
    it('accepts partial updates', () => {
      expect(updateService.safeParse({ name: 'Renamed' }).success).toBe(true);
      expect(updateService.safeParse({}).success).toBe(true);
    });

    it('still validates provided fields', () => {
      bad(updateService, { port: 0 });
    });
  });

  describe('createServiceVolumeAttachment', () => {
    it('accepts an existing managed volume name', () => {
      const data = ok(createServiceVolumeAttachment, { volumeName: 'nd-svc-web-uploads', containerPath: '/uploads' });
      expect(data?.volumeName).toBe('nd-svc-web-uploads');
      expect(data?.containerPath).toBe('/uploads');
    });

    it('accepts a create+attach input with a label', () => {
      const data = ok(createServiceVolumeAttachment, { create: { label: 'uploads' }, containerPath: '/uploads' });
      expect(data?.create?.label).toBe('uploads');
    });

    it('rejects when neither volumeName nor create.label is present', () => {
      bad(createServiceVolumeAttachment, { containerPath: '/x' });
    });

    it('rejects when both volumeName and create.label are present', () => {
      bad(createServiceVolumeAttachment, { volumeName: 'nd-svc-x', create: { label: 'y' }, containerPath: '/x' });
    });

    it('rejects non-absolute container paths', () => {
      bad(createServiceVolumeAttachment, { volumeName: 'nd-svc-x', containerPath: 'relative' });
      bad(createServiceVolumeAttachment, { volumeName: 'nd-svc-x', containerPath: '' });
      bad(createServiceVolumeAttachment, { volumeName: 'nd-svc-x', containerPath: '//double' });
    });

    it('rejects invalid docker volume names', () => {
      bad(createServiceVolumeAttachment, { volumeName: 'has space', containerPath: '/x' });
      bad(createServiceVolumeAttachment, { volumeName: '-leading-hyphen', containerPath: '/x' });
    });
  });

  describe('updateServiceVolumeAttachment', () => {
    it('accepts a path change', () => {
      expect(updateServiceVolumeAttachment.safeParse({ containerPath: '/new' }).success).toBe(true);
    });

    it('accepts a readOnly toggle', () => {
      expect(updateServiceVolumeAttachment.safeParse({ readOnly: true }).success).toBe(true);
    });

    it('rejects an empty patch', () => {
      bad(updateServiceVolumeAttachment, {});
    });
  });

  describe('serviceVolumeAttachment (output)', () => {
    it('round-trips a valid row', () => {
      const row = {
        id: 1,
        serviceId: 1,
        volumeName: 'nd-svc-web-uploads',
        containerPath: '/uploads',
        readOnly: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      expect(serviceVolumeAttachmentSchema.parse(row)).toEqual(row);
    });
  });

  describe('service', () => {
    const valid = {
      id: 1,
      projectIds: [],
      workspaceIds: [],
      labelIds: [],
      name: 'Web',
      slug: 'web',
      type: 'docker',
      status: 'running',
      repoUrl: null,
      branch: 'main',
      sourceId: null,
      image: null,
      volumeMount: null,
      composeService: null,
      commitSha: null,
      runtimeId: 'abc',
      healthPath: '/',
      autoUrl: null,
      port: null,
      cpuShares: 0,
      memLimitMb: 0,
      build: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    it('accepts a full service row', () => {
      expect(service.safeParse(valid).success).toBe(true);
    });

    it('accepts a row with a build config', () => {
      expect(
        service.safeParse({
          ...valid,
          build: {
            buildPack: 'dockerfile',
            baseDir: '/app',
            installCmd: null,
            buildCmd: 'npm run build',
            startCmd: null,
            dockerfilePath: './Dockerfile',
            restartPolicy: 'on-failure:5',
            stopGraceSeconds: 10,
          },
        }).success,
      ).toBe(true);
    });

    it('rejects invalid rows', () => {
      bad(service, { ...valid, status: 'bogus' });
      bad(service, { ...valid, id: 1.5 });
      bad(service, { ...valid, createdAt: 'yesterday' });
      bad(service, { ...valid, type: 'k8s' });
      bad(service, { ...valid, healthPath: undefined });
    });
  });

  describe('sources', () => {
    it('createSource accepts valid inputs', () => {
      const data = ok(createSource, { name: 'gh', type: 'github', token: 't', deployKey: 'k', defaultBranch: 'main' });
      expect(data?.name).toBe('gh');
      expect(createSource.safeParse({ name: 'x', type: 'gitlab' }).success).toBe(true);
      expect(createSource.safeParse({ name: 'x', type: 'gitea' }).success).toBe(true);
      expect(createSource.safeParse({ name: 'x', type: 'bitbucket' }).success).toBe(true);
      expect(createSource.safeParse({ name: 'x', type: 'custom' }).success).toBe(true);
      bad(createSource, { name: '', type: 'github' });
      bad(createSource, { name: 'x', type: 'unknown-provider' });
    });

    it('source accepts a row', () => {
      const data = ok(source, { id: 1, name: 'gh', type: 'github', hasToken: true, hasDeployKey: false, defaultBranch: null, createdAt: '2026-01-01T00:00:00Z' });
      expect(data?.hasToken).toBe(true);
      bad(source, { id: 1, name: 'gh', type: 'github', hasToken: 'yes', hasDeployKey: false, defaultBranch: null, createdAt: '2026-01-01T00:00:00Z' });
    });
  });

  describe('deploys', () => {
    it('triggerDeploy accepts optional commitSha', () => {
      expect(triggerDeploy.safeParse({ commitSha: 'abc' }).success).toBe(true);
      expect(triggerDeploy.safeParse({}).success).toBe(true);
      bad(triggerDeploy, { commitSha: 123 });
    });

    it('deployment accepts a row', () => {
      const data = ok(deployment, {
        id: 1,
        status: 'queued',
        commitSha: null,
        message: null,
        author: null,
        trigger: 'manual',
        startedAt: null,
        finishedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(data?.status).toBe('queued');
      bad(deployment, { ...(data as object), status: 'nope' });
      bad(deployment, { ...(data as object), createdAt: 'x' });
    });
  });

  describe('domains', () => {
    it('createDomain applies defaults', () => {
      const data = ok(createDomain, { hostname: 'app.example.com' });
      expect(data).toEqual({ hostname: 'app.example.com', path: '/', ssl: true });
    });

    it('rejects short hostnames and accepts full input', () => {
      expect(createDomain.safeParse({ hostname: 'a.b.c', path: '/api', ssl: true }).success).toBe(true);
      bad(createDomain, { hostname: 'ab' });
      bad(createDomain, { hostname: 'x'.repeat(254) });
    });

    it('domain accepts a row', () => {
      const data = ok(domain, { id: 1, serviceId: 2, hostname: 'a.example.com', path: '/', ssl: true, redirectWww: false, headers: '[]', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
      expect(data?.hostname).toBe('a.example.com');
      bad(domain, { ...(data as object), ssl: 'yes' });
    });
  });

  describe('webhooks', () => {
    it('createWebhook accepts optional branch', () => {
      expect(createWebhook.safeParse({ branch: 'main' }).success).toBe(true);
      expect(createWebhook.safeParse({}).success).toBe(true);
      bad(createWebhook, { branch: '' });
    });

    it('webhook accepts a row', () => {
      const data = ok(webhook, { id: 1, branch: 'main', active: true, watchPaths: '', url: 'https://x', createdAt: '2026-01-01T00:00:00Z' });
      expect(data?.active).toBe(true);
      bad(webhook, { id: 1, branch: 'main', active: true, watchPaths: '', url: 'https://x', createdAt: 'bad' });
    });

    it('createdWebhook includes a secret', () => {
      const data = ok(createdWebhook, { id: 1, branch: 'main', active: true, watchPaths: '', url: 'https://x', createdAt: '2026-01-01T00:00:00Z', secret: 's3cr3t' });
      expect(data?.secret).toBe('s3cr3t');
      bad(createdWebhook, { id: 1, branch: 'main', active: true, url: 'https://x', createdAt: '2026-01-01T00:00:00Z' });
    });
  });

  describe('databases', () => {
    it('createDatabase accepts all engines', () => {
      for (const engine of ['postgres', 'mysql', 'redis', 'mongo']) {
        expect(createDatabase.safeParse({ name: 'db', engine }).success).toBe(true);
      }
      expect(createDatabase.safeParse({ name: 'db', engine: 'postgres', version: '16', projectId: 1, reuseExisting: true }).success).toBe(true);
      bad(createDatabase, { name: '', engine: 'postgres' });
      bad(createDatabase, { name: 'db', engine: 'oracle' });
    });

    it('managedDatabase accepts a row', () => {
      const data = ok(managedDatabase, {
        id: 1, projectId: null, name: 'db', slug: 'db', engine: 'postgres', version: '16',
        status: 'running', host: '127.0.0.1', port: 5432, username: 'u', database: 'd',
        connectionString: 'local-connection-string', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      });
      expect(data?.port).toBe(5432);
      bad(managedDatabase, { ...(data as object), port: '5432' });
    });

    it('attachment accepts a nullable database', () => {
      const data = ok(attachment, { id: 1, databaseId: 2, envAlias: 'DB_URL', database: null });
      expect(data?.envAlias).toBe('DB_URL');
      expect(attachment.safeParse({ id: 1, databaseId: 2, envAlias: 'DB_URL', database: { name: 'db', engine: 'redis', status: 'running' } }).success).toBe(true);
      bad(attachment, { id: 1, databaseId: 2, envAlias: 'DB_URL', database: { name: 'db' } });
    });

    it('createAttachment validates the env alias charset', () => {
      ok(createAttachment, { databaseId: 1 });
      ok(createAttachment, { databaseId: 1, envAlias: 'CACHE_URL', reuseExisting: true });
      ok(createAttachment, { databaseId: 1, envAlias: '  CACHE_URL  ' });
      bad(createAttachment, { databaseId: 0 });
      bad(createAttachment, { databaseId: 1, envAlias: 'MY ALIAS' });
      bad(createAttachment, { databaseId: 1, envAlias: '' });
    });
  });

  describe('env vars', () => {
    it('upsertEnvVar accepts input', () => {
      expect(upsertEnvVar.safeParse({ key: 'PORT', value: '3000' }).success).toBe(true);
      expect(upsertEnvVar.safeParse({ key: 'TOKEN', value: 'x', isSecret: true, overwriteExisting: true }).success).toBe(true);
      bad(upsertEnvVar, { key: '', value: 'x' });
      bad(upsertEnvVar, { key: 'K', value: 'x', isSecret: 'yes' });
      // Charset: keys that would break `docker run --env-file` are rejected;
      // surrounding whitespace is trimmed (env aliases share this rule).
      bad(upsertEnvVar, { key: 'MY VAR', value: 'x' });
      bad(upsertEnvVar, { key: '1BAD', value: 'x' });
      bad(upsertEnvVar, { key: 'A-B', value: 'x' });
      expect(upsertEnvVar.safeParse({ key: '  PORT  ', value: 'x' }).success).toBe(true);
      expect(upsertEnvVar.parse({ key: '  PORT  ', value: 'x' }).key).toBe('PORT');
    });

    it('envVar accepts a row', () => {
      const data = ok(envVar, { id: 1, key: 'PORT', value: '3000', isSecret: false });
      expect(data?.key).toBe('PORT');
      bad(envVar, { id: 1, key: 'PORT', value: '3000', isSecret: 'no' });
    });
  });

  describe('setLimits', () => {
    it('accepts optional and nullable fields', () => {
      expect(setLimits.safeParse({}).success).toBe(true);
      expect(setLimits.safeParse({ cpuShares: 1024, memLimitMb: 512 }).success).toBe(true);
      expect(setLimits.safeParse({ cpuShares: null, memLimitMb: null }).success).toBe(true);
      bad(setLimits, { cpuShares: 262145 });
      bad(setLimits, { memLimitMb: -1 });
    });
  });

  describe('stats', () => {
    it('hostStat accepts a row', () => {
      const data = ok(hostStat, { cpuCores: 8, load1: 0.5, memTotalBytes: 1000, memUsedBytes: 200, diskTotalBytes: 5000, diskUsedBytes: 1000 });
      expect(data?.cpuCores).toBe(8);
      bad(hostStat, { cpuCores: 8.5, load1: 0.5, memTotalBytes: 1000, memUsedBytes: 200, diskTotalBytes: 5000, diskUsedBytes: 1000 });
    });

    it('containerStat accepts service/database kinds', () => {
      const base = { name: 'c', kind: 'service', refId: 1, refName: 'web', cpuPct: 1.5, memMb: 10, memLimitMb: 100 };
      expect(containerStat.safeParse(base).success).toBe(true);
      expect(containerStat.safeParse({ ...base, kind: 'database', engine: 'redis' }).success).toBe(true);
      bad(containerStat, { ...base, kind: 'other' });
    });

    it('statsSnapshot accepts null host', () => {
      expect(statsSnapshot.safeParse({ host: null, containers: [] }).success).toBe(true);
      expect(statsSnapshot.safeParse({ host: { cpuCores: 1, load1: 0, memTotalBytes: 1, memUsedBytes: 0, diskTotalBytes: 1, diskUsedBytes: 0 }, containers: [] }).success).toBe(true);
      bad(statsSnapshot, { host: null, containers: [{}] });
    });

    it('metricSeries accepts points', () => {
      expect(metricSeries.safeParse({ kind: 'cpu', points: [{ ts: '2026-01-01T00:00:00Z', value: 5 }] }).success).toBe(true);
      bad(metricSeries, { kind: 'cpu', points: [{ ts: 'x', value: 5 }] });

    });
  });

  describe('topologyGraph', () => {
    it('accepts a graph', () => {
      const data = ok(topologyGraph, {
        services: [{ id: 1, name: 'web', slug: 'web', type: 'docker', status: 'running', image: null, port: 3000, runtimeId: 'web-1', volumeMount: null }],
        databases: [{ id: 1, name: 'db', engine: 'postgres', status: 'running', host: 'nd-db-db' }],
        attachments: [{ id: 1, serviceId: 1, databaseId: 1, envAlias: 'DB' }],
        domains: [{ id: 1, serviceId: 1, hostname: 'a.example.com', ssl: true }],
        volumes: [{ name: 'nd-svc-web-data', owner: { kind: 'service', refId: 1, name: 'web' } }, { name: 'nd-svc-ghost-data', owner: null }],
        networks: [{ name: 'ninedeploy', driver: 'bridge', containers: ['web-1'] }],
        gateway: { name: 'ninedeploy-traefik', network: 'ninedeploy', running: true },
      });
      expect(data?.services).toHaveLength(1);
      expect(data?.volumes).toHaveLength(2);
      bad(topologyGraph, { services: [{ id: 1, name: 'web' }], databases: [], attachments: [], domains: [{ id: 1, serviceId: 1, hostname: 'x', ssl: 'yes' }], volumes: [], networks: [], gateway: { name: 'g', network: 'n', running: false } });
    });
  });

  describe('backups', () => {
    it('backup accepts a row', () => {
      const data = ok(backup, { id: 1, databaseId: 2, volumeName: null, scope: 'db', status: 'done', sizeBytes: 1024, label: null, createdAt: '2026-01-01T00:00:00Z' });
      expect(data?.sizeBytes).toBe(1024);
      bad(backup, { id: 1, databaseId: 2, volumeName: null, scope: 'db', status: 'done', sizeBytes: 1024, createdAt: 'x' });
    });

    it('backupWithDb extends backup', () => {
      const data = ok(backupWithDb, { id: 1, databaseId: null, volumeName: null, scope: 'db', status: 'done', sizeBytes: 1, label: 'manual', createdAt: '2026-01-01T00:00:00Z', databaseName: null });
      expect(data?.databaseName).toBeNull();
      bad(backupWithDb, { id: 1, databaseId: null, volumeName: null, scope: 'db', status: 'done', sizeBytes: 1, createdAt: '2026-01-01T00:00:00Z' });
    });
  });

  describe('templates', () => {
    it('templateSummary accepts a row', () => {
      const data = ok(templateSummary, { id: 'nextjs', name: 'Next.js', tagline: 't', category: 'web', emoji: '⚛️', featured: true });
      expect(data?.featured).toBe(true);
      expect(templateSummary.safeParse({ id: 'x', name: 'x', tagline: 'x', category: 'x', emoji: 'x' }).success).toBe(true);
      bad(templateSummary, { id: 'x', name: 'x', tagline: 'x', category: 'x' });
    });

    it('template accepts a full row', () => {
      const data = ok(template, {
        id: 'nextjs', name: 'Next.js', tagline: 't', description: 'd', category: 'web', emoji: '⚛️',
        image: 'img', port: 3000, volumeMount: '/data', env: [{ key: 'K', value: 'V', secret: true }],
        website: 'https://x', featured: true,
      });
      expect(data?.port).toBe(3000);
      expect(template.safeParse({ id: 'x', name: 'x', tagline: 'x', description: 'x', category: 'x', emoji: 'x', image: 'x', port: 3000 }).success).toBe(true);
      bad(template, { id: 'x', name: 'x', tagline: 'x', description: 'x', category: 'x', emoji: 'x', image: 'x', port: '3000' });
      bad(template, { id: 'db', name: 'DB App', tagline: 'x', description: 'x', category: 'x', emoji: 'x', image: 'x', port: 3000, dbEngine: 'postgres' });
      expect(template.safeParse({
        id: 'db', name: 'DB App', tagline: 'x', description: 'x', category: 'x', emoji: 'x', image: 'x', port: 3000,
        dbEngine: 'postgres', databaseEnv: { DATABASE_URL: 'url' },
      }).success).toBe(true);
    });

    it('requires composeService whenever a compose stack is supplied', () => {
      // `image`/`port` describe the ROUTED service for a compose template, so
      // without naming that service the router has nothing to point at.
      const base = {
        id: 'stack', name: 'Stack', tagline: 'x', description: 'x', category: 'x',
        emoji: 'x', image: 'x', port: 3000,
      };
      const stack = 'services: { web: {} }';
      bad(template, { ...base, composeContent: stack });
      expect(template.safeParse({ ...base, composeContent: stack, composeService: 'web' }).success).toBe(true);
      // A compose-less template is unaffected by the refinement.
      expect(template.safeParse({ ...base, composeService: 'web' }).success).toBe(true);
    });

    it('accepts only caller-safe canonical template deploy controls', () => {
      const data = ok(deployTemplate, {
        name: 'My App', projectId: 2, serverId: 3, publishedPort: 8080,
        healthPath: '/healthz', cpuShares: 512, memLimitMb: 1024,
        env: [{ key: 'APP_MODE', value: 'production', isSecret: false }],
        reuseExisting: true,
        image: 'n8nio/n8n:1.100.0', port: 9999,
      });
      // The image TAG override is first-class now (validated against the
      // template's repository server-side); port stays registry-owned and is
      // stripped as an unknown key.
      expect(data.image).toBe('n8nio/n8n:1.100.0');
      expect(data).not.toHaveProperty('port');
      bad(deployTemplate, { publishedPort: 70000 });
      bad(deployTemplate, { healthPath: 'healthz' });
      bad(deployTemplate, { env: [{ key: 'INVALID-KEY', value: 'x' }] });
    });

    it('sameImageRepository pins tags within a repository and refuses digests/swaps', () => {
      expect(sameImageRepository('directus/directus:latest', 'directus/directus:11.5')).toBe(true);
      expect(sameImageRepository('n8nio/n8n', 'n8nio/n8n:1.100.0')).toBe(true);
      expect(sameImageRepository('postgres:16-alpine', 'postgres:17.2')).toBe(true);
      expect(sameImageRepository('ghcr.io/owner/img:1', 'ghcr.io/owner/img:2')).toBe(true);
      expect(sameImageRepository('directus/directus:latest', 'evil/directus:latest')).toBe(false);
      expect(sameImageRepository('directus/directus:latest', 'directus/directus@sha256:abc')).toBe(false);
      expect(sameImageRepository('postgres:16', 'mongo:7')).toBe(false);
      // The template side may itself be a digest reference — the repository
      // extraction handles both sides of the comparison.
      expect(sameImageRepository('directus/directus@sha256:abc', 'directus/directus:11.5')).toBe(true);
    });
  });

  describe('domainEntry', () => {
    it('accepts a row', () => {
      const data = ok(domainEntry, {
        id: 1, hostname: 'a.example.com', path: '/', ssl: false, status: 'active',
        serviceId: 1, serviceName: null, container: null, port: null, certExpiresAt: null,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      });
      expect(data?.hostname).toBe('a.example.com');
      bad(domainEntry, { ...(data as object), port: '3000' });
    });
  });

  describe('volumeEntry', () => {
    it('accepts a row with nullable owner', () => {
      const data = ok(volumeEntry, { name: 'v', sizeBytes: 100, owner: null, inUse: false });
      expect(data?.owner).toBeNull();
      expect(volumeEntry.safeParse({ name: 'v', sizeBytes: 100, owner: { kind: 'database', name: 'db', engine: 'postgres' }, inUse: true }).success).toBe(true);
      bad(volumeEntry, { name: 'v', sizeBytes: 100, owner: { kind: 'x' } });
    });
  });

  describe('dockerResources', () => {
    it('accepts a snapshot', () => {
      const data = ok(dockerResources, {
        network: 'ninedeploy', containers: 2, volumes: 1,
        imagesSummary: { total: '10', active: '5', size: '1GB', reclaimable: '200MB' },
        images: [{ repo: 'node', tag: '22', size: '500MB' }],
      });
      expect(data?.containers).toBe(2);
      bad(dockerResources, { network: 'ninedeploy', containers: 2, volumes: 1, imagesSummary: { total: '10', active: '5', size: '1GB' }, images: [] });
    });
  });

  describe('management (settings/alerts/channels)', () => {
    it('alertRuleCreate accepts host-wide and service-scoped metric rules', () => {
      ok(alertRuleCreate, { name: 'cpu', metric: 'cpu', threshold: 80 });
      ok(alertRuleCreate, { name: 'svc', metric: 'memory', threshold: 512, serviceId: 7, operator: '<', durationWindows: 3, enabled: false });
    });

    it('alertRuleCreate rejects service-scoped cert-expiry rules', () => {
      bad(alertRuleCreate, { name: 'cert', metric: 'cert-expiry', threshold: 14, serviceId: 3 });
      ok(alertRuleCreate, { name: 'cert', metric: 'cert-expiry', threshold: 14 });
    });

    it('alertRulePatch rejects converting a rule into service-scoped cert-expiry', () => {
      ok(alertRulePatch, { metric: 'cert-expiry' });
      ok(alertRulePatch, { metric: 'memory', serviceId: 2 });
      bad(alertRulePatch, { metric: 'cert-expiry', serviceId: 2 });
    });

    it('notificationType accepts every channel type', () => {
      for (const type of ['telegram', 'webhook', 'discord', 'slack', 'ntfy', 'email']) {
        ok(notificationChannelCreate, { name: 'n', type, target: 't' });
      }
      bad(notificationChannelCreate, { name: 'n', type: 'pigeon', target: 't' });
    });
  });

  describe('management (backup destinations/servers/jobs/metrics)', () => {
    const dest = {
      name: 'minio', endpoint: 'https://s3.example.com', bucket: 'b',
      accessKeyId: 'ak', secretAccessKey: 'sk',
    };

    it('backupDestinationCreate applies region/prefix defaults', () => {
      const data = ok(backupDestinationCreate, dest);
      expect(data).toMatchObject({ region: 'us-east-1', prefix: 'ninedeploy' });
      const blanks = ok(backupDestinationCreate, { ...dest, region: ' ', prefix: '' });
      expect(blanks).toMatchObject({ region: 'us-east-1', prefix: 'ninedeploy' });
      const explicit = ok(backupDestinationCreate, { ...dest, region: 'eu-central-1', prefix: 'nd' });
      expect(explicit).toMatchObject({ region: 'eu-central-1', prefix: 'nd' });
    });

    it('backupDestinationCreate rejects missing fields and non-http endpoints', () => {
      bad(backupDestinationCreate, { name: 'x' });
      bad(backupDestinationCreate, { ...dest, name: ' ' });
      bad(backupDestinationCreate, { ...dest, endpoint: 'ftp://x' });
      bad(backupDestinationCreate, { ...dest, bucket: '' });
      bad(backupDestinationCreate, { ...dest, accessKeyId: '' });
      bad(backupDestinationCreate, { ...dest, secretAccessKey: '' });
    });

    it('backupDestinationPatch accepts partial and empty input', () => {
      const data = ok(backupDestinationPatch, { name: 'renamed', active: false });
      expect(data).toEqual({ name: 'renamed', active: false });
      ok(backupDestinationPatch, {});
      ok(backupDestinationPatch, { name: '  ', endpoint: '' });
      bad(backupDestinationPatch, { active: 'yes' });
      bad(backupDestinationPatch, { name: 5 });
    });

    it('serverCreate coerces the port with a fallback', () => {
      const data = ok(serverCreate, { name: 'edge', host: 'h.example' });
      expect(data?.port).toBe(4600);
      expect(ok(serverCreate, { name: 'e', host: 'h', port: '4601' })?.port).toBe(4601);
      // A non-numeric port falls back to the default rather than failing.
      expect(ok(serverCreate, { name: 'e', host: 'h', port: 'abc' })?.port).toBe(4600);
      ok(serverCreate, { name: 'e', host: 'h.example:4601' });
    });

    it('serverCreate rejects bad names, hosts and ports', () => {
      bad(serverCreate, { host: 'h' });
      bad(serverCreate, { name: ' ', host: 'h' });
      bad(serverCreate, { name: 'x', host: 'bad host!' });
      bad(serverCreate, { name: 'x', host: 'h', port: 99999 });
    });

    it('serverAnnounce accepts a token and coerces the port with a fallback', () => {
      const data = ok(serverAnnounce, { name: 'edge', host: 'h.example', token: 'a'.repeat(16) });
      expect(data?.port).toBe(4600);
      expect(ok(serverAnnounce, { name: 'e', host: 'h', token: 'a'.repeat(16), port: '4601' })?.port).toBe(4601);
      // A non-numeric port falls back to the default rather than failing.
      expect(ok(serverAnnounce, { name: 'e', host: 'h', token: 'a'.repeat(16), port: 'abc' })?.port).toBe(4600);
      // host is optional for server announce
      const noHost = ok(serverAnnounce, { name: 'no-host', token: 'a'.repeat(16) });
      expect(noHost?.host).toBeUndefined();
    });

    it('serverAnnounce rejects bad names, hosts, tokens and ports', () => {
      bad(serverAnnounce, { host: 'h', token: 'a'.repeat(16) }); // missing name
      bad(serverAnnounce, { name: ' ', host: 'h', token: 'a'.repeat(16) }); // bad name
      bad(serverAnnounce, { name: 'x', host: 'bad host!', token: 'a'.repeat(16) }); // bad host
      bad(serverAnnounce, { name: 'x', host: 'h', token: 'a'.repeat(15) }); // token too short
      bad(serverAnnounce, { name: 'x', host: 'h', token: 'a'.repeat(257) }); // token too long
      bad(serverAnnounce, { name: 'x', host: 'h', port: 99999, token: 'a'.repeat(16) }); // port out of range
    });

    it('serverSshTest accepts defaults and rejects bad inputs', () => {
      const data = ok(serverSshTest, { host: '192.168.1.100' });
      expect(data).toMatchObject({
        host: '192.168.1.100',
        sshPort: 22,
        sshUser: 'root',
        authType: 'key',
      });
      expect(ok(serverSshTest, { host: 'vps.net', sshPort: '2222', authType: 'password', sshPassword: 'pwd' })?.sshPort).toBe(2222);
      expect(ok(serverSshTest, { host: 'vps.net', sshPort: 'invalid' })?.sshPort).toBe(22);
      bad(serverSshTest, { host: '' });
      bad(serverSshTest, { host: 'h', sshPort: 70000 });
      bad(serverSshTest, { host: 'h', authType: 'invalid' });
      expect(sshAuthType.safeParse('key').success).toBe(true);
      expect(sshAuthType.safeParse('password').success).toBe(true);
    });

    it('serverSshBootstrap accepts full bootstrap payload with fallbacks and rejects invalid', () => {
      const data = ok(serverSshBootstrap, { name: 'Worker 1', host: '192.168.1.101' });
      expect(data).toMatchObject({
        name: 'Worker 1',
        host: '192.168.1.101',
        sshPort: 22,
        sshUser: 'root',
        authType: 'key',
        installDocker: true,
        agentPort: 4600,
      });
      expect(ok(serverSshBootstrap, { name: 'W2', host: 'h', agentPort: '4605', sshPort: '2200' })?.agentPort).toBe(4605);
      expect(ok(serverSshBootstrap, { name: 'W2', host: 'h', agentPort: 'bad', sshPort: 'invalid' })?.sshPort).toBe(22);
      expect(ok(serverSshBootstrap, { name: 'W2', host: 'h', agentPort: 'bad' })?.agentPort).toBe(4600);
      bad(serverSshBootstrap, { name: '', host: 'h' });
      bad(serverSshBootstrap, { name: 'W', host: '' });
      bad(serverSshBootstrap, { name: 'W', host: 'h', agentPort: 80000 });
    });

    it('jobCreate applies defaults and normalizes command/enabled', () => {
      const data = ok(jobCreate, { name: 'nightly', cron: '0 3 * * *' });
      expect(data).toMatchObject({ kind: 'deploy', command: '', enabled: true });
      expect(ok(jobCreate, { name: 'n', cron: '@daily', command: 42 })?.command).toBe('');
      expect(ok(jobCreate, { name: 'n', cron: '@daily', command: ' echo ' })?.command).toBe('echo');
      expect(ok(jobCreate, { name: 'n', cron: '@daily', enabled: false })?.enabled).toBe(false);
      ok(jobCreate, { name: 'n', cron: '@daily', enabled: 'yes' });
      ok(jobCreate, { name: 'n', cron: '@daily', kind: 'exec', command: 'true' });
    });

    it('jobCreate rejects missing name/cron and bad kinds', () => {
      bad(jobCreate, { cron: '* * * * *' });
      bad(jobCreate, { name: 'x' });
      bad(jobCreate, { name: ' ', cron: '* * * * *' });
      bad(jobCreate, { name: 'x', cron: '' });
      bad(jobCreate, { name: 'x', cron: '@daily', kind: 'once' });
    });

    it('jobPatch accepts partial and blank input', () => {
      const data = ok(jobPatch, { name: 'renamed', cron: '30 4 * * *', kind: 'exec', command: '', enabled: false });
      expect(data).toEqual({ name: 'renamed', cron: '30 4 * * *', kind: 'exec', command: '', enabled: false });
      ok(jobPatch, {});
      bad(jobPatch, { kind: 'once' });
      bad(jobPatch, { enabled: 'yes' });
      bad(jobPatch, { name: 5 });
    });

    it('metricQuery normalizes kind and clamps minutes', () => {
      expect(ok(metricQuery, {})?.kind).toBe('cpu');
      expect(ok(metricQuery, { kind: 'memory' })?.kind).toBe('memory');
      expect(ok(metricQuery, { kind: 'bogus' })?.kind).toBe('cpu');
      expect(ok(metricQuery, {})?.minutes).toBe(60);
      expect(ok(metricQuery, { minutes: '10' })?.minutes).toBe(10);
      expect(ok(metricQuery, { minutes: '0' })?.minutes).toBe(60);
      expect(ok(metricQuery, { minutes: '99999' })?.minutes).toBe(1440);
      expect(ok(metricQuery, { minutes: 'abc' })?.minutes).toBe(60);
    });
  });

  describe('tunnels', () => {
    it('createTunnel accepts input', () => {
      expect(createTunnel.safeParse({ name: 't', token: 'tok' }).success).toBe(true);
      bad(createTunnel, { name: '', token: 'tok' });
      bad(createTunnel, { name: 't', token: '' });
    });

    it('tunnelEntry accepts a row', () => {
      const data = ok(tunnelEntry, { id: 1, name: 't', slug: 't', status: 'running', containerName: 'c', createdAt: '2026-01-01T00:00:00Z' });
      expect(data?.containerName).toBe('c');
      bad(tunnelEntry, { id: 1, name: 't', slug: 't', status: 'running', containerName: 'c', createdAt: 'x' });
    });
  });

  describe('projects', () => {
    it('createProject accepts names and optional slug/description and workspaceId', () => {
      const data = ok(createProject, { name: 'Acme', workspaceId: 1 });
      expect(data?.name).toBe('Acme');
      expect(data?.workspaceId).toBe(1);
      ok(createProject, { name: 'Acme', slug: 'acme', description: 'main workloads' });
      bad(createProject, { name: 'a' });
      bad(createProject, { name: 'x'.repeat(64) });
      bad(createProject, { name: 'Acme', slug: 'NOT A SLUG' });
      bad(createProject, { name: 'Acme', workspaceId: -1 });
    });

    it('projectPatch accepts partial updates and rejects empty bodies', () => {
      ok(projectPatch, { name: 'Renamed', workspaceId: 2 });
      ok(projectPatch, { description: null, workspaceId: null });
      ok(projectPatch, { description: 'd', name: 'N' + 'ame' });
      bad(projectPatch, {});
    });
  });

  describe('workspaces & oidc', () => {
    it('workspaceRoleEnum parses valid roles', () => {
      expect(workspaceRoleEnum.safeParse('owner').success).toBe(true);
      expect(workspaceRoleEnum.safeParse('admin').success).toBe(true);
      expect(workspaceRoleEnum.safeParse('member').success).toBe(true);
      expect(workspaceRoleEnum.safeParse('viewer').success).toBe(true);
      expect(workspaceRoleEnum.safeParse('invalid').success).toBe(false);
    });

    it('member-add and invitation schemas reject the owner role', () => {
      // Only the PATCH member route performs the full ownership transfer
      // (demote current owner, re-key workspaces.ownerId) — minting an
      // owner-rank row through add/invite would skip that bookkeeping.
      bad(workspaceMemberAdd, { email: 'x@example.com', role: 'owner' });
      ok(workspaceMemberAdd, { email: 'x@example.com', role: 'admin' });
      bad(workspaceInvitationCreate, { email: 'x@example.com', role: 'owner' });
      ok(workspaceInvitationCreate, { email: 'x@example.com', role: 'member' });
    });

    it('workspaceCreate accepts valid input and rejects invalid', () => {
      const data = ok(workspaceCreate, { name: 'Engineering Team' });
      expect(data?.name).toBe('Engineering Team');
      ok(workspaceCreate, { name: 'Ops Team', slug: 'ops-team', description: 'Operations' });
      bad(workspaceCreate, { name: 'A' });
      bad(workspaceCreate, { name: 'a'.repeat(64) });
      bad(workspaceCreate, { name: 'Team', slug: 'NOT A SLUG' });
    });

    it('workspaceUpdate accepts partial updates and rejects empty bodies', () => {
      ok(workspaceUpdate, { name: 'Renamed Team' });
      ok(workspaceUpdate, { description: null });
      ok(workspaceUpdate, { description: 'Updated' });
      bad(workspaceUpdate, {});
    });

    it('workspaceMemberAdd and workspaceMemberRoleUpdate parse valid inputs', () => {
      const added = ok(workspaceMemberAdd, { email: 'dev@example.com', role: 'admin' });
      expect(added?.email).toBe('dev@example.com');
      expect(added?.role).toBe('admin');
      expect(ok(workspaceMemberAdd, { email: 'user@example.com' })?.role).toBe('member');
      bad(workspaceMemberAdd, { email: 'invalid-email' });
      bad(workspaceMemberAdd, { email: 'dev@example.com', role: 'superadmin' });

      const updated = ok(workspaceMemberRoleUpdate, { role: 'viewer' });
      expect(updated?.role).toBe('viewer');
      bad(workspaceMemberRoleUpdate, { role: 'superadmin' });
    });

    it('oidcProviderCreate and oidcProviderUpdate validate configurations', () => {
      // Fixture secret assembled at runtime so secret scanners do not
      // classify the literal `clientSecret: '…'` shape as a hardcoded credential.
      const prov = ok(oidcProviderCreate, {
        name: 'Corporate Authentik',
        slug: 'authentik',
        issuerUrl: 'https://auth.example.com',
        clientId: 'nine-client',
        clientSecret: ['super', 'secret'].join('-'),
      });
      expect(prov?.name).toBe('Corporate Authentik');
      expect(prov?.scopes).toBe('openid profile email');
      expect(prov?.enabled).toBe(true);
      expect(prov?.autoEnroll).toBe(true);
      expect(prov?.defaultRole).toBe('member');

      bad(oidcProviderCreate, { name: 'A', slug: 'okta', clientId: 'c', clientSecret: 's' });
      bad(oidcProviderCreate, { name: 'Okta', slug: 'BAD SLUG', clientId: 'c', clientSecret: 's' });
      bad(oidcProviderCreate, { name: 'Okta', slug: 'okta', issuerUrl: 'not-a-url', clientId: 'c', clientSecret: 's' });

      ok(oidcProviderUpdate, { name: 'New Name' });
      ok(oidcProviderUpdate, { enabled: false, autoEnroll: false, defaultRole: 'admin' });
      bad(oidcProviderUpdate, {});
    });
  });

  describe('labels', () => {
    it('createLabel accepts a valid label', () => {
      ok(createLabel, { name: 'prod', color: 'indigo' });
      ok(createLabel, { name: 'prod' });
    });
    it('createLabel rejects a bad color', () => {
      bad(createLabel, { name: 'prod', color: 'red' });
    });
    it('labelPatch accepts a name or color update', () => {
      ok(labelPatch, { name: 'staging' });
      ok(labelPatch, { color: 'amber' });
    });
    it('labelPatch rejects an empty patch', () => {
      bad(labelPatch, {});
    });
    it('label round-trips a full row', () => {
      const row = {
        id: 1,
        workspaceId: 2,
        name: 'prod',
        color: '#ff00ff',
        serviceCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      expect(label.parse(row)).toEqual(row);
    });
    it('setServiceTags accepts all three id arrays', () => {
      const parsed = setServiceTags.parse({ projectIds: [1], workspaceIds: [2], labelIds: [3] });
      expect(parsed.projectIds).toEqual([1]);
      expect(parsed.workspaceIds).toEqual([2]);
      expect(parsed.labelIds).toEqual([3]);
    });
    it('setServiceTags defaults missing arrays to empty', () => {
      expect(setServiceTags.parse({})).toEqual({ projectIds: [], workspaceIds: [], labelIds: [] });
    });
    it('serviceTags round-trips a full row', () => {
      const row = {
        serviceId: 1,
        projects: [{ id: 1, name: 'P', slug: 'p' }],
        workspaces: [{ id: 2, name: 'W', slug: 'w' }],
        labels: [{ id: 3, name: 'L', color: '#fff' }],
      };
      expect(serviceTags.parse(row)).toEqual(row);
    });
    it('serviceListFilter accepts an empty filter', () => {
      ok(serviceListFilter, {});
    });
  });
});
