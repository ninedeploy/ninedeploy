import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

const { buildEnv, capture, DEFAULT_HEARTBEAT_MS, DEFAULT_TIMEOUT_MS, ExecTimeoutError, run, sleep } = await import(
  '../../src/lib/exec.js'
);

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
  kill?: (signal?: NodeJS.Signals) => boolean;
}

function makeChild(overrides: Partial<FakeChild> = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  Object.assign(child, overrides);
  return child;
}

function emitClose(child: FakeChild, code: number) {
  child.emit('close', code);
}

describe('buildEnv', () => {
  const snapshot: Record<string, string | undefined> = {};
  const keys = ['PATH', 'NINEDEPLOY_MASTER_KEY', 'NINEDEPLOY_JWT_SECRET', 'LC_MESSAGES', 'BUILDKIT_HOST'];

  beforeEach(() => {
    for (const k of keys) snapshot[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it('inherits only whitelisted host vars and merges the caller env', () => {
    process.env['PATH'] = '/usr/bin';
    process.env['NINEDEPLOY_MASTER_KEY'] = 'super-secret';
    process.env['NINEDEPLOY_JWT_SECRET'] = 'jwt-secret';

    const env = buildEnv({ FOO: 'bar' });

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['FOO']).toBe('bar');
    // Host secrets must NEVER leak into subprocesses.
    expect(env['NINEDEPLOY_MASTER_KEY']).toBeUndefined();
    expect(env['NINEDEPLOY_JWT_SECRET']).toBeUndefined();
  });

  it('omits unset whitelisted vars', () => {
    delete process.env['LC_MESSAGES'];
    expect(buildEnv()['LC_MESSAGES']).toBeUndefined();
  });

  it('r413: user env can never override the docker transport keys', async () => {
    // A member setting DOCKER_HOST on their own docker service used to
    // redirect every build/pull of that pipeline to a daemon they control —
    // effective precisely when the HOST defines no value of its own.
    const { spawn: cpSpawn } = await import('node:child_process');
    void cpSpawn;
    const env = buildEnv({
      DOCKER_HOST: 'tcp://attacker:2375',
      DOCKER_CONTEXT: 'evil',
      DOCKER_CONFIG: '/repo/.docker',
      COMPOSE_FILE: '/repo/pwn.yml',
      DOCKER_BUILDKIT: '0',
      NODE_ENV: 'production',
    });
    expect(env['DOCKER_HOST']).toBeUndefined();
    expect(env['DOCKER_CONTEXT']).toBeUndefined();
    expect(env['DOCKER_CONFIG']).toBeUndefined();
    expect(env['COMPOSE_FILE']).toBeUndefined();
    // Non-transport user keys still flow through (builds need them).
    expect(env['NODE_ENV']).toBe('production');
  });

  it('r582: BUILDKIT_HOST reaches subprocesses from the host only, never from user env', () => {
    // railpack reads BUILDKIT_HOST itself; buildEnv() used to drop it, so
    // every railpack build died "BUILDKIT_HOST environment variable is not
    // set" no matter what the operator configured.
    process.env['BUILDKIT_HOST'] = 'docker-container://buildkit';
    expect(buildEnv()['BUILDKIT_HOST']).toBe('docker-container://buildkit');
    // A user env row cannot point the build (context + secrets) elsewhere…
    expect(buildEnv({ BUILDKIT_HOST: 'tcp://attacker:1234' })['BUILDKIT_HOST']).toBe('docker-container://buildkit');
    // …not even where the host sets none.
    delete process.env['BUILDKIT_HOST'];
    expect(buildEnv({ BUILDKIT_HOST: 'tcp://attacker:1234' })['BUILDKIT_HOST']).toBeUndefined();
  });

  it('works with no caller env', () => {
    expect(() => buildEnv()).not.toThrow();
  });
});

describe('run', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('streams stdout and stderr lines to the sink and resolves on exit 0', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const sink = vi.fn();
    const promise = run('echo', ['hi'], { cwd: '/tmp' }, sink);

    child.stdout.emit('data', Buffer.from('one\ntwo\n'));
    child.stderr.emit('data', Buffer.from('warn!\n'));
    emitClose(child, 0);

    await expect(promise).resolves.toBeUndefined();

    // stdin input path: pipe mode + EPIPE guard + end(input)
    const stdinChild = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    mockSpawn.mockReturnValue(stdinChild as never);
    const p2 = run('base64', ['-d'], {}, vi.fn(), Buffer.from('payload'));
    stdinChild.stdin.emit('error', new Error('EPIPE')); // must not crash
    stdinChild.emit('close', 0);
    await expect(p2).resolves.toBeUndefined();
    expect(stdinChild.stdin.end).toHaveBeenCalledWith(Buffer.from('payload'));
    const lastCall = mockSpawn.mock.calls.at(-1) as unknown as [unknown, unknown, { stdio: string[] }];
    const stdio = lastCall[2].stdio;
    expect(stdio[0]).toBe('pipe');

    expect(mockSpawn).toHaveBeenCalledWith(
      'echo',
      ['hi'],
      expect.objectContaining({
        cwd: '/tmp',
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(sink).toHaveBeenCalledWith('one');
    expect(sink).toHaveBeenCalledWith('two');
    expect(sink).toHaveBeenCalledWith('warn!');
  });

  it('buffers partial lines across chunks and flushes the tail on close', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const sink = vi.fn();
    const promise = run('cmd', [], {}, sink);

    // "a\n\nb" → 'a' emitted now, 'b' is a partial line buffered until close.
    child.stdout.emit('data', Buffer.from('a\n\nb'));
    emitClose(child, 0);

    await promise;
    expect(sink).toHaveBeenCalledWith('a');
    expect(sink).toHaveBeenCalledWith('b');
    expect(sink).not.toHaveBeenCalledWith('');
  });

  it('keeps multi-byte UTF-8 intact when a character straddles a chunk boundary', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const sink = vi.fn();
    const promise = run('cmd', [], {}, sink);

    // 'a\r\n日\n' with the split inside the 3-byte 日 (E6 97 | A5). The first
    // chunk ends on an incomplete sequence: decoding must wait for the next
    // chunk instead of emitting U+FFFD.
    const full = Buffer.from('a\r\n日\n', 'utf8');
    child.stdout.emit('data', full.subarray(0, 4));
    child.stdout.emit('data', full.subarray(4));
    emitClose(child, 0);

    await promise;
    expect(sink).toHaveBeenCalledWith('a');
    expect(sink).toHaveBeenCalledWith('日');
  });

  it('keeps stdout and stderr line discipline separate when partial lines interleave', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const sink = vi.fn();
    const promise = run('cmd', [], {}, sink);

    // stdout's partial line must not absorb stderr bytes that arrive before
    // the newline completes the stdout line — each stream keeps its own
    // pending buffer, or interleaved output (docker build progress, git
    // fetch) renders as merged garbage lines.
    child.stdout.emit('data', Buffer.from('Step 1/2'));
    child.stderr.emit('data', Buffer.from('#10 extracting\n'));
    child.stdout.emit('data', Buffer.from(' done\n'));
    emitClose(child, 0);

    await promise;
    expect(sink).toHaveBeenCalledWith('#10 extracting');
    expect(sink).toHaveBeenCalledWith('Step 1/2 done');
    expect(sink).not.toHaveBeenCalledWith('Step 1/2#10 extracting');
  });

  it('passes a whitelisted env (not the full process.env) to spawn', async () => {
    process.env['NINEDEPLOY_MASTER_KEY'] = 'leak';
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = run('cmd', [], { env: { FOO: 'bar' } }, vi.fn());
    emitClose(child, 0);
    await promise;
    const env = mockSpawn.mock.calls[0]![2]!.env as Record<string, string>;
    expect(env['FOO']).toBe('bar');
    expect(env['NINEDEPLOY_MASTER_KEY']).toBeUndefined();
  });

  it('rejects when the process exits non-zero', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = run('false', [], {}, vi.fn());
    emitClose(child, 1);
    await expect(promise).rejects.toThrow('`false` exited with code 1');
  });

  it('rejects when the process emits an error', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const boom = new Error('ENOENT');
    const promise = run('missing', [], {}, vi.fn());
    child.emit('error', boom);
    await expect(promise).rejects.toBe(boom);
  });

  it('reports silent work with a safe label and stops heartbeats after exit', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const sink = vi.fn();
    const promise = run(
      'docker',
      ['login', '--password', 'must-not-leak'],
      { heartbeatMs: 1000, heartbeatLabel: 'Pulling application image' },
      sink,
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(sink).toHaveBeenCalledWith('Still working: Pulling application image (1s elapsed) …');
    expect(sink.mock.calls.flat().join(' ')).not.toContain('must-not-leak');

    child.stdout.emit('data', Buffer.from('activity without a newline'));
    sink.mockClear();
    await vi.advanceTimersByTimeAsync(999);
    expect(sink).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sink).toHaveBeenCalledWith('Still working: Pulling application image (2s elapsed) …');

    emitClose(child, 0);
    await promise;
    sink.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink).not.toHaveBeenCalled();
  });

  it('allows heartbeats to be disabled', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const sink = vi.fn();
    const promise = run('quiet', [], { heartbeatMs: 0 }, sink);
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_MS * 2);
    expect(sink).not.toHaveBeenCalled();
    emitClose(child, 0);
    await promise;
  });
});

describe('run — timeout & tree-kill', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('signals the whole process group, then escalates to SIGKILL', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = makeChild({ pid: 4242 });
    mockSpawn.mockReturnValue(child);

    const promise = run('stuck', [], { timeoutMs: 500 }, vi.fn());
    promise.catch(() => {}); // attach handler before the timer fires the rejection
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    // SIGKILL escalation fires 5s after the SIGTERM.
    await vi.advanceTimersByTimeAsync(5000);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('falls back to child.kill when the group signal fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const kill = vi.fn();
    const child = makeChild({ pid: 4242, kill });
    mockSpawn.mockReturnValue(child);

    const promise = run('stuck', [], { timeoutMs: 500 }, vi.fn());
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('absorbs child.kill errors when the process is already dead', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const child = makeChild({ pid: 4242, kill });
    mockSpawn.mockReturnValue(child);

    const promise = run('stuck', [], { timeoutMs: 500 }, vi.fn());
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);
  });

  it('skips signalling when the child has no pid', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = makeChild(); // no pid → guard returns early
    mockSpawn.mockReturnValue(child);

    const promise = run('stuck', [], { timeoutMs: 500 }, vi.fn());
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('ignores close/error that arrive after the timeout already settled', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = makeChild({ pid: 4242 });
    mockSpawn.mockReturnValue(child);

    const promise = run('stuck', [], { timeoutMs: 1000 }, vi.fn());
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);

    // Late events must not cause an unhandled rejection / double-settle.
    expect(() => {
      emitClose(child, 0);
      child.emit('error', new Error('late'));
    }).not.toThrow();
  });
});

describe('capture', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('collects stdout and resolves on exit 0', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('df', ['-k', '/']);

    child.stdout.emit('data', Buffer.from('Filesystem\n/dev/disk 123'));
    child.stderr.emit('data', Buffer.from('ignored'));
    emitClose(child, 0);

    await expect(promise).resolves.toBe('Filesystem\n/dev/disk 123');
  });

  it('reassembles a multi-byte UTF-8 sequence split across stdout chunks', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('node', ['-e', '']);

    // 日 is E6 97 A5 — the first chunk ends mid-sequence.
    const cjk = Buffer.from('日', 'utf8');
    child.stdout.emit('data', cjk.subarray(0, 2));
    child.stdout.emit('data', cjk.subarray(2));
    emitClose(child, 0);

    await expect(promise).resolves.toBe('日');
  });

  it('reassembles a multi-byte UTF-8 sequence split across stderr chunks in the rejection message', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('docker', ['stats']);

    // é is C3 A9 — split after the lead byte.
    const msg = Buffer.from('échec', 'utf8');
    child.stderr.emit('data', msg.subarray(0, 1));
    child.stderr.emit('data', msg.subarray(1));
    emitClose(child, 2);

    await expect(promise).rejects.toThrow('`docker stats` exited 2: échec');
  });

  it('decodes a truncated trailing multi-byte sequence as U+FFFD instead of throwing', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('node', ['-e', '']);

    child.stdout.emit('data', Buffer.from('ok', 'utf8'));
    child.stdout.emit('data', Buffer.from('日', 'utf8').subarray(0, 2)); // never completed
    emitClose(child, 0);

    await expect(promise).resolves.toBe('ok\uFFFD');
  });

  it('includes stderr in the rejection message on non-zero exit', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('docker', ['stats']);
    child.stderr.emit('data', Buffer.from('daemon not running'));
    emitClose(child, 2);
    await expect(promise).rejects.toThrow('`docker stats` exited 2: daemon not running');
  });

  it('rejects on spawn error', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const boom = new Error('spawn failed');
    const promise = capture('nope', []);
    child.emit('error', boom);
    await expect(promise).rejects.toBe(boom);
  });

  it('rejects on non-zero exit with no stderr (omits the stderr suffix)', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('docker', ['stats']);
    // No stderr data emitted → errOut is empty.
    emitClose(child, 2);
    await expect(promise).rejects.toThrow('`docker stats` exited 2');
  });

  it('rejects with ExecTimeoutError when the command exceeds its timeout', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('slow', [], { timeoutMs: 250 });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);
  });

  it('ignores close after a timeout settled', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('slow', [], { timeoutMs: 250 });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(() => emitClose(child, 0)).not.toThrow();
  });

  it('ignores error after a timeout settled', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('slow', [], { timeoutMs: 250 });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(() => child.emit('error', new Error('late'))).not.toThrow();
  });
});

describe('ExecTimeoutError', () => {
  it('exposes the command and timeout', () => {
    const err = new ExecTimeoutError('docker build', 1000);
    expect(err.cmd).toBe('docker build');
    expect(err.message).toContain('1000ms');
    expect(err.name).toBe('ExecTimeoutError');
  });
});

describe('sleep', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves after the given number of milliseconds', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const promise = sleep(500).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    await promise;
    expect(resolved).toBe(true);
  });
});

describe('DEFAULT_TIMEOUT_MS', () => {
  it('is 30 minutes', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});

describe('DEFAULT_HEARTBEAT_MS', () => {
  it('is 20 seconds', () => {
    expect(DEFAULT_HEARTBEAT_MS).toBe(20 * 1000);
  });
});

describe('error labels redact credential argv (audit fix)', () => {
  // Secrets travel as argv (`mysqldump --password=…`, `mongodump -p …`,
  // `redis-cli -a …`). A rejected run used to embed the RAW argv, shipping
  // database passwords into journald, the audit log and notifications via the
  // error message.
  it('masks --password= values in run/capture error labels', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = run(
      'docker',
      ['exec', 'cn', 'mysqldump', '-uroot', '--password=sup3rs3kr3t', '--all-databases'],
      {},
      vi.fn(),
    );
    emitClose(child, 1);
    await expect(promise).rejects.toThrow(/--password=\*\*\*/);
    await expect(promise).rejects.not.toThrow(/sup3rs3kr3t/);
  });

  it('masks the value following -p / -a style flags', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('docker', ['exec', 'cn', 'mongodump', '-u', 'nine', '-p', 'p4ssw0rd']);
    emitClose(child, 1);
    await expect(promise).rejects.toThrow(/-p \*\*\*/);
    await expect(promise).rejects.not.toThrow(/p4ssw0rd/);
  });

  it('leaves non-credential operands readable for debugging', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = run('docker', ['exec', 'cn', 'pg_dump', '-U', 'nine', '-d', 'app'], {}, vi.fn());
    emitClose(child, 1);
    await expect(promise).rejects.toThrow(/pg_dump -U nine -d app/);
  });

  it('r412: masks --env values (nixpacks builds carry the whole runtime env on argv)', async () => {
    // A failed nixpacks build used to paste every project secret and
    // managed-database URL into the deploy log (readable by workspace
    // members), the audit trail and notifications. The KEY stays readable.
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const onePiece = run(
      'nixpacks',
      ['build', '.', '--name', 'ninedeploy/web:abc1234', '--env', 'DATABASE_URL=postgres://nine:p%40ss@db/app'],
      {},
      vi.fn(),
    );
    emitClose(child, 1);
    await expect(onePiece).rejects.toThrow(/--env \*\*\*/);
    await expect(onePiece).rejects.not.toThrow(/p%40ss/);

    const joined = run('nixpacks', ['build', '.', '--env=SHARED_SECRET=hunter2'], {}, vi.fn());
    emitClose(child, 1);
    await expect(joined).rejects.toThrow(/--env=SHARED_SECRET=\*\*\*/);
    await expect(joined).rejects.not.toThrow(/hunter2/);
  });
});

/**
 * r667: output ceilings. `capture` buffered stdout/stderr without limit and
 * the line splitter kept a newline-less tail without limit — one container
 * printing an endless line made `docker logs --tail 300` (lines, not bytes)
 * hold all of it in the panel.
 */
describe('r667: bounded child output', () => {
  beforeEach(() => mockSpawn.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('passes an endless line on in bounded pieces instead of buffering it whole', async () => {
    const { MAX_LINE_CHARS } = await import('../../src/lib/exec.js');
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const sink = vi.fn();
    const promise = run('docker', ['logs', 'x'], {}, sink);
    const chunk = Buffer.alloc(MAX_LINE_CHARS, 'a');
    for (let i = 0; i < 3; i++) child.stdout.emit('data', chunk);
    // Emitted while the line is still open — nothing waits for a newline.
    expect(sink.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [line] of sink.mock.calls) expect((line as string).length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    emitClose(child, 0);
    await promise;
    expect(sink.mock.calls.reduce((n, [l]) => n + (l as string).length, 0)).toBe(3 * MAX_LINE_CHARS);
  });

  it('capture stops a child whose stdout passes the ceiling, and rejects', async () => {
    const { ExecOutputTooLargeError } = await import('../../src/lib/exec.js');
    const child = makeChild({ pid: 4242 });
    mockSpawn.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const promise = capture('docker', ['logs', '--tail', '300', 'x'], { maxOutputBytes: 1024 });
    child.stdout.emit('data', Buffer.alloc(800, 'a'));
    child.stdout.emit('data', Buffer.alloc(800, 'b'));
    await expect(promise).rejects.toBeInstanceOf(ExecOutputTooLargeError);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    // Late data and the close are ignored.
    child.stdout.emit('data', Buffer.alloc(800, 'c'));
    emitClose(child, 0);
  });

  it('capture keeps a bounded stderr tail for its error message', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = capture('docker', ['pull', 'x']);
    child.stderr.emit('data', Buffer.alloc(300 * 1024, 'e'));
    child.stderr.emit('data', Buffer.from('the real error'));
    emitClose(child, 1);
    const err = (await promise.catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('the real error');
    expect(err.message.length).toBeLessThan(200 * 1024);
  });
});

/**
 * r664: ssh's last argv element is the remote command line. The node
 * bootstrap's carries the agent token hash (the node's sealing key), and a
 * failed bootstrap put it into the operator's 400 and the server log.
 */
describe('r664: the ssh remote command never reaches an error label', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('masks the remote command of a failed ssh call', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = run('ssh', ['-o', 'BatchMode=yes', 'root@10.0.0.5', 'docker run -e NINEDEPLOY_AGENT_TOKEN=deadbeefcafe agent'], {}, () => {});
    emitClose(child, 255);
    const err = (await promise.catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('root@10.0.0.5 <remote command>');
    expect(err.message).not.toContain('deadbeefcafe');
  });

  it('labels other commands exactly as before', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = run('docker', ['build', '-t', 'x', '.'], {}, () => {});
    emitClose(child, 1);
    await expect(promise).rejects.toThrow('`docker build -t x .` exited with code 1');
  });
});
