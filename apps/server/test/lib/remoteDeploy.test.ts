import { describe, expect, it } from 'vitest';
import {
  assertRemoteDeploySupported,
  assertRemoteServiceSupported,
  remoteDatabaseRefusal,
  remoteDeploySupported,
  remoteDeployUnsupportedReason,
  remoteServiceRefusal,
} from '../../src/lib/remoteDeploy.js';

/**
 * r037. Remote deployments used to be refused for every service type, because
 * no builder read `server_id` and running anyway would have put the container
 * on the PANEL host while the panel reported the node. Docker services now
 * route through the node's agent; what remains is a narrower refusal for the
 * shapes the agent genuinely has no operation for.
 *
 * The reason strings are operator-facing — they are what someone reads in a
 * failed deployment — so they are asserted, not just the boolean.
 */
describe('remoteDeploySupported', () => {
  it('accepts docker and compose, and nothing else', () => {
    expect(remoteDeploySupported('docker')).toBe(true);
    // Most of the one-click template catalogue is compose-shaped, so without
    // this the whole template library was unavailable on a node.
    expect(remoteDeploySupported('compose')).toBe(true);
    expect(remoteDeploySupported('pm2')).toBe(false);
    expect(remoteDeploySupported('something-new')).toBe(false);
  });
});

describe('remoteDeployUnsupportedReason', () => {
  it('names the actual missing capability per type', () => {
    expect(remoteDeployUnsupportedReason('pm2')).toMatch(/host processes/);
    // An unrecognised type must still produce a sentence, not `undefined`.
    expect(remoteDeployUnsupportedReason('quantum')).toMatch(/"quantum" has no remote implementation/);
  });

  it('always tells the operator how to get unstuck', () => {
    for (const type of ['pm2', 'quantum']) {
      expect(remoteDeployUnsupportedReason(type)).toMatch(/Clear the target server/);
    }
  });
});

describe('assertRemoteDeploySupported', () => {
  it('passes a service that is not pinned to a node at all', () => {
    expect(() => assertRemoteDeploySupported({ serverId: null, type: 'pm2' })).not.toThrow();
    expect(() => assertRemoteDeploySupported({ type: 'pm2' })).not.toThrow();
  });

  it('passes a docker or compose service pinned to a node', () => {
    expect(() => assertRemoteDeploySupported({ serverId: 4, type: 'docker' })).not.toThrow();
    expect(() => assertRemoteDeploySupported({ serverId: 4, type: 'compose' })).not.toThrow();
  });

  it('defaults a missing type to docker rather than refusing', () => {
    expect(() => assertRemoteDeploySupported({ serverId: 4 })).not.toThrow();
    expect(() => assertRemoteDeploySupported({ serverId: 4, type: null })).not.toThrow();
  });

  it('throws a 400 with the machine-readable code the panel switches on', () => {
    try {
      assertRemoteDeploySupported({ serverId: 4, type: 'pm2' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('remote_deploy_unsupported');
      expect(e.message).toMatch(/host processes/);
    }
  });
});

describe('remoteDatabaseRefusal (r269)', () => {
  const noAttachments = { query: { databaseAttachments: { findMany: async () => [] } } } as never;

  it('refuses a template that declares a managed database before it is attached', async () => {
    // The attachment only appears once reconcileTemplateDependencies has run —
    // after this check — so the mapping is the signal on the first deploy.
    expect(
      await remoteDatabaseRefusal(noAttachments, { id: 1, serverId: 4, templateDatabaseEnv: { DB_HOST: 'host' } }),
    ).toMatch(/provisions a managed database/);
  });

  it('passes a template without a database, and any panel-host service', async () => {
    expect(await remoteDatabaseRefusal(noAttachments, { id: 1, serverId: 4, templateDatabaseEnv: null })).toBeNull();
    expect(
      await remoteDatabaseRefusal(noAttachments, { id: 1, serverId: null, templateDatabaseEnv: { DB_HOST: 'host' } }),
    ).toBeNull();
  });
});

/** A db whose volume-attachment select answers `rows`. */
const attachmentsDb = (rows: unknown[] = []) =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as never;

describe('remoteServiceRefusal (r266)', () => {
  it('refuses a docker service whose container needs a command on a node', async () => {
    // minio's bare entrypoint prints help and exits: without `server /data`
    // it "deployed" and was never up.
    const reason = await remoteServiceRefusal(attachmentsDb(), {
      id: 1,
      serverId: 4,
      type: 'docker',
      cmd: ['server', '/data'],
    });
    expect(reason).toMatch(/container command/);
    expect(reason).toMatch(/Clear the target server/);
  });

  it('refuses the Docker socket mount and extra volume attachments', async () => {
    expect(await remoteServiceRefusal(attachmentsDb(), { id: 1, serverId: 4, dockerSocket: true })).toMatch(
      /Docker socket/,
    );
    expect(
      await remoteServiceRefusal(attachmentsDb([{ id: 9 }]), { id: 1, serverId: 4, type: 'docker' }),
    ).toMatch(/attached volumes/);
  });

  it('passes a plain docker service, a compose service and any panel-host service', async () => {
    expect(await remoteServiceRefusal(attachmentsDb(), { id: 1, serverId: 4, type: 'docker', cmd: [] })).toBeNull();
    // Compose carries its own command and volumes inside the stack.
    expect(
      await remoteServiceRefusal(attachmentsDb([{ id: 9 }]), { id: 1, serverId: 4, type: 'compose' }),
    ).toBeNull();
    expect(
      await remoteServiceRefusal(attachmentsDb([{ id: 9 }]), {
        id: 1,
        serverId: null,
        dockerSocket: true,
        cmd: ['x'],
      }),
    ).toBeNull();
  });

  it('r268: refuses a repository the node would have to clone with the panel credential', async () => {
    const withSource = (src: Record<string, unknown> | undefined) =>
      ({
        select: () => ({ from: () => ({ where: async () => [] }) }),
        query: { sources: { findFirst: async () => src } },
      }) as never;
    const repoSvc = { id: 1, serverId: 4, type: 'docker', sourceId: 3, repoUrl: 'https://github.com/acme/private.git' };
    // The panel clones with the token; the node's git.ensure has no credential
    // operand and failed "repository not found" after the panel checkout passed.
    expect(await remoteServiceRefusal(withSource({ type: 'github', tokenEncrypted: 'x' }), repoSvc)).toMatch(
      /node clones anonymously/,
    );
    expect(
      await remoteServiceRefusal(withSource({ type: 'custom', deployKeyEncrypted: 'k' }), { ...repoSvc, type: 'compose' }),
    ).toMatch(/Git credential/);
    // No credential material, a registry source (image pulls), an image deploy
    // or an inline stack: nothing for the node to clone privately.
    expect(await remoteServiceRefusal(withSource({ type: 'github' }), repoSvc)).toBeNull();
    expect(await remoteServiceRefusal(withSource({ type: 'registry', tokenEncrypted: 'x' }), repoSvc)).toBeNull();
    expect(
      await remoteServiceRefusal(withSource({ type: 'github', tokenEncrypted: 'x' }), { ...repoSvc, image: 'nginx:1' }),
    ).toBeNull();
    expect(
      await remoteServiceRefusal(withSource({ type: 'github', tokenEncrypted: 'x' }), {
        ...repoSvc,
        type: 'compose',
        composeContent: 'services: {}',
      }),
    ).toBeNull();
  });

  it('assertRemoteServiceSupported throws the 400 the panel switches on', async () => {
    await expect(
      assertRemoteServiceSupported(attachmentsDb(), { id: 1, serverId: 4, dockerSocket: true }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'remote_deploy_unsupported' });
  });
});
