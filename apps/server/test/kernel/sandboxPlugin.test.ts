import { describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { SandboxPlugin } from '../../src/kernel/sandbox/sandboxPlugin.js';
import { createFakeDb } from '../helpers.js';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

describe('SandboxPlugin (Worker Threads)', () => {
  const mockConfig = { paths: { dataDir: '/tmp/test' } } as any;

  it('initializes sandbox worker, handles events, hooks and config RPC', async () => {
    const db = createFakeDb();
    const kernel = new NineDeployKernel(db, mockConfig);

    // Create a standalone temporary worker script in JS for direct Node Worker execution
    const workerScriptPath = join(tmpdir(), `test-worker-${Date.now()}.mjs`);
    const workerCode = `
      import { parentPort } from 'node:worker_threads';
      
      parentPort.on('message', async (msg) => {
        if (msg.type === 'INIT') {
          // Register a hook
          parentPort.postMessage({
            type: 'REGISTER_HOOK',
            payload: { hookId: 'hook-1', hookName: 'deploy:before', priority: 150 }
          });
          
          // Ready handshake
          parentPort.postMessage({
            type: 'READY',
            payload: {
              configSchema: [{ key: 'sandbox_opt', type: 'string', isSecret: false, label: 'Sandbox Opt' }],
              menuItems: [{ id: 'sandbox-menu', slot: 'sidebar:main', label: 'Sandbox Menu', route: '/sandbox' }]
            }
          });
          
          // Emit a custom event after ready — r530: inside the plugin's own
          // \`plugin.<id>.\` namespace, the only names a sandbox may emit.
          setTimeout(() => {
            parentPort.postMessage({
              type: 'EMIT_EVENT',
              payload: { event: 'plugin.test-sandbox.hello', data: { hello: 'from-sandbox' } }
            });
          }, 20);
        }
        
        if (msg.type === 'HOOK_CALL') {
          const { hookId, callId, initialPayload } = msg.payload;
          // Modify payload (r532: the reply echoes the per-invocation callId)
          parentPort.postMessage({
            type: 'HOOK_RESPONSE',
            payload: {
              hookId,
              callId,
              result: { ...initialPayload, targetCommit: 'sandbox-commit-sha' }
            }
          });
        }
        
        if (msg.type === 'SHUTDOWN') {
          process.exit(0);
        }
      });
    `;
    writeFileSync(workerScriptPath, workerCode, 'utf8');

    try {
      const sandboxPlugin = new SandboxPlugin({
        id: 'test-sandbox',
        name: 'Test Sandbox Plugin',
        version: '1.0.0',
        workerPath: workerScriptPath,
      });

      const eventPromise = new Promise<any>((resolve) => {
        kernel.events.onCustom(
          'plugin.test-sandbox.hello',
          (payload, _event, origin) => {
            resolve({ payload, origin });
          },
          { acceptPluginOrigin: true },
        );
      });

      await kernel.registerPlugin(sandboxPlugin);

      // Verify plugin status and registration
      expect(kernel.getPlugin('test-sandbox')).toBeDefined();
      expect(kernel.configCenter.getDefinition('plugin:test-sandbox:sandbox_opt')).toBeDefined();
      expect(kernel.menuRegistry.getAllItems()).toHaveLength(1);

      // Verify custom event received from sandbox
      const receivedEvent = await eventPromise;
      expect(receivedEvent.payload).toEqual({ hello: 'from-sandbox' });
      // r530: tagged host-side with the emitting plugin's origin.
      expect(receivedEvent.origin).toEqual({ kind: 'plugin', pluginId: 'test-sandbox' });

      // Verify hook pipeline execution into worker
      const hookResult = await kernel.hooks.call('deploy:before', {
        service: { id: 10 } as any,
        targetCommit: 'original-sha',
      });
      expect(hookResult.targetCommit).toBe('sandbox-commit-sha');

      // Test clean shutdown
      await kernel.unregisterPlugin('test-sandbox');
      expect(kernel.getPlugin('test-sandbox')).toBeUndefined();
    } finally {
      try {
        unlinkSync(workerScriptPath);
      } catch {}
    }
  });

  it('r234: relays kernel events to the worker under their real names', async () => {
    const db = createFakeDb();
    const kernel = new NineDeployKernel(db, mockConfig);
    const workerScriptPath = join(tmpdir(), `test-worker-events-${Date.now()}.mjs`);
    writeFileSync(
      workerScriptPath,
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg.type === 'INIT') parentPort.postMessage({ type: 'READY', payload: { configSchema: [], menuItems: [] } });
        if (msg.type === 'EVENT' && msg.payload.event === 'deployment.status_changed') {
          parentPort.postMessage({ type: 'EMIT_EVENT', payload: { event: 'plugin.evt-sandbox.relayed', data: { name: msg.payload.event } } });
        }
        if (msg.type === 'SHUTDOWN') process.exit(0);
      });
      `,
      'utf8',
    );
    try {
      const relayed = new Promise<{ name: string }>((resolve) => {
        kernel.events.onCustom('plugin.evt-sandbox.relayed', (payload) => resolve(payload as { name: string }), {
          acceptPluginOrigin: true,
        });
      });
      await kernel.registerPlugin(
        new SandboxPlugin({ id: 'evt-sandbox', name: 'Evt', version: '1.0.0', workerPath: workerScriptPath }),
      );
      kernel.events.emitCustom('deployment.status_changed', { deploymentId: 1 });
      expect(await relayed).toEqual({ name: 'deployment.status_changed' });
      await kernel.unregisterPlugin('evt-sandbox');
    } finally {
      try {
        unlinkSync(workerScriptPath);
      } catch {}
    }
  });

  it('r474: a malformed READY payload still completes the handshake instead of timing out', async () => {
    // The r473 change forwards the object the plugin code RETURNED — which,
    // unlike the install manifest, passed no schema. Garbage declarations
    // used to throw inside the READY handler, get swallowed by the message
    // wrapper, and surface only as a 10 s init timeout that hid the cause.
    const workerScriptPath = join(tmpdir(), `test-worker-malformed-${Date.now()}.mjs`);
    writeFileSync(
      workerScriptPath,
      `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg.type === 'INIT') {
          parentPort.postMessage({
            type: 'READY',
            payload: {
              configSchema: 5,
              menuItems: [{ id: 7, label: 'garbage' }, { id: 'ok-menu', label: 'OK', route: '/ok', slot: 'sidebar:main' }],
              dependencies: 'nope',
            },
          });
        }
        if (msg.type === 'SHUTDOWN') process.exit(0);
      });
      `,
      'utf8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
      const plugin = new SandboxPlugin({ id: 'malformed-sandbox', name: 'Malformed', workerPath: workerScriptPath });
      // Must RESOLVE (handshake completes) — not reject on the 10s timeout.
      await kernel.registerPlugin(plugin);
      expect(kernel.getPlugin('malformed-sandbox')).toBeDefined();
      // The one well-formed menu item registered; the garbage was skipped
      // with a warning naming the plugin.
      expect(kernel.menuRegistry.getAllItems().some((i) => i.id === 'ok-menu')).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed-sandbox'));
      await kernel.unregisterPlugin('malformed-sandbox');
    } finally {
      warnSpy.mockRestore();
      try {
        unlinkSync(workerScriptPath);
      } catch {}
    }
  }, 20000);

  it('handles worker error events gracefully without crashing kernel', async () => {
    const db = createFakeDb();
    const kernel = new NineDeployKernel(db, mockConfig);

    const errorWorkerPath = join(tmpdir(), `test-err-worker-${Date.now()}.mjs`);
    const errorWorkerCode = `
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (msg) => {
        if (msg.type === 'INIT') {
          parentPort.postMessage({ type: 'ERROR', payload: { error: 'Simulated sandbox crash' } });
          parentPort.postMessage({ type: 'READY', payload: {} });
        }
      });
    `;
    writeFileSync(errorWorkerPath, errorWorkerCode, 'utf8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const errPlugin = new SandboxPlugin({
        id: 'crash-sandbox',
        name: 'Crash Sandbox',
        workerPath: errorWorkerPath,
      });

      let statusChangedToErrored = false;
      kernel.events.on('plugin.status_changed', (payload) => {
        if (payload.pluginId === 'crash-sandbox' && payload.status === 'errored') {
          statusChangedToErrored = true;
        }
      });

      await kernel.registerPlugin(errPlugin);
      expect(statusChangedToErrored).toBe(true);

      await kernel.unregisterPlugin('crash-sandbox');
    } finally {
      errSpy.mockRestore();
      try {
        unlinkSync(errorWorkerPath);
      } catch {}
    }
  });
});

// ── r468: the permission-model child process transport ─────────────────
import { fork } from 'node:child_process';
import { SandboxPlugin as SB } from '../../src/kernel/sandbox/sandboxPlugin.js';

describe('SandboxPlugin (process transport, r468)', () => {
  const mockConfig2 = { paths: { dataDir: '/tmp/test' } } as any;

  function writeProcessScript(body: string): string {
    const p = join(tmpdir(), `test-sandbox-proc-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, body);
    return p;
  }

  it('routes by runtime: compiled sibling → process transport, source checkout → worker fallback', async () => {
    // Spy the private transport pickers instead of spawning anything: init()
    // must choose the process transport when the compiled processBootstrap.js
    // sits next to the module, and the legacy worker transport otherwise (a
    // source checkout — vitest/tsx have no loader for a forked child).
    const anyProto = SandboxPlugin.prototype as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const procSpy = vi.fn(async () => undefined);
    const workerSpy = vi.fn(async () => undefined);
    anyProto['initProcessTransport'] = procSpy;
    anyProto['initWorkerTransport'] = workerSpy;
    try {
      const kernel = new NineDeployKernel(createFakeDb(), mockConfig2);
      const ctx = kernel as unknown as Parameters<SandboxPlugin['init']>[0];
      const plugin = new SandboxPlugin({ id: 'route-probe', name: 'Route Probe' });
      await plugin.init(ctx);
      // vitest executes the class from src → no compiled sibling → fallback.
      expect(workerSpy).toHaveBeenCalledTimes(1);
      expect(procSpy).toHaveBeenCalledTimes(0);
      expect(workerSpy.mock.calls[0]![1]).toMatch(/workerBootstrap.js$/);
    } finally {
      delete anyProto['initProcessTransport'];
      delete anyProto['initWorkerTransport'];
    }
  });

  it('sandboxExecArgv builds the permission flags tests can fork with', () => {
    const argv = SB.sandboxExecArgv(['/a', '/b.js']);
    expect(argv[0]).toBe('--permission');
    expect(argv).toContain('--allow-fs-read=/a');
    expect(argv).toContain('--allow-fs-read=/b.js');
    expect(argv).toContain('--max-old-space-size=64');
    expect(argv).toContain('--max-semi-space-size=16');
    // Nothing grants write, child processes, workers or addons.
    expect(argv.some((a) => a.startsWith('--allow-fs-write'))).toBe(false);
    expect(argv).not.toContain('--allow-child-process');
    expect(argv).not.toContain('--allow-worker-threads');
    expect(argv).not.toContain('--allow-addons');
    // r534: nor network — on Node >= 25 that is what keeps sockets denied.
    expect(argv).not.toContain('--allow-net');
  });

  it('r534: network is denied exactly when this Node has a net permission scope', async () => {
    // Pins reality instead of a claim: on Node >= 25 (`--allow-net` exists,
    // the Docker image and CI run 26) the sandbox flags deny a TCP connect;
    // on Node 22/24 the permission model has no net scope and the connect is
    // attempted (refused by the closed port, not by the runtime).
    const probe = writeProcessScript(`
      import net from 'node:net';
      const s = net.connect(9, '127.0.0.1');
      const report = (code) => { process.send({ type: 'PROBE', payload: { code } }); s.destroy(); };
      s.on('error', (e) => report(e.code ?? String(e).slice(0, 60)));
      s.on('connect', () => report('CONNECTED'));
    `);
    const result = await new Promise<{ code: string }>((resolve, reject) => {
      const child = fork(probe, [], { execArgv: SB.sandboxExecArgv([probe]), silent: true, serialization: 'json' });
      const timer = setTimeout(() => reject(new Error('probe timed out')), 15000);
      child.on('message', (m: { type: string; payload: { code: string } }) => {
        if (m.type === 'PROBE') {
          clearTimeout(timer);
          resolve(m.payload);
          child.kill();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`probe exited (${code}) before answering`));
      });
    });
    if (SB.networkDenied()) expect(result.code).toBe('ERR_ACCESS_DENIED');
    else expect(result.code).not.toBe('ERR_ACCESS_DENIED');
  }, 20000);

  it('a sandboxed child CANNOT read the filesystem (the flags actually deny)', async () => {
    const secret = join(tmpdir(), `nd-sandbox-proof-${Date.now()}.txt`);
    writeFileSync(secret, 'MASTER-KEY-MATERIAL');
    const probe = writeProcessScript(`
      import { readFileSync } from 'node:fs';
      try {
        readFileSync(process.argv[2], 'utf8');
        process.send({ type: 'PROBE', payload: { code: 'READ_ALLOWED' } });
      } catch (e) {
        process.send({ type: 'PROBE', payload: { code: e.code ?? String(e).slice(0, 60) } });
      }
    `);
    const result = await new Promise<{ code: string }>((resolve, reject) => {
      const child = fork(probe, [secret], {
        execArgv: SB.sandboxExecArgv([probe]),
        silent: true,
        serialization: 'json',
      });
      const timer = setTimeout(() => reject(new Error('probe timed out')), 15000);
      child.on('message', (m: { type: string; payload: { code: string } }) => {
        if (m.type === 'PROBE') {
          clearTimeout(timer);
          resolve(m.payload);
          child.kill();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`probe exited (${code}) before answering`));
      });
    });
    expect(result.code).toBe('ERR_ACCESS_DENIED');
    unlinkSync(secret);
  }, 20000);

  it('a sandboxed child cannot spawn processes or open worker threads', async () => {
    const probe = writeProcessScript(`
      import { spawn } from 'node:child_process';
      import { Worker } from 'node:worker_threads';
      const codes = {};
      try { spawn('echo', ['x']); codes.spawn = 'ALLOWED'; } catch (e) { codes.spawn = e.code ?? 'DENIED'; }
      try { new Worker(probe); codes.worker = 'ALLOWED'; } catch (e) { codes.worker = e.code ?? 'DENIED'; }
      process.send({ type: 'PROBE', payload: codes });
    `);
    const result = await new Promise<Record<string, string>>((resolve, reject) => {
      const child = fork(probe, [], { execArgv: SB.sandboxExecArgv([probe]), silent: true, serialization: 'json' });
      const timer = setTimeout(() => reject(new Error('probe timed out')), 15000);
      child.on('message', (m: { type: string; payload: Record<string, string> }) => {
        if (m.type === 'PROBE') {
          clearTimeout(timer);
          resolve(m.payload);
          child.kill();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`probe exited (${code}) before answering`));
      });
    });
    expect(result.spawn).not.toBe('ALLOWED');
    expect(result.worker).not.toBe('ALLOWED');
  }, 20000);
});

// ── r470: the processBootstrap honesty tests ────────────────────────────
// vitest cannot instrument a forked child, so src/kernel/sandbox/processBootstrap.ts
// is excluded from coverage — which is exactly how r466 shipped two agentOp
// call sites against a contract only their mocks knew. These tests fork the
// COMPILED dist bootstrap with the REAL permission-model flags and prove the
// full handshake plus the denial the whole r468 boundary rests on. Skipped
// automatically in a source-only checkout (turbo's test task builds first).
import { fileURLToPath } from 'node:url';

const COMPILED_BOOTSTRAP = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'kernel', 'sandbox', 'processBootstrap.js',
);

describe.skipIf(!existsSync(COMPILED_BOOTSTRAP))('processBootstrap — the compiled handshake, for real (r470)', () => {
  function forkSandbox(code: string) {
    // allowReads mirrors initProcessTransport's computation 1:1 — if the
    // plugin's allowlist is ever wrong, THIS is the test that cannot boot.
    const dir = dirname(COMPILED_BOOTSTRAP);
    const allowReads = [dir, join(dir, '..', '..', 'package.json')];
    const child = fork(COMPILED_BOOTSTRAP, [], {
      execArgv: SB.sandboxExecArgv(allowReads),
      env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8', TZ: 'UTC' },
      silent: true,
      serialization: 'json',
    });
    child.stdout?.resume();
    child.stderr?.resume();
    const messages: Array<{ type: string; payload?: any }> = [];
    child.on('message', (m: { type: string; payload?: any }) => messages.push(m));
    const waitFor = (pred: (m: { type: string; payload?: any }) => boolean, ms = 10_000) =>
      new Promise<{ type: string; payload?: any }>((resolve, reject) => {
        const existing = messages.find(pred);
        if (existing) return resolve(existing);
        const timer = setTimeout(
          () => {
            child.off('message', check);
            reject(new Error(`bootstrap never answered; saw: ${messages.map((m) => m.type).join(',') || 'nothing'}`));
          },
          ms,
        );
        const check = (m: { type: string; payload?: any }) => {
          if (pred(m)) {
            clearTimeout(timer);
            child.off('message', check);
            resolve(m);
          }
        };
        child.on('message', check);
      });
    child.send({ type: 'INIT', payload: { pluginId: 'honesty', code } });
    return { child, waitFor };
  }

  const stop = (child: import('node:child_process').ChildProcess) =>
    new Promise<void>((resolve) => {
      // Already gone (the clean-shutdown test's happy path): nothing to stop,
      // and writing to the dead channel would throw.
      if (child.exitCode !== null || !child.connected) return resolve();
      child.on('exit', () => resolve());
      try {
        // The callback absorbs the close-race: a channel that dies between
        // the connected check and the write surfaces as an unhandled
        // ERR_IPC_CHANNEL_CLOSED without it.
        child.send({ type: 'SHUTDOWN', payload: {} }, () => undefined);
      } catch { /* exited mid-send */ }
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000).unref();
    });

  it('boots under the real --permission flags and round-trips INIT→READY→HOOK', async () => {
    const { child, waitFor } = forkSandbox(`
      ctx.logger.info('booted');
      ctx.tapHook('deploy:before', (p) => ({ ...p, targetCommit: 'honesty-sha' }));
    `);
    try {
      await waitFor((m) => m.type === 'LOG' && String(m.payload?.message).includes('booted'));
      const ready = await waitFor((m) => m.type === 'READY');
      expect(ready.type).toBe('READY');
      const reg = await waitFor((m) => m.type === 'REGISTER_HOOK');
      expect(reg.payload?.hookName).toBe('deploy:before');
      child.send({
        type: 'HOOK_CALL',
        payload: { hookId: reg.payload?.hookId, callId: 'call-1', hookName: 'deploy:before', initialPayload: { targetCommit: 'orig' } },
      });
      const resp = await waitFor((m) => m.type === 'HOOK_RESPONSE');
      expect(resp.payload?.result?.targetCommit).toBe('honesty-sha');
      // r532: the shipped bootstrap echoes the per-invocation call id.
      expect(resp.payload?.callId).toBe('call-1');
      expect(resp.payload?.error).toBeUndefined();
    } finally {
      await stop(child);
    }
  }, 20000);

  it('shuts down cleanly on SHUTDOWN (exit 0, not a kill)', async () => {
    const { child, waitFor } = forkSandbox('');
    const exitCode = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    try {
      await waitFor((m) => m.type === 'READY');
      child.send({ type: 'SHUTDOWN', payload: {} });
      expect(await exitCode).toBe(0);
    } finally {
      // A rejected waitFor (broken bootstrap) must not leave the fork behind.
      await stop(child);
    }
  }, 20000);

  it('plugin code CANNOT read the filesystem from inside the real bootstrap', async () => {
    // This test file itself lives in test/kernel — far outside the bootstrap's
    // allowlist — so reading it must come back ERR_ACCESS_DENIED.
    const deniedTarget = fileURLToPath(import.meta.url);
    const { child, waitFor } = forkSandbox(`
      try {
        const fs = await import('node:fs');
        fs.readFileSync(${JSON.stringify(deniedTarget)}, 'utf8');
        ctx.logger.error('READ-SUCCEEDED — the r468 boundary is OPEN');
      } catch (err) {
        ctx.logger.error('READ-DENIED ' + (err && err.code));
      }
    `);
    try {
      const verdict = await waitFor((m) => m.type === 'LOG' && String(m.payload?.message).includes('READ-'));
      expect(String(verdict.payload?.message)).toContain('READ-DENIED');
      expect(String(verdict.payload?.message)).not.toContain('SUCCEEDED');
    } finally {
      await stop(child);
    }
  }, 20000);
});
