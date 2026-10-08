/**
 * 0.13 (T5): GitHub App repositories on remote nodes — the panel side.
 *
 * - The refusal matrix: PAT and deploy-key sources stay refused (r268); a
 *   GitHub App is allowed only for an agent that advertises `git.credential`
 *   over the sealed transport, and an older agent is told to update.
 * - Per job: a FRESH (never cached) repository-scoped `contents: read` token
 *   is minted, sent only on git.ensure / git.fetch / git.reset, revoked in
 *   `finally` even when the job throws, and never appears in a log line or an
 *   error.
 * - The three call sites (remote docker, remote compose, fan-out) use it.
 *
 * No network and no docker: `guardedFetch` is a fake GitHub router, the agent
 * transport (`agentOp` / `agentTransportSealed`) is mocked, the egress gate is
 * stubbed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceGithubLinks, serviceTargets, servers, services, sources, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ef'.repeat(32);
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  return {
    guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(),
    agentOp: vi.fn(),
    agentTransportSealed: vi.fn(async (_db: unknown, _serverId: number) => true),
  };
});

vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});
vi.mock('../../src/lib/agentClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/agentClient.js')>();
  return { ...actual, agentOp: h.agentOp, agentTransportSealed: h.agentTransportSealed };
});
vi.mock('../../src/lib/gitEgress.js', () => ({ assertCloneTargetAllowed: vi.fn(async () => undefined) }));

const { nodeGitCredentialSource } = await import('../../src/lib/nodeGitCredential.js');
const { assertRemoteServiceSupported, cloneCredentialKind, remoteServiceRefusal, STATIC_CREDENTIAL_REFUSAL } = await import(
  '../../src/lib/remoteDeploy.js'
);
const { resolveCloneCreds } = await import('../../src/lib/sourceCreds.js');
const { clearGithubAppCaches } = await import('../../src/lib/githubApp.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { createRemoteDockerBuilder } = await import('../../src/engine/builders/remoteDocker.js');
const { createRemoteComposeBuilder } = await import('../../src/engine/builders/remoteCompose.js');
const { deployToTargets: deployToTargetsNow } = await import('../../src/engine/fanout.js');
const { fakeGithub, json, migratedDb, rsaKeyPair, seedApp, seedInstallation } = await import('./githubAppKit.js');

const PAT = 'ghp_staticPersonalAccessToken';
const DEPLOY_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----';
const REPO = 'https://github.com/acme/web.git';
const UPDATE = /update the node agent to use GitHub App repositories on this node/i;
const CAPS_NEW = 'ND-AGENT {"version":"0.13.0","caps":["build-path-guard","workspace.remove","git.credential"]}';
const CAPS_OLD = 'ND-AGENT {"version":"0.12.0","caps":["build-path-guard","workspace.remove"]}';

type Agent = (op: string, params: Record<string, unknown>, sink: (l: string) => void) => Promise<{ exitCode: number; lines: string[] }>;
type Service = typeof services.$inferSelect;

let db: DB;
let app: GithubApp;
let inst: GithubAppInstallation;
let appSourceId: number;
let patSourceId: number;
let keySourceId: number;
let serverA: number;
let serverB: number;
let gh: ReturnType<typeof fakeGithub>;
let seq = 0;
/** One ordered log of agent ops and GitHub calls, to prove WHEN the token is revoked. */
let events: string[] = [];

async function service(values: Partial<typeof services.$inferInsert>): Promise<Service> {
  const n = ++seq;
  const [row] = await db
    .insert(services)
    .values({ name: `svc${n}`, slug: `svc-${n}`, type: 'docker', repoUrl: REPO, branch: 'main', serverId: serverA, ...values })
    .returning();
  return row!;
}

/** A node agent: answers agent.ping with `caps`, records every op, fails `failOn` with `failWith`. */
function fakeAgent(caps: string | null, opts: { failOn?: string; failWith?: string; echo?: string } = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const agent: Agent = async (op, params, sink) => {
    calls.push({ op, params });
    events.push(`agent:${op}`);
    if (op === 'agent.ping') return { exitCode: 0, lines: caps ? [caps] : [] };
    if (opts.echo && op.startsWith('git.')) sink(opts.echo);
    if (op === opts.failOn) throw new Error(opts.failWith ?? `agent ${op} exited with 128`);
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${String(params['name'])}.env`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
    return { exitCode: 0, lines: [] };
  };
  return { agent, calls, git: () => calls.filter((c) => c.op.startsWith('git.')) };
}

/** Every installation-token mint (the repo-id lookup's metadata token included). */
const tokenCalls = () => gh.calls.filter((c) => c.path.endsWith('/access_tokens'));
const isCloneMint = (c: { body: Record<string, unknown> | null }) =>
  (c.body?.['permissions'] as Record<string, string> | undefined)?.['contents'] === 'read';
/** Only the clone-token mints, and the tokens they produced (in order). */
const cloneTokenCalls = () => tokenCalls().filter(isCloneMint);
const cloneTokens = () => gh.minted.filter((_, i) => isCloneMint(tokenCalls()[i]!));
const revokeCalls = () => gh.calls.filter((c) => c.method === 'DELETE' && c.path === '/installation/token');
const revokedTokens = () => revokeCalls().map((c) => (c.headers.get('authorization') ?? '').replace(/^(?:Bearer|token)\s+/i, ''));

beforeAll(async () => {
  db = await migratedDb();
  app = await seedApp(db, rsaKeyPair('pkcs1').privateKey);
  ({ inst, sourceId: appSourceId } = await seedInstallation(db, app, { installationId: 1001 }));
  const [pat] = await db.insert(sources).values({ type: 'github', name: 'pat', tokenEncrypted: encrypt(PAT) }).returning();
  const [key] = await db.insert(sources).values({ type: 'custom', name: 'key', deployKeyEncrypted: encrypt(DEPLOY_KEY) }).returning();
  patSourceId = pat!.id;
  keySourceId = key!.id;
  const [a] = await db.insert(servers).values({ name: 'edge-a', host: '10.0.0.5', tokenEncrypted: encrypt('agent-a') }).returning();
  const [b] = await db.insert(servers).values({ name: 'edge-b', host: '10.0.0.6', tokenEncrypted: encrypt('agent-b') }).returning();
  serverA = a!.id;
  serverB = b!.id;
});

beforeEach(() => {
  clearGithubAppCaches();
  events = [];
  gh = fakeGithub();
  gh.on('GET', /^\/repos\/acme\/web$/, () => json(200, { id: 555, full_name: 'acme/web' }));
  gh.on('DELETE', /^\/installation\/token$/, () => json(204, null));
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(async (url, init) => {
    events.push(`github:${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(url)).pathname}`);
    return gh.handler(url, init);
  });
  h.agentOp.mockReset();
  h.agentTransportSealed.mockReset();
  h.agentTransportSealed.mockResolvedValue(true);
});

describe('which credential the panel would clone with', () => {
  it('none / static / github_app — a live enabled link wins over a PAT source', async () => {
    expect(await cloneCredentialKind(db, await service({ sourceId: null }))).toBe('none');
    expect(await cloneCredentialKind(db, await service({ sourceId: patSourceId }))).toBe('static');
    expect(await cloneCredentialKind(db, await service({ sourceId: keySourceId }))).toBe('static');
    expect(await cloneCredentialKind(db, await service({ sourceId: appSourceId }))).toBe('github_app');
    const linked = await service({ sourceId: patSourceId });
    await db.insert(serviceGithubLinks).values({ serviceId: linked.id, installationRowId: inst.id, repoId: 777, repoFullName: 'acme/web' });
    expect(await cloneCredentialKind(db, linked)).toBe('github_app');
    // A preview inherits its parent's link.
    expect(await cloneCredentialKind(db, { id: 99_999, sourceId: null, previewParentServiceId: linked.id })).toBe('github_app');
    const disabled = await service({ sourceId: patSourceId });
    await db.insert(serviceGithubLinks).values({ serviceId: disabled.id, installationRowId: inst.id, repoId: 777, repoFullName: 'acme/web', enabled: false });
    expect(await cloneCredentialKind(db, disabled)).toBe('static');
  });
});

describe('remoteServiceRefusal: the refusal matrix', () => {
  const probe = (caps: string | null, sealed = true) => {
    const node = fakeAgent(caps);
    return { node, probe: vi.fn(async () => ({ agent: node.agent, nodeLabel: '"edge-a" (#1)', sealed })) };
  };

  it('PAT and deploy-key sources keep the r268 refusal — the node is never even asked', async () => {
    for (const sourceId of [patSourceId, keySourceId]) {
      const p = probe(CAPS_NEW);
      expect(await remoteServiceRefusal(db, await service({ sourceId }), { probe: p.probe })).toBe(STATIC_CREDENTIAL_REFUSAL);
      expect(p.probe).not.toHaveBeenCalled();
    }
  });

  it('a GitHub App on a sealed agent with git.credential is allowed', async () => {
    const p = probe(CAPS_NEW);
    expect(await remoteServiceRefusal(db, await service({ sourceId: appSourceId }), { probe: p.probe })).toBeNull();
    expect(p.node.calls.map((c) => c.op)).toEqual(['agent.ping']);
    // Asking mints nothing.
    expect(tokenCalls()).toHaveLength(0);
  });

  it('a GitHub App on an agent without the capability is refused with the update message', async () => {
    const reason = await remoteServiceRefusal(db, await service({ sourceId: appSourceId }), { probe: probe(CAPS_OLD).probe });
    expect(reason).toMatch(UPDATE);
    expect(reason).toMatch(/version 0\.12\.0/);
    // An agent older than r660 answers the ping with nothing at all.
    expect(await remoteServiceRefusal(db, await service({ sourceId: appSourceId }), { probe: probe(null).probe })).toMatch(UPDATE);
  });

  it('a GitHub App over the unsealed transport is refused, capability or not', async () => {
    const p = probe(CAPS_NEW, false);
    const reason = await remoteServiceRefusal(db, await service({ sourceId: appSourceId }), { probe: p.probe });
    expect(reason).toMatch(/unencrypted transport/);
    expect(reason).toMatch(UPDATE);
    expect(p.node.calls).toHaveLength(0);
  });

  it('an unreachable agent is a refusal naming the cause, not a pass', async () => {
    const reason = await remoteServiceRefusal(db, await service({ sourceId: appSourceId }), {
      probe: async () => ({ agent: async () => Promise.reject(new Error('connect ECONNREFUSED')), nodeLabel: '#1', sealed: true }),
    });
    expect(reason).toMatch(/Could not confirm.*ECONNREFUSED/);
  });

  it('a linked service (PAT source + live link) resolves to the App and is allowed', async () => {
    const linked = await service({ sourceId: patSourceId });
    await db.insert(serviceGithubLinks).values({ serviceId: linked.id, installationRowId: inst.id, repoId: 777, repoFullName: 'acme/web' });
    expect(await remoteServiceRefusal(db, linked, { probe: probe(CAPS_NEW).probe })).toBeNull();
  });

  it('anonymous repositories, image deploys and panel-host services never probe', async () => {
    const p = probe(CAPS_OLD);
    expect(await remoteServiceRefusal(db, await service({ sourceId: null }), { probe: p.probe })).toBeNull();
    expect(await remoteServiceRefusal(db, await service({ sourceId: appSourceId, image: 'nginx:1' }), { probe: p.probe })).toBeNull();
    expect(await remoteServiceRefusal(db, await service({ sourceId: appSourceId, serverId: null }), { probe: p.probe })).toBeNull();
    expect(p.probe).not.toHaveBeenCalled();
  });

  it('the default probe asks the node through the sealed agent transport (queue-time 400 included)', async () => {
    h.agentOp.mockImplementation(async (_db: unknown, _id: number, op: string) => ({ exitCode: 0, lines: op === 'agent.ping' ? [CAPS_OLD] : [] }));
    const svc = await service({ sourceId: appSourceId });
    await expect(assertRemoteServiceSupported(db, svc)).rejects.toMatchObject({ statusCode: 400, code: 'remote_deploy_unsupported', message: expect.stringMatching(UPDATE) });
    expect(h.agentOp).toHaveBeenCalledWith(db, serverA, 'agent.ping', {}, expect.any(Function));
    expect(h.agentTransportSealed).toHaveBeenCalledWith(db, serverA);

    h.agentOp.mockImplementation(async () => ({ exitCode: 0, lines: [CAPS_NEW] }));
    await expect(assertRemoteServiceSupported(db, svc)).resolves.toBeUndefined();
    h.agentTransportSealed.mockResolvedValue(false);
    expect(await remoteServiceRefusal(db, svc)).toMatch(/unencrypted transport/);
  });
});

describe('the per-job session', () => {
  const node = { label: '"edge-a" (#1)', serverId: 1 };

  it('mints a fresh repository-scoped contents:read token per job and revokes exactly that token', async () => {
    const svc = await service({ sourceId: appSourceId });
    const a = fakeAgent(CAPS_NEW);
    const one = await nodeGitCredentialSource(db, svc)(a.agent, node);
    const two = await nodeGitCredentialSource(db, svc)(a.agent, node);
    expect(cloneTokenCalls()).toHaveLength(2);
    for (const call of cloneTokenCalls()) {
      expect(call.body).toEqual({ repository_ids: [555], permissions: { contents: 'read' } });
    }
    const [t1, t2] = cloneTokens();
    expect(t1).not.toBe(t2);
    await one.git('git.ensure', { workspace: svc.slug, url: REPO, depth: '1' }, () => undefined);
    await two.git('git.ensure', { workspace: svc.slug, url: REPO, depth: '1' }, () => undefined);
    expect(a.git().map((c) => (c.params['credential'] as { password: string }).password)).toEqual([t1, t2]);
    await one.release();
    await one.release(); // idempotent
    expect(revokedTokens()).toEqual([t1]);
    // Never cached: a panel clone afterwards gets its own token, not a revoked one.
    const panel = await resolveCloneCreds(db, svc);
    expect([t1, t2]).not.toContain(panel?.token);
    await two.release();
    expect(revokedTokens()).toEqual([t1, t2]);
    // A revoked session sends nothing.
    await expect(one.git('git.fetch', { workspace: svc.slug }, () => undefined)).rejects.toThrow(/already revoked/);
  });

  it('stays repository-scoped on a node even when the link opts into the installation scope', async () => {
    const svc = await service({ sourceId: null });
    await db.insert(serviceGithubLinks).values({ serviceId: svc.id, installationRowId: inst.id, repoId: 777, repoFullName: 'acme/web', tokenScope: 'installation' });
    const session = await nodeGitCredentialSource(db, svc)(fakeAgent(CAPS_NEW).agent, node);
    expect(cloneTokenCalls().at(-1)?.body).toEqual({ repository_ids: [777], permissions: { contents: 'read' } });
    await session.release();
  });

  it('adds the credential (and the repository URL that scopes it) to ensure/fetch/reset only', async () => {
    const svc = await service({ sourceId: appSourceId });
    const a = fakeAgent(CAPS_NEW);
    const session = await nodeGitCredentialSource(db, svc)(a.agent, node);
    await session.git('git.ensure', { workspace: 'w', url: REPO, depth: '1' }, () => undefined);
    await session.git('git.fetch', { workspace: 'w' }, () => undefined);
    await session.git('git.checkout', { workspace: 'w', ref: 'main' }, () => undefined);
    await session.git('git.reset', { workspace: 'w', sha: 'abcdef1' }, () => undefined);
    const credential = { username: 'x-access-token', password: cloneTokens()[0] };
    expect(a.git().map((c) => c.params)).toEqual([
      { workspace: 'w', url: REPO, depth: '1', credential },
      { workspace: 'w', url: REPO, credential },
      { workspace: 'w', ref: 'main' },
      { workspace: 'w', sha: 'abcdef1', url: REPO, credential },
    ]);
    await session.release();
  });

  it('redacts the token from every output line and error', async () => {
    const svc = await service({ sourceId: appSourceId });
    const token = 'ghs_2_SECRETTOKEN'; // ghs_1 is the repository-id lookup's metadata token
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const a = fakeAgent(CAPS_NEW, {
      echo: `fatal: https://x-access-token:${token}@github.com/acme/web.git basic ${basic}`,
      failOn: 'git.fetch',
      failWith: `agent git.fetch failed (400): token ${token} / ${basic}`,
    });
    const session = await nodeGitCredentialSource(db, svc)(a.agent, node);
    expect(cloneTokens()).toEqual([token]);
    const lines: string[] = [];
    await session.git('git.ensure', { workspace: 'w', url: REPO }, (l) => lines.push(l));
    const err = await session.git('git.fetch', { workspace: 'w' }, (l) => lines.push(l)).catch((e: Error) => e);
    expect(lines.length).toBeGreaterThan(0);
    for (const text of [...lines, (err as Error).message]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(basic);
    }
    expect((err as Error).message).toMatch(/\[redacted\]/);
    await session.release();
  });

  it('refuses an old agent, or an unsealed transport, BEFORE anything is minted', async () => {
    const svc = await service({ sourceId: appSourceId });
    await expect(nodeGitCredentialSource(db, svc)(fakeAgent(CAPS_OLD).agent, node)).rejects.toThrow(UPDATE);
    h.agentTransportSealed.mockResolvedValue(false);
    await expect(nodeGitCredentialSource(db, svc)(fakeAgent(CAPS_NEW).agent, node)).rejects.toThrow(/unencrypted transport/);
    await expect(nodeGitCredentialSource(db, svc)(fakeAgent(CAPS_NEW).agent, { label: '#?', serverId: null })).rejects.toThrow(/unencrypted/);
    expect(tokenCalls()).toHaveLength(0);
  });

  it('a static credential is refused at job time too, and the node is never asked', async () => {
    const a = fakeAgent(CAPS_NEW);
    await expect(nodeGitCredentialSource(db, await service({ sourceId: patSourceId }))(a.agent, node)).rejects.toThrow(STATIC_CREDENTIAL_REFUSAL);
    expect(a.calls).toHaveLength(0);
  });

  it('an anonymous repository gets today’s exact calls', async () => {
    const a = fakeAgent(CAPS_OLD);
    const session = await nodeGitCredentialSource(db, await service({ sourceId: null }))(a.agent, node);
    expect(session.git).toBe(a.agent);
    expect(a.calls).toHaveLength(0);
    await session.release();
    expect(gh.calls).toHaveLength(0);
  });
});

describe('call sites', () => {
  const ctx = (svc: Service, log: (l: string) => void) =>
    ({ deploymentId: 7, service: svc, workDir: '/nonexistent', commitSha: 'abcdef1234', env: {}, log }) as never;

  it('remote docker: revoked before the build starts, credential on the git ops only', async () => {
    const svc = await service({ sourceId: appSourceId });
    const a = fakeAgent(CAPS_NEW);
    const logs: string[] = [];
    await createRemoteDockerBuilder(a.agent, { nodeLabel: '"edge-a"', gitCredential: nodeGitCredentialSource(db, svc) }).buildAndRun(
      ctx(svc, (l) => logs.push(l)),
    );
    const token = cloneTokens()[0]!;
    expect(a.git().map((c) => [c.op, (c.params['credential'] as { password?: string } | undefined)?.password])).toEqual([
      ['git.ensure', token],
      ['git.fetch', token],
      ['git.checkout', undefined],
      ['git.reset', token],
    ]);
    expect(events.indexOf('github:DELETE /installation/token')).toBeGreaterThan(events.lastIndexOf('agent:git.reset'));
    expect(events.indexOf('github:DELETE /installation/token')).toBeLessThan(events.indexOf('agent:docker.build'));
    expect(revokedTokens()).toEqual([token]);
    expect(logs.join('\n')).not.toContain(token);
    // Nothing but the git ops ever carried it.
    for (const c of a.calls.filter((c) => !c.op.startsWith('git.'))) expect(JSON.stringify(c.params)).not.toContain(token);
  });

  it('remote docker: the token is revoked in finally when the job throws, and the error never carries it', async () => {
    const svc = await service({ sourceId: appSourceId });
    const token = 'ghs_2_SECRETTOKEN'; // ghs_1 is the repository-id lookup's metadata token
    const a = fakeAgent(CAPS_NEW, { failOn: 'git.fetch', failWith: `agent git.fetch failed: could not read from https://x-access-token:${token}@github.com` });
    const logs: string[] = [];
    const err = await createRemoteDockerBuilder(a.agent, { gitCredential: nodeGitCredentialSource(db, svc) })
      .buildAndRun(ctx(svc, (l) => logs.push(l)))
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(token);
    expect(revokedTokens()).toEqual([token]);
    expect(a.calls.map((c) => c.op)).not.toContain('docker.build');
    expect(logs.join('\n')).not.toContain(token);
  });

  it('remote docker: an old agent fails the deploy with the update message and nothing is minted or cloned', async () => {
    const svc = await service({ sourceId: appSourceId });
    const a = fakeAgent(CAPS_OLD);
    await expect(
      createRemoteDockerBuilder(a.agent, { gitCredential: nodeGitCredentialSource(db, svc) }).buildAndRun(ctx(svc, () => undefined)),
    ).rejects.toThrow(UPDATE);
    expect(tokenCalls()).toHaveLength(0);
    expect(a.git()).toHaveLength(0);
  });

  it('remote compose: a repository stack checks out with the per-job token, revoked even when bring-up fails', async () => {
    const svc = await service({ type: 'compose', sourceId: appSourceId });
    const a = fakeAgent(CAPS_NEW, { failOn: 'docker.composeConfig' });
    await createRemoteComposeBuilder(a.agent, { gitCredential: nodeGitCredentialSource(db, svc) })
      .buildAndRun(ctx(svc, () => undefined))
      .catch(() => undefined);
    const token = cloneTokens()[0]!;
    expect(a.git().filter((c) => c.params['credential'] !== undefined).map((c) => c.op)).toEqual(['git.ensure', 'git.fetch', 'git.reset']);
    expect(revokedTokens()).toEqual([token]);
  });

  it('fan-out: one token per target; a target whose agent is too old fails alone, the other deploys', async () => {
    const svc = await service({ sourceId: appSourceId, serverId: null });
    await db.insert(serviceTargets).values([
      { serviceId: svc.id, serverId: serverA },
      { serviceId: svc.id, serverId: serverB },
    ]);
    const agents = new Map([
      [serverA, fakeAgent(CAPS_NEW)],
      [serverB, fakeAgent(CAPS_OLD)],
    ]);
    h.agentOp.mockImplementation(async (_db: unknown, id: number, op: string, params: Record<string, unknown>, sink: (l: string) => void) =>
      agents.get(id)!.agent(op, params, sink),
    );
    const logs: string[] = [];
    vi.useFakeTimers();
    let results: Awaited<ReturnType<typeof deployToTargetsNow>>;
    try {
      let done = false;
      const run = deployToTargetsNow(
        db,
        {
          service: { id: svc.id, slug: svc.slug, type: 'docker', image: null, port: 3000, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null },
          deploymentId: 9,
          env: {},
          primaryServerId: null,
          source: { repoUrl: REPO, branch: 'main', commitSha: 'abcdef1234', dockerfilePath: 'Dockerfile', baseDir: '.' },
          gitCredential: nodeGitCredentialSource(db, svc),
        },
        (l) => logs.push(l),
      ).finally(() => {
        done = true;
      });
      for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(500);
      results = await run;
    } finally {
      vi.useRealTimers();
    }
    const byServer = new Map(results.map((r) => [r.serverId, r]));
    expect(byServer.get(serverA)?.ok).toBe(true);
    expect(byServer.get(serverB)?.ok).toBe(false);
    expect(byServer.get(serverB)?.error).toMatch(UPDATE);
    expect(cloneTokenCalls()).toHaveLength(1);
    expect(revokedTokens()).toEqual(cloneTokens());
    expect(agents.get(serverB)!.git()).toHaveLength(0);
    expect(logs.join('\n')).not.toContain(cloneTokens()[0]!);
  });
});
