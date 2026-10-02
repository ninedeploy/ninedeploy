import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// r530: the out-of-namespace refusal is audited once — capture it instead of
// writing to the fake DB.
const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../src/lib/audit.js', () => ({ audit: auditMock }));

import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { DomainPresetsPlugin } from '../../src/kernel/plugins/domainPresets.js';
import { TelemetryStreamerPlugin } from '../../src/kernel/plugins/telemetry.js';
import { isSandboxEventAllowed, SandboxPlugin } from '../../src/kernel/sandbox/sandboxPlugin.js';
import { createFakeDb } from '../helpers.js';

/**
 * The sandbox isolation seams, driven through the REAL SandboxPlugin message
 * dispatch (worker transport — the same handleMessage the permission-model
 * child process speaks) against a real kernel.
 */

const mockConfig = { paths: { dataDir: '/tmp/test' } } as never;
const scripts: string[] = [];

function workerScript(body: string): string {
  const p = join(tmpdir(), `nd-sandbox-iso-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    p,
    `import { parentPort } from 'node:worker_threads';
const post = (m) => parentPort.postMessage(m);
${body}`,
    'utf8',
  );
  scripts.push(p);
  return p;
}

afterEach(() => {
  auditMock.mockClear();
  for (const p of scripts.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
});

const until = <T>(register: (resolve: (v: T) => void) => void, ms = 10_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the sandbox')), ms);
    register((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });

describe('r530 — sandbox plugins cannot forge kernel events', () => {
  it('namespace rule: only plugin.<own id>.<name>', () => {
    expect(isSandboxEventAllowed('acme', 'plugin.acme.ping')).toBe(true);
    expect(isSandboxEventAllowed('acme', 'plugin.acme.')).toBe(false);
    expect(isSandboxEventAllowed('acme', 'plugin.other.ping')).toBe(false);
    expect(isSandboxEventAllowed('acme', 'audit.recorded')).toBe(false);
    expect(isSandboxEventAllowed('acme', 'plugin.status_changed')).toBe(false);
    expect(isSandboxEventAllowed('acme', '*')).toBe(false);
    expect(isSandboxEventAllowed('acme', 42)).toBe(false);
    expect(isSandboxEventAllowed('acme', `plugin.acme.${'x'.repeat(300)}`)).toBe(false);
  });

  it('a forged audit.recorded domain.delete no longer deletes a real DNS record', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const deleteRecord = vi.fn(async () => undefined);
    kernel.registry.registerDomainProvider({
      name: 'cloudflare',
      listZones: async () => [],
      findZoneForHost: async () => null,
      createRecord: async () => ({ recordId: 'x', hostname: 'x', type: 'A' as const }),
      deleteRecord,
    });
    // domain-presets' ledger: every hostname has a stored record it would delete.
    vi.spyOn(kernel.configCenter, 'get').mockImplementation(async (key: string, def?: unknown) =>
      key.startsWith('plugin:domain-presets:record:')
        ? (JSON.stringify({ provider: 'cloudflare', zoneId: 'zone-1', recordId: 'rec-1' }) as never)
        : (def as never),
    );
    vi.spyOn(kernel.configCenter, 'delete').mockResolvedValue(true);
    await kernel.registerPlugin(new DomainPresetsPlugin());

    // Control: the SAME event from the kernel (the audit bridge) does delete —
    // proving the setup would catch a forged one getting through.
    kernel.events.emit('audit.recorded', { action: 'domain.delete', entity: 'kernel.example.com', actorUserId: 1, ts: 'now' });
    await vi.waitFor(() => expect(deleteRecord).toHaveBeenCalledTimes(1));
    deleteRecord.mockClear();

    const alerts = vi.fn();
    kernel.events.on('deployment.status_changed', alerts);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forger = new SandboxPlugin({
      id: 'forger',
      name: 'Forger',
      workerPath: workerScript(`
        parentPort.on('message', (msg) => {
          if (msg.type === 'INIT') {
            post({ type: 'READY', payload: {} });
            for (let i = 0; i < 3; i++) {
              post({ type: 'EMIT_EVENT', payload: { event: 'audit.recorded', data: { action: 'domain.delete', entity: 'victim.example.com', actorUserId: 1, ts: 'now' } } });
            }
            post({ type: 'EMIT_EVENT', payload: { event: 'deployment.status_changed', data: { status: 'failed', serviceName: 'prod' } } });
            post({ type: 'EMIT_EVENT', payload: { event: 'plugin.forger.done', data: {} } });
          }
          if (msg.type === 'SHUTDOWN') process.exit(0);
        });
      `),
    });
    const done = until<void>((resolve) =>
      kernel.events.onCustom('plugin.forger.done', () => resolve(), { acceptPluginOrigin: true }),
    );
    try {
      await kernel.registerPlugin(forger);
      await done;
      await new Promise((r) => setTimeout(r, 20));

      expect(deleteRecord).not.toHaveBeenCalled();
      expect(alerts).not.toHaveBeenCalled();
      expect(forger.rejectedEmitCount).toBe(4);
      // Logged once per distinct name, audited once per load — no per-event spam.
      const refusals = warn.mock.calls.filter((c) => String(c[0]).includes('refused to emit'));
      expect(refusals).toHaveLength(2);
      expect(String(refusals[0]![0])).toContain('plugin.forger.<name>');
      expect(auditMock).toHaveBeenCalledTimes(1);
      expect(auditMock).toHaveBeenCalledWith(expect.anything(), null, 'plugin.event_rejected', 'forger', {
        event: 'audit.recorded',
        rule: 'plugin.forger.<name>',
      });
    } finally {
      warn.mockRestore();
      await kernel.unregisterPlugin('forger');
    }
  }, 20000);

  it('the bus never hands a plugin-origin emission to a typed listener (consumer hardening)', () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const typed = vi.fn();
    const optedIn = vi.fn();
    const wildcard = vi.fn();
    kernel.events.on('audit.recorded', typed);
    kernel.events.onCustom('audit.recorded', optedIn, { acceptPluginOrigin: true });
    kernel.events.onCustom('*', wildcard);

    const origin = { kind: 'plugin' as const, pluginId: 'p' };
    kernel.events.emitCustom('audit.recorded', { action: 'domain.delete' }, origin);
    expect(typed).not.toHaveBeenCalled();
    expect(optedIn).toHaveBeenCalledWith({ action: 'domain.delete' }, 'audit.recorded', origin);
    expect(wildcard).toHaveBeenCalledWith({ action: 'domain.delete' }, 'audit.recorded', origin);

    kernel.events.emit('audit.recorded', { action: 'domain.add', entity: null, actorUserId: null, ts: 'now' });
    // Kernel emissions keep the historical one-argument call.
    expect(typed).toHaveBeenCalledWith({ action: 'domain.add', entity: null, actorUserId: null, ts: 'now' });
  });

  it('telemetry does not re-emit (and so never exports) a plugin-origin emission', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    await kernel.registerPlugin(new TelemetryStreamerPlugin());
    const recorded = vi.fn();
    kernel.events.on('telemetry.recorded', recorded);

    kernel.events.emitCustom('custom.thing', { a: 1 }, { kind: 'plugin', pluginId: 'p' });
    expect(recorded).not.toHaveBeenCalled();
    kernel.events.emitCustom('custom.thing', { a: 1 });
    expect(recorded).toHaveBeenCalledTimes(1);
  });
});

describe('r532 — concurrent calls of one sandbox hook resolve independently', () => {
  it('a slow first call and a fast second call each get THEIR OWN answer', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const plugin = new SandboxPlugin({
      id: 'concurrent',
      name: 'Concurrent',
      workerPath: workerScript(`
        parentPort.on('message', (msg) => {
          if (msg.type === 'INIT') {
            post({ type: 'REGISTER_HOOK', payload: { hookId: 'h1', hookName: 'deploy:before' } });
            post({ type: 'READY', payload: {} });
          }
          if (msg.type === 'HOOK_CALL') {
            const { hookId, callId, initialPayload } = msg.payload;
            // The FIRST call answers last.
            const delay = initialPayload.targetCommit === 'a' ? 200 : 10;
            setTimeout(() => post({
              type: 'HOOK_RESPONSE',
              payload: { hookId, callId, result: { ...initialPayload, targetCommit: initialPayload.targetCommit + '-x' } },
            }), delay);
          }
          if (msg.type === 'SHUTDOWN') process.exit(0);
        });
      `),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await kernel.registerPlugin(plugin);
      const started = Date.now();
      const [a, b] = await Promise.all([
        kernel.hooks.call('deploy:before', { service: { id: 1 } as never, targetCommit: 'a' }),
        kernel.hooks.call('deploy:before', { service: { id: 1 } as never, targetCommit: 'b' }),
      ]);
      // Pre-r532 the second registration overwrote the first's pending entry:
      // call "a" never resolved and fell to the 5 s per-tap timeout unchanged.
      expect(a.targetCommit).toBe('a-x');
      expect(b.targetCommit).toBe('b-x');
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      errSpy.mockRestore();
      await kernel.unregisterPlugin('concurrent');
    }
  }, 20000);
});

describe('r533 — secrets do not cross the IPC boundary', () => {
  it('hook payloads and relayed events arrive redacted; the pipeline keeps the real values', async () => {
    const kernel = new NineDeployKernel(createFakeDb(), mockConfig);
    const plugin = new SandboxPlugin({
      id: 'redact-probe',
      name: 'Redact Probe',
      workerPath: workerScript(`
        parentPort.on('message', (msg) => {
          if (msg.type === 'INIT') {
            post({ type: 'REGISTER_HOOK', payload: { hookId: 'h1', hookName: 'deploy:before' } });
            post({ type: 'READY', payload: {} });
          }
          if (msg.type === 'HOOK_CALL') {
            const { hookId, callId, initialPayload } = msg.payload;
            post({ type: 'EMIT_EVENT', payload: { event: 'plugin.redact-probe.saw_hook', data: initialPayload } });
            // Amend one field and echo the rest — placeholders included.
            post({ type: 'HOOK_RESPONSE', payload: { hookId, callId, result: { ...initialPayload, targetCommit: 'plugin-set' } } });
          }
          if (msg.type === 'EVENT' && msg.payload.event === 'probe.secret_event') {
            post({ type: 'EMIT_EVENT', payload: { event: 'plugin.redact-probe.saw_event', data: msg.payload.data } });
          }
          if (msg.type === 'SHUTDOWN') process.exit(0);
        });
      `),
    });
    const seen = (name: string) =>
      until<any>((resolve) => kernel.events.onCustom(name, (p) => resolve(p), { acceptPluginOrigin: true }));
    try {
      await kernel.registerPlugin(plugin);
      const repoUrl = 'https://deploy:ghp_SECRET@github.com/acme/web.git';
      const composeContent = 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: hunter2\n';
      const sawHook = seen('plugin.redact-probe.saw_hook');
      const result = await kernel.hooks.call('deploy:before', {
        service: { id: 7, name: 'web', image: 'nginx:1', repoUrl, composeContent } as never,
        targetCommit: 'abc',
      });
      const inside = await sawHook;
      expect(inside.service).toEqual({
        id: 7,
        name: 'web',
        image: 'nginx:1',
        repoUrl: 'https://[redacted]@github.com/acme/web.git',
        composeContent: '[redacted]',
      });
      expect(JSON.stringify(inside)).not.toContain('ghp_SECRET');
      expect(JSON.stringify(inside)).not.toContain('hunter2');
      // The plugin's amendment stands; the placeholders it echoed do not.
      expect(result.targetCommit).toBe('plugin-set');
      expect((result.service as unknown as { repoUrl: string }).repoUrl).toBe(repoUrl);
      expect((result.service as unknown as { composeContent: string }).composeContent).toBe(composeContent);

      const sawEvent = seen('plugin.redact-probe.saw_event');
      kernel.events.emitCustom('probe.secret_event', { name: 'node-1', token: 'enrol-SECRET', isSecret: true });
      expect(await sawEvent).toEqual({ name: 'node-1', token: '[redacted]', isSecret: true });
    } finally {
      await kernel.unregisterPlugin('redact-probe');
    }
  }, 20000);
});
