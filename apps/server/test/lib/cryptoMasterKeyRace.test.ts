import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'winner-exists' | 'disappears-once' | 'disappears-twice',
  createAttempts: 0,
  flags: [] as Array<string | undefined>,
  winner: 'b'.repeat(64),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync(
      file: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ): void {
      const isMasterKey = typeof file === 'string' && path.basename(file) === 'master.key';
      if (!isMasterKey || race.mode === 'none') {
        Reflect.apply(actual.writeFileSync, undefined, [file, data, options]);
        return;
      }

      race.createAttempts += 1;
      race.flags.push(typeof options === 'object' && options !== null ? options.flag : undefined);
      if (race.mode === 'winner-exists' && race.createAttempts === 1) {
        actual.writeFileSync(file, race.winner, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        throw Object.assign(new Error('competing creator won'), { code: 'EEXIST' });
      }
      if (race.mode === 'disappears-once' && race.createAttempts === 1) {
        throw Object.assign(new Error('winner disappeared'), { code: 'EEXIST' });
      }
      if (race.mode === 'disappears-twice') {
        throw Object.assign(new Error('winner disappeared'), { code: 'EEXIST' });
      }
      Reflect.apply(actual.writeFileSync, undefined, [file, data, options]);
    },
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const ownedDirs: string[] = [];

function scratch(): string {
  const dir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'ninedeploy-key-race-'));
  ownedDirs.push(dir);
  return dir;
}

function resetRace(mode: typeof race.mode): void {
  race.mode = mode;
  race.createAttempts = 0;
  race.flags = [];
  vi.resetModules();
  vi.stubEnv('NINEDEPLOY_MASTER_KEY', '');
  vi.stubEnv('NINEDEPLOY_MASTER_KEYS', '');
}

afterEach(() => {
  race.mode = 'none';
  vi.unstubAllEnvs();
  for (const dir of ownedDirs.splice(0)) actualFs.rmSync(dir, { recursive: true, force: true });
});

describe('atomic master-key creation', () => {
  it('adopts the persisted winner after exclusive creation loses with EEXIST', async () => {
    const dir = scratch();
    resetRace('winner-exists');
    vi.stubEnv('NINEDEPLOY_DATA_DIR', dir);

    const losingProcess = await import('../../src/lib/crypto.js');
    const ciphertext = losingProcess.encrypt('shared-secret');

    expect(race.flags).toEqual(['wx']);
    expect(actualFs.readFileSync(path.join(dir, 'master.key'), 'utf8')).toBe(race.winner);

    race.mode = 'none';
    vi.resetModules();
    const restartedProcess = await import('../../src/lib/crypto.js');
    expect(restartedProcess.decrypt(ciphertext)).toBe('shared-secret');
  });

  it('retries once when the winning file disappears after EEXIST', async () => {
    const dir = scratch();
    resetRace('disappears-once');
    vi.stubEnv('NINEDEPLOY_DATA_DIR', dir);

    const mod = await import('../../src/lib/crypto.js');
    expect(mod.activeKeyVersion()).toBe(0);
    expect(race.createAttempts).toBe(2);
    expect(race.flags).toEqual(['wx', 'wx']);
    expect(actualFs.readFileSync(path.join(dir, 'master.key'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails after the bounded retry without poisoning the lazy key-ring cache', async () => {
    const dir = scratch();
    resetRace('disappears-twice');
    vi.stubEnv('NINEDEPLOY_DATA_DIR', dir);

    const mod = await import('../../src/lib/crypto.js');
    expect(() => mod.activeKeyVersion()).toThrow(/disappeared during initialization/i);
    expect(race.createAttempts).toBe(2);

    // Repair the filesystem condition and retry through the SAME imported
    // module. A failed initialization must not cache a partial key ring.
    race.mode = 'none';
    expect(mod.activeKeyVersion()).toBe(0);
    expect(actualFs.readFileSync(path.join(dir, 'master.key'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('converges on one persisted key across real processes', async () => {
    race.mode = 'none';
    const dir = scratch();
    const go = path.join(dir, 'go');
    const cryptoUrl = new URL('../../src/lib/crypto.ts', import.meta.url).href;
    const script = `
      import { createHash } from 'node:crypto';
      import { existsSync, readFileSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      const deadline = Date.now() + 10000;
      process.stdout.write('ready\\n');
      while (!existsSync(${JSON.stringify(go)})) {
        if (Date.now() > deadline) throw new Error('start barrier timed out');
        await delay(5);
      }
      const crypto = await import(${JSON.stringify(cryptoUrl)});
      crypto.activeKeyVersion();
      const key = readFileSync(${JSON.stringify(path.join(dir, 'master.key'))}, 'utf8').trim();
      process.stdout.write('digest:' + createHash('sha256').update(key).digest('hex') + '\\n');
    `;
    const children = [spawnChild(script, dir), spawnChild(script, dir)];
    try {
      await Promise.all(children.map((child) => waitForLine(child, 'ready', 10_000)));
      actualFs.writeFileSync(go, 'go');
      const outputs = await Promise.all(children.map((child) => collectChild(child, 10_000)));
      const digests = outputs.map((output) => /digest:([0-9a-f]{64})/.exec(output)?.[1]);
      expect(digests[0]).toBeDefined();
      expect(digests[1]).toBe(digests[0]);
      expect(actualFs.readFileSync(path.join(dir, 'master.key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

function spawnChild(script: string, dataDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      NINEDEPLOY_DATA_DIR: dataDir,
      NINEDEPLOY_MASTER_KEY: '',
      NINEDEPLOY_MASTER_KEYS: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForLine(child: ChildProcessWithoutNullStreams, line: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${line}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      if (!chunk.toString().includes(line)) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited before ${line} (code ${code})`));
    });
  });
}

function collectChild(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}
