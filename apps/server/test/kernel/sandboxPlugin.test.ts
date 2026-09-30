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
          
          // Emit a custom event after ready
          setTimeout(() => {
            parentPort.postMessage({
              type: 'EMIT_EVENT',
              payload: { event: 'custom.system_event', data: { hello: 'from-sandbox' } }
            });
          }, 20);
        }
        
        if (msg.type === 'HOOK_CALL') {
          const { hookId, initialPayload } = msg.payload;
          // Modify payload
          parentPort.postMessage({
            type: 'HOOK_RESPONSE',
            payload: {
              hookId,
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
        kernel.events.onCustom('custom.system_event', (payload) => {
          resolve(payload);
        });
      });

      await kernel.registerPlugin(sandboxPlugin);

      // Verify plugin status and registration
      expect(kernel.getPlugin('test-sandbox')).toBeDefined();
      expect(kernel.configCenter.getDefinition('plugin:test-sandbox:sandbox_opt')).toBeDefined();
      expect(kernel.menuRegistry.getAllItems()).toHaveLength(1);

      // Verify custom event received from sandbox
      const receivedEvent = await eventPromise;
      expect(receivedEvent).toEqual({ hello: 'from-sandbox' });

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
          parentPort.postMessage({ type: 'EMIT_EVENT', payload: { event: 'test.relayed', data: { name: msg.payload.event } } });
        }
        if (msg.type === 'SHUTDOWN') process.exit(0);
      });
      `,
      'utf8',
    );
    try {
      const relayed = new Promise<{ name: string }>((resolve) => {
        kernel.events.onCustom('test.relayed', (payload) => resolve(payload as { name: string }));
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
  });

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
