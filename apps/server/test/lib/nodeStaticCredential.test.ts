/**
 * Multi-node T3 (design §3, owner decision O5): PATs and deploy keys on nodes
 * — the panel side.
 *
 * - The refusal matrix {PAT, deploy key} × {source allowed / not} × {agent
 *   0.13, 0.15, current, current with static credentials switched off} ×
 *   {sealed, plain}. A source that does not allow nodes keeps the r268
 *   refusal byte-for-byte and the node is never asked.
 * - The host check (a credential is never sent to another provider's host)
 *   and the clone URL / user name the panel itself uses.
 * - The per-job sessions: a PAT as `{username, password, static: true}` on
 *   the network git ops only; a deploy key wrapped in `git.withKey`; both
 *   redacted from every line and error; nothing to revoke.
 * - The call site: the remote docker builder clones a deploy-key repository
 *   through `git.withKey`.
 *
 * No network and no docker: the agent transport is mocked, the egress gate stubbed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigs, servers, services, sources, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ef'.repeat(32);
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  return { agentOp: vi.fn(), agentTransportSealed: vi.fn(async (_db: unknown, _serverId: number) => true) };
});
vi.mock('../../src/lib/agentClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/agentClient.js')>();
  return { ...actual, agentOp: h.agentOp, agentTransportSealed: h.agentTransportSealed };
});
vi.mock('../../src/lib/gitEgress.js', () => ({ assertCloneTargetAllowed: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { nodeGitCredentialSource, staticTokenUsername } = await import('../../src/lib/nodeGitCredential.js');
const rd = await import('../../src/lib/remoteDeploy.js');
const { resetNodeCapabilityCache } = await import('../../src/lib/agentCapabilities.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { createRemoteDockerBuilder } = await import('../../src/engine/builders/remoteDocker.js');
const { migratedDb } = await import('./githubAppKit.js');

const PAT = 'glpat-staticPersonalAccessToken';
const KEY_BODY = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW';
const DEPLOY_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----`;
const ping = (version: string, caps: string[]) => `ND-AGENT ${JSON.stringify({ version, caps })}`;
const BASE = ['build-path-guard', 'workspace.remove', 'git.credential'];
const AGENTS = {
  '0.13': ping('0.13.0', BASE),
  '0.15': ping('0.15.1', [...BASE, 'terminal', 'terminal.host']),
  current: ping('0.15.2', [...BASE, 'terminal', 'terminal.host', 'stream', 'image.manage', 'build.nixpacks', 'build.railpack', 'git.sshkey']),
  switchedOff: ping('0.15.2', [...BASE, 'terminal', 'terminal.host', 'stream', 'image.manage', 'build.nixpacks', 'build.railpack']),
} as const;

type Agent = (op: string, params: Record<string, unknown>, sink: (l: string) => void) => Promise<{ exitCode: number; lines: string[] }>;

let db: DB;
let serverId: number;
let seq = 0;

async function source(values: Partial<typeof sources.$inferInsert>): Promise<number> {
  const [row] = await db.insert(sources).values({ type: 'gitlab', name: `src${++seq}`, ...values }).returning();
  return row!.id;
}
async function service(values: Partial<typeof services.$inferInsert>) {
  const n = ++seq;
  const [row] = await db
    .insert(services)
    .values({ name: `svc${n}`, slug: `svc-${n}`, type: 'docker', repoUrl: 'https://gitlab.com/acme/web.git', branch: 'main', serverId, ...values })
    .returning();
  return row!;
}

/** A node agent answering agent.ping with `caps`, recording every op. */
function fakeAgent(caps: string | null, opts: { echo?: string; failOn?: string; failWith?: string } = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const agent: Agent = async (op, params, sink) => {
    calls.push({ op, params });
    if (op === 'agent.ping') return { exitCode: 0, lines: caps ? [caps] : [] };
    if (opts.echo && (op.startsWith('git.'))) sink(opts.echo);
    if (op === opts.failOn) throw new Error(opts.failWith ?? `agent ${op} exited with 128`);
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${String(params['name'])}.env`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
    return { exitCode: 0, lines: [] };
  };
  return { agent, calls, ops: () => calls.map((c) => c.op) };
}
const probeFor = (caps: string | null, sealed = true) => {
  const a = fakeAgent(caps);
  return { a, probe: async () => ({ agent: a.agent, nodeLabel: '"edge-1" (#4)', sealed }) };
};

beforeAll(async () => {
  db = await migratedDb();
  const [s] = await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', tokenEncrypted: encrypt('t'), status: 'online' }).returning();
  serverId = s!.id;
});
beforeEach(() => {
  h.agentOp.mockReset();
  h.agentTransportSealed.mockReset();
  h.agentTransportSealed.mockResolvedValue(true);
  resetNodeCapabilityCache();
});

describe('staticClonePlan: the panel’s own choice, and the host check', () => {
  it('token over https; a deploy key over the SSH form of the URL (lib/git.ts toSshUrl)', () => {
    expect(rd.staticClonePlan({ type: 'gitlab', tokenEncrypted: 'x' }, 'https://gitlab.com/acme/web.git')).toEqual({ mode: 'token', url: 'https://gitlab.com/acme/web.git' });
    expect(rd.staticClonePlan({ type: 'github', deployKeyEncrypted: 'k' }, 'https://github.com/acme/web')).toEqual({ mode: 'key', url: 'git@github.com:acme/web.git' });
    expect(rd.staticClonePlan({ type: 'github', deployKeyEncrypted: 'k', tokenEncrypted: 'x' }, 'git@github.com:acme/web.git')).toEqual({
      mode: 'key',
      url: 'git@github.com:acme/web.git',
    });
    // Both stored and an https URL: the token wins, as on the panel.
    expect(rd.staticClonePlan({ type: 'github', deployKeyEncrypted: 'k', tokenEncrypted: 'x' }, 'https://github.com/acme/web.git')).toMatchObject({ mode: 'token' });
  });

  it('never sends a provider’s credential to another host; a base URL names the host; custom has none to check', () => {
    expect(rd.staticClonePlan({ type: 'github', name: 'gh', tokenEncrypted: 'x' }, 'https://evil.example/acme/web.git')).toEqual({
      refusal: expect.stringMatching(/refusing to send the github credential "gh" to evil\.example — it belongs to github\.com/),
    });
    expect(rd.staticClonePlan({ type: 'bitbucket', deployKeyEncrypted: 'k' }, 'ssh://git@github.com/acme/web.git')).toMatchObject({ refusal: expect.stringMatching(/bitbucket\.org/) });
    expect(rd.staticClonePlan({ type: 'gitea', tokenEncrypted: 'x', baseUrl: 'https://git.example.com' }, 'https://git.example.com/a/b.git')).toMatchObject({ mode: 'token' });
    expect(rd.staticClonePlan({ type: 'gitea', tokenEncrypted: 'x', baseUrl: 'https://git.example.com' }, 'https://other.example.com/a/b.git')).toHaveProperty('refusal');
    expect(rd.staticClonePlan({ type: 'custom', tokenEncrypted: 'x' }, 'https://git.internal/a/b.git')).toMatchObject({ mode: 'token' });
    expect(rd.staticClonePlan({ type: 'custom', tokenEncrypted: 'x' }, 'git@git.internal:a/b.git')).toMatchObject({ refusal: expect.stringMatching(/not an http\(s\) URL/) });
  });

  it('the user name is the panel’s (lib/git.ts tokenUserinfo)', () => {
    expect(staticTokenUsername('gitlab')).toBe('oauth2');
    expect(staticTokenUsername('github')).toBe('x-access-token');
    expect(staticTokenUsername('custom')).toBe('x-access-token');
  });
});

describe('the refusal matrix (queue time, remoteServiceRefusalDetail)', () => {
  const kinds = {
    pat: { tokenEncrypted: () => encrypt(PAT) },
    key: { deployKeyEncrypted: () => encrypt(DEPLOY_KEY) },
  } as const;
  const feature = { pat: 'clone with a personal access token', key: 'clone with a deploy key' } as const;

  for (const kind of ['pat', 'key'] as const) {
    it(`${kind}: not allowed on nodes keeps the r268 refusal (400), and the node is never asked`, async () => {
      const cred = kind === 'pat' ? { tokenEncrypted: kinds.pat.tokenEncrypted() } : { deployKeyEncrypted: kinds.key.deployKeyEncrypted() };
      const svc = await service({ sourceId: await source(cred) });
      const { a, probe } = probeFor(AGENTS.current);
      expect(await rd.remoteServiceRefusalDetail(db, svc, { probe })).toEqual({ status: 400, code: 'remote_deploy_unsupported', message: rd.STATIC_CREDENTIAL_REFUSAL });
      expect(rd.STATIC_CREDENTIAL_REFUSAL).toMatch(/node clones anonymously.*build it on the panel.*allow this credential on nodes/s);
      expect(a.calls).toEqual([]);
    });

    for (const [agentName, expected] of [
      ['0.13', { status: 422, code: 'node_agent_outdated', re: /\(version 0\.13\.0\) cannot .*Update the node agent to v0\.15\.2/ }],
      ['0.15', { status: 422, code: 'node_agent_outdated', re: /\(version 0\.15\.1\) cannot .*Update the node agent to v0\.15\.2/ }],
      ['switchedOff', { status: 403, code: 'node_feature_disabled', re: /NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off/ }],
      ['current', null],
    ] as const) {
      it(`${kind}: allowed on nodes, agent ${agentName}, sealed → ${expected ? `${expected.status} ${expected.code}` : 'allowed'}`, async () => {
        const cred = kind === 'pat' ? { tokenEncrypted: kinds.pat.tokenEncrypted() } : { deployKeyEncrypted: kinds.key.deployKeyEncrypted() };
        const svc = await service({ sourceId: await source({ ...cred, allowOnNodes: true }) });
        const { a, probe } = probeFor(AGENTS[agentName]);
        const refusal = await rd.remoteServiceRefusalDetail(db, svc, { probe });
        if (expected === null) expect(refusal).toBeNull();
        else {
          expect(refusal).toMatchObject({ status: expected.status, code: expected.code });
          expect(refusal!.message).toMatch(expected.re);
          expect(refusal!.message).toContain(feature[kind]);
        }
        expect(a.ops()).toEqual(['agent.ping']);
      });
    }

    it(`${kind}: allowed, but the plain transport → 422 node_transport_unsealed before the agent is asked`, async () => {
      const cred = kind === 'pat' ? { tokenEncrypted: kinds.pat.tokenEncrypted() } : { deployKeyEncrypted: kinds.key.deployKeyEncrypted() };
      const svc = await service({ sourceId: await source({ ...cred, allowOnNodes: true }) });
      const { a, probe } = probeFor(AGENTS.current, false);
      expect(await rd.remoteServiceRefusalDetail(db, svc, { probe })).toMatchObject({ status: 422, code: 'node_transport_unsealed' });
      expect(a.calls).toEqual([]);
    });
  }

  it('the queue-time assert throws the status and code (422 for an outdated agent, through the real probe)', async () => {
    const svc = await service({ sourceId: await source({ tokenEncrypted: encrypt(PAT), allowOnNodes: true }) });
    h.agentOp.mockImplementation(async (_db: unknown, _id: number, op: string) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: [AGENTS['0.15']] };
      throw new Error('unexpected op');
    });
    await expect(rd.assertRemoteServiceSupported(db, svc)).rejects.toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect(h.agentOp.mock.calls.map((c) => c[2])).toEqual(['agent.ping']);
  });

  it('a host mismatch is refused (400) without asking the node', async () => {
    const svc = await service({ repoUrl: 'https://github.com/acme/web.git', sourceId: await source({ tokenEncrypted: encrypt(PAT), allowOnNodes: true }) });
    const { a, probe } = probeFor(AGENTS.current);
    expect(await rd.remoteServiceRefusalDetail(db, svc, { probe })).toMatchObject({ status: 400, message: expect.stringMatching(/belongs to gitlab\.com/) });
    expect(a.calls).toEqual([]);
  });
});

describe('the per-job sessions', () => {
  const node = () => ({ label: '"edge-1" (#4)', serverId });

  it('PAT: {username, password, static: true} on ensure/fetch/reset only, with the URL; redacted; nothing to revoke', async () => {
    const svc = await service({ sourceId: await source({ tokenEncrypted: encrypt(PAT), allowOnNodes: true }) });
    const a = fakeAgent(AGENTS.current, { echo: `fatal: ${PAT} rejected`, failOn: 'git.reset', failWith: `remote said ${PAT}` });
    const session = await nodeGitCredentialSource(db, svc)(a.agent, node());
    const lines: string[] = [];
    await session.git('git.ensure', { workspace: 'w', url: svc.repoUrl, depth: '1' }, (l) => lines.push(l));
    await session.git('git.checkout', { workspace: 'w', ref: 'main' }, () => undefined);
    const err = await session.git('git.reset', { workspace: 'w', sha: 'abcdef1' }, () => undefined).catch((e: Error) => e);
    expect((err as Error).message).toBe('remote said [redacted]');
    expect(lines).toEqual(['fatal: [redacted] rejected']);
    const credential = { username: 'oauth2', password: PAT, static: true };
    expect(a.calls.filter((c) => c.op.startsWith('git.')).map((c) => c.params)).toEqual([
      { workspace: 'w', url: svc.repoUrl, depth: '1', credential },
      { workspace: 'w', ref: 'main' },
      { workspace: 'w', sha: 'abcdef1', url: svc.repoUrl, credential },
    ]);
    await session.release();
    await expect(session.git('git.fetch', { workspace: 'w' }, () => undefined)).rejects.toThrow(/already closed/);
  });

  it('deploy key: ensure/fetch/reset go through git.withKey with the SSH URL; other ops are plain; redacted', async () => {
    const svc = await service({ repoUrl: 'https://gitlab.com/acme/web.git', sourceId: await source({ deployKeyEncrypted: encrypt(DEPLOY_KEY), allowOnNodes: true }) });
    const a = fakeAgent(AGENTS.current, { failOn: 'git.withKey', failWith: `Load key ${KEY_BODY}: invalid format` });
    const session = await nodeGitCredentialSource(db, svc)(a.agent, node());
    const err = await session.git('git.ensure', { workspace: 'w', url: svc.repoUrl, depth: '1' }, () => undefined).catch((e: Error) => e);
    expect((err as Error).message).toBe('Load key [redacted]: invalid format');
    await session.git('git.checkout', { workspace: 'w', ref: 'main' }, () => undefined);
    expect(a.calls.filter((c) => c.op !== 'agent.ping')).toEqual([
      {
        op: 'git.withKey',
        params: {
          op: 'git.ensure',
          params: { workspace: 'w', url: 'git@gitlab.com:acme/web.git', depth: '1' },
          key: { privateKey: DEPLOY_KEY, hostKeyPolicy: 'accept-new' },
        },
      },
      { op: 'git.checkout', params: { workspace: 'w', ref: 'main' } },
    ]);
  });

  it('job time refuses exactly like queue time: a source that does not allow nodes, an old agent, the plain transport', async () => {
    const denied = await service({ sourceId: await source({ tokenEncrypted: encrypt(PAT) }) });
    const a = fakeAgent(AGENTS.current);
    await expect(nodeGitCredentialSource(db, denied)(a.agent, node())).rejects.toThrow(rd.STATIC_CREDENTIAL_REFUSAL);
    expect(a.calls).toEqual([]);
    const allowed = await service({ sourceId: await source({ deployKeyEncrypted: encrypt(DEPLOY_KEY), allowOnNodes: true }) });
    const old = fakeAgent(AGENTS['0.15']);
    await expect(nodeGitCredentialSource(db, allowed)(old.agent, node())).rejects.toThrow(/cannot clone with a deploy key\. Update the node agent/);
    expect(old.ops()).toEqual(['agent.ping']);
    h.agentTransportSealed.mockResolvedValue(false);
    const plain = fakeAgent(AGENTS.current);
    await expect(nodeGitCredentialSource(db, allowed)(plain.agent, node())).rejects.toThrow(/never sent in clear/);
    expect(plain.calls).toEqual([]);
  });

  it('the remote docker builder clones a deploy-key repository through git.withKey, then builds', async () => {
    const svc = await service({ repoUrl: 'git@gitlab.com:acme/web.git', sourceId: await source({ deployKeyEncrypted: encrypt(DEPLOY_KEY), allowOnNodes: true }) });
    await db.insert(buildConfigs).values({ serviceId: svc.id, buildPack: 'dockerfile' });
    const a = fakeAgent(AGENTS.current);
    await createRemoteDockerBuilder(a.agent, { nodeLabel: '"edge-1" (#4)', gitCredential: nodeGitCredentialSource(db, svc) }).buildAndRun({
      deploymentId: 7,
      service: { ...svc, port: 3000 },
      buildConfig: { buildPack: 'dockerfile' },
      workDir: '/nonexistent/x',
      commitSha: 'deadbeefcafe',
      env: {},
      log: () => undefined,
    } as never);
    expect(a.ops().filter((op) => op !== 'agent.ping').slice(1, 5)).toEqual(['git.withKey', 'git.withKey', 'git.checkout', 'git.withKey']);
    expect(a.ops()).toContain('docker.build');
    for (const c of a.calls.filter((x) => x.op === 'git.withKey')) expect(JSON.stringify(c.params)).toContain('git@gitlab.com:acme/web.git');
  });
});
