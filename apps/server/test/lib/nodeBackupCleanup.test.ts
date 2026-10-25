import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, DB } from '@ninedeploy/db';
import type { AgentStreamHandle } from '../../src/lib/agentStream.js';

const h = vi.hoisted(() => ({
  releaseOpen: undefined as undefined | (() => void),
  opened: undefined as undefined | (() => void),
  closed: undefined as undefined | (() => void),
  stream: undefined as undefined | AgentStreamHandle,
}));

// Delay the actual filesystem open, not a timer: an integrity rejection can
// arrive while WriteStream is still waiting to create the partial file.
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    createWriteStream: (file: string, options: import('node:fs').WriteStreamOptions) => {
      if (!file.endsWith('.part')) return fs.createWriteStream(file, options);
      const writer = fs.createWriteStream(file, {
        ...options,
        fs: {
          open: (...args: Parameters<typeof fs.open>) => {
            h.releaseOpen = () => fs.open(...args);
            h.opened?.();
          },
          close: fs.close,
          write: fs.write,
          writev: fs.writev,
        },
      });
      writer.on('close', () => h.closed?.());
      return writer;
    },
  };
});
vi.mock('../../src/lib/agentStream.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/lib/agentStream.js')>()),
  openAgentStream: async () => h.stream!,
}));

import { createBackupDecipher, encrypt } from '../../src/lib/crypto.js';
import { nodeDatabaseRuntime } from '../../src/lib/nodeDatabase.js';
import { backupNodeVolume } from '../../src/lib/nodeVolumes.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nd-backup-cleanup-'));
  vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));
  h.releaseOpen = h.opened = h.closed = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(['volume', 'database'] as const)('node %s backup storage completion', kind => {
  async function start(failIntegrity: boolean) {
    const readable = new PassThrough();
    const integrityError = new Error('the stream ended short: integrity check failed');
    const done = new Promise<never | { bytes: number; sha256: string }>((resolve, reject) => {
      readable.on('end', () => failIntegrity ? reject(integrityError) : resolve({ bytes: 7, sha256: 'verified' }));
    });
    h.stream = { direction: 'agent-to-panel', readable, done, abort: vi.fn() } as AgentStreamHandle;
    const opened = new Promise<void>(resolve => { h.opened = resolve; });
    const closed = new Promise<void>(resolve => { h.closed = resolve; });
    const target = join(dir, 'backup.gz');
    const db = {} as DB;
    const row = { id: 891, serverId: 1, engine: 'postgres', slug: 'cleanup', name: 'cleanup', passwordEncrypted: encrypt('test') } as Database;
    const pending = kind === 'volume'
      ? backupNodeVolume(db, 1, 'cleanup', target, () => undefined)
      : nodeDatabaseRuntime(db, row, { openStream: async () => h.stream! }).backup(target, () => undefined);
    const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await opened;
    return { readable, target, outcome, closed, integrityError };
  }

  it('closes a pending file open before reporting integrity failure and removing partial data', async () => {
    const run = await start(true);
    let settled = false;
    void run.outcome.then(() => { settled = true; });
    try {
      run.readable.end('archive');
      await nextTurn();
      expect.soft(settled).toBe(false);
    } finally {
      h.releaseOpen!();
    }
    const result = await run.outcome;
    await run.closed;
    expect(result.error).toBe(run.integrityError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('publishes a complete authenticated backup after a delayed file open', async () => {
    const run = await start(false);
    run.readable.end('archive');
    h.releaseOpen!();
    expect((await run.outcome).error).toBeUndefined();
    await run.closed;
    expect(readdirSync(dir)).toEqual(['backup.gz']);
    const stored = readFileSync(run.target);
    const end = stored.indexOf(10);
    const decipher = createBackupDecipher(stored.subarray(0, end + 1).toString(), stored.subarray(-16));
    expect(Buffer.concat([decipher.update(stored.subarray(end + 1, -16)), decipher.final()]).toString()).toBe('archive');
  });
});
