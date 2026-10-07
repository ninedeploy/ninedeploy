import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capture, run } from '../../lib/exec.js';
import type {
  IOrchestrator,
  StackSpec,
  StackStatus,
} from '../types.js';

/**
 * Local-orchestrator driver — Sprint 4, Gap G-10 (PR-A).
 *
 * Wraps the existing `IComputeDriver` (local Docker CLI) behind the
 * new `IOrchestrator` contract. PR-A is a non-breaking refactor: the
 * `IComputeDriver` continues to work for every existing call site,
 * and the new `IOrchestrator` is opt-in per service. PR-B (Sprint 4
 * PR #19) introduces the Swarm driver on top of the same contract.
 *
 * Behaviour:
 *   - `deployStack()` renders a single `docker-compose.yml` under
 *     `/var/lib/ninedeploy/stacks/<name>/` and runs
 *     `docker compose up -d` against it. The file is intentionally
 *     human-readable so an operator can debug a stuck deploy with
 *     `docker compose logs`.
 *   - `removeStack()` runs `docker compose down --remove-orphans`
 *     and removes the working directory. Idempotent on a missing
 *     stack — returns silently.
 *   - `listStacks()` reads `/var/lib/ninedeploy/stacks/<name>/docker-compose.yml`
 *     and counts the service entries.
 *   - `getStackStatus()` runs `docker compose ps --format json` and
 *     reports a per-service "running" / "stopped" / "unknown" line.
 *   - Replicas > 1 collapse to 1 — the local driver is single-node by
 *     design. A Swarm / k8s driver will honour `replicas` natively.
 *
 * Contract:
 *   - `deployStack()` is non-throwing on a network-level failure; it
 *     returns a `StackStatus` with `state: 'unknown'` for any
 *     service the compose call could not confirm. Operators see the
 *     failure in the audit log + the events bus, not as a 500.
 *   - `removeStack()` is best-effort: a missing stack is a no-op, a
 *     compose error is logged and the directory is still removed.
 */
const STACK_ROOT = '/var/lib/ninedeploy/stacks';

/**
 * Top-level service names from a compose file's `services:` block. Lines that
 * start with exactly two spaces and a `name:` (no trailing whitespace, no
 * children); the block runs until the next column-0 key (`volumes:` /
 * `networks:` / …) or end-of-file. A consecutive-`  name:\n` regex (the
 * original parser) matched only services with NO body — every compose file
 * this driver emits (`    image: …` under each service) reported a single
 * service. 4+-space indented lines are body of `environment` / `volumes` /
 * `labels` and are not counted.
 */
function composeServiceNames(text: string): string[] {
  const servicesIdx = text.indexOf('services:\n');
  if (servicesIdx === -1) return [];
  const after = text.slice(servicesIdx + 'services:\n'.length);
  const nextSection = after.search(/^[A-Za-z]/m);
  const block = nextSection === -1 ? after : after.slice(0, nextSection);
  return (block.match(/^ {2}[A-Za-z0-9_.-]+:$/gm) ?? []).map((line) => line.trim().slice(0, -1));
}

export class LocalOrchestrator implements IOrchestrator {
  readonly name = 'local';

  async deployStack(stack: StackSpec): Promise<StackStatus> {
    const stackDir = join(STACK_ROOT, stack.name);
    const composePath = join(stackDir, 'docker-compose.yml');
    const composeYaml = renderCompose(stack);

    try {
      runSyncMkdir(stackDir);
    } catch {
      // The /var/lib path may not exist on a dev box; the operator
      // path is `STACK_ROOT=/tmp/ninedeploy-stacks node …`. Falling
      // back here would surprise the operator, so we surface the
      // mkdir failure as a status of 'unknown' rather than papering
      // over it.
      return emptyStatus(stack.name, 'unknown');
    }
    writeFileSync(composePath, composeYaml, 'utf8');
    // F212: renderCompose points each stack secret/config at `file: <name>.txt`
    // in the stack dir; without these writes the data was dropped and compose
    // mounted a source that does not exist.
    for (const s of stack.secrets) writeFileSync(join(stackDir, `${s.name}.txt`), s.data, { mode: 0o600 });
    for (const c of stack.configs) writeFileSync(join(stackDir, `${c.name}.txt`), c.data, 'utf8');

    let upFailed = false;
    const serviceLines: StackStatus['services'] = [];
    try {
      await run('docker', ['compose', '-f', composePath, 'up', '-d', '--remove-orphans'], {
        heartbeatMs: 20_000,
        heartbeatLabel: `stack ${stack.name}`,
      }, () => {});
    } catch {
      upFailed = true;
    }
    for (const svc of stack.services) {
      let state: 'running' | 'stopped' | 'partial' | 'unknown' = 'unknown';
      try {
        const out = await capture('docker', [
          'compose',
          '-f',
          composePath,
          'ps',
          svc.name,
          '--format',
          '{{.State}}',
        ]);
        const normalized = (out ?? '').trim().toLowerCase();
        if (normalized === 'running') {
          state = 'running';
        } else if (normalized === 'exited' || normalized === 'stopped' || normalized === 'created') {
          state = 'stopped';
        } else {
          state = 'unknown';
        }
      } catch {
        state = 'unknown';
      }
      // F213: after a failed `up` a running container is the previous apply's,
      // not this one's — the compose call did not confirm it.
      if (upFailed && state === 'running') state = 'unknown';
      serviceLines.push({ name: svc.name, state, replicas: 1 });
    }

    return {
      name: stack.name,
      services: serviceLines,
      appliedAt: new Date().toISOString(),
    };
  }

  async removeStack(name: string): Promise<void> {
    const composePath = join(STACK_ROOT, name, 'docker-compose.yml');
    if (existsSync(composePath)) {
      try {
        await run('docker', ['compose', '-f', composePath, 'down', '--remove-orphans'], {
          heartbeatMs: 20_000,
          heartbeatLabel: `stack ${name} down`,
        }, () => {});
      } catch {
        // Best-effort — we still want to scrub the on-disk state so
        // a future `listStacks()` does not return a phantom.
      }
      try {
        const { rmSync } = await import('node:fs');
        rmSync(join(STACK_ROOT, name), { recursive: true, force: true });
      } catch {
        // Same reasoning.
      }
    }
  }

  async listStacks(): Promise<Array<{ name: string; serviceCount: number }>> {
    const { readdirSync, readFileSync } = await import('node:fs');
    let entries: string[] = [];
    try {
      entries = readdirSync(STACK_ROOT);
    } catch {
      return [];
    }
    const result: Array<{ name: string; serviceCount: number }> = [];
    for (const entry of entries) {
      const composePath = join(STACK_ROOT, entry, 'docker-compose.yml');
      if (!existsSync(composePath)) continue;
      let count = 0;
      try {
        count = composeServiceNames(readFileSync(composePath, 'utf8')).length;
      } catch {
        // ignore — the stack is half-written; report 0 services
      }
      result.push({ name: entry, serviceCount: count });
    }
    return result;
  }

  async getStackStatus(name: string): Promise<StackStatus | null> {
    const composePath = join(STACK_ROOT, name, 'docker-compose.yml');
    if (!existsSync(composePath)) return null;
    let text = '';
    try {
      text = (await import('node:fs')).readFileSync(composePath, 'utf8');
    } catch {
      return null;
    }
    // Same parser as listStacks: the old consecutive-`  name:\n` regex
    // matched only services with NO body, so every stack this driver itself
    // created (it always emits `    image: …`) reported exactly one service.
    const serviceNames = composeServiceNames(text);
    if (serviceNames.length === 0) return { name, services: [], appliedAt: new Date(0).toISOString() };
    const services: StackStatus['services'] = [];
    for (const svcName of serviceNames) {
      try {
        const out = await capture('docker', [
          'compose',
          '-f',
          composePath,
          'ps',
          svcName,
          '--format',
          '{{.State}}',
        ]);
        const state = normalizeState(out);
        services.push({ name: svcName, state, replicas: 1 });
      } catch {
        services.push({ name: svcName, state: 'unknown', replicas: 1 });
      }
    }
    return { name, services, appliedAt: new Date(0).toISOString() };
  }
}

function runSyncMkdir(dir: string): void {
  // Use the top-level `mkdirSync` import (not an inline
  // `require('node:fs')`) so vitest's `vi.mock('node:fs', …)` in
  // the test suite actually intercepts the call. A dynamic
  // `require` inside a function body is invisible to the module
  // mock in ESM — the previous shape silently bypassed the spy
  // and went straight to the real fs, which surfaced as
  // "ENOENT: /var/lib/ninedeploy/stacks/demo" on the CI runner
  // (no parent directory, no permission to create one).
  mkdirSync(dir, { recursive: true });
}

function normalizeState(out: string): 'running' | 'stopped' | 'partial' | 'unknown' {
  const s = (out ?? '').trim().toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'exited' || s === 'stopped' || s === 'created') return 'stopped';
  if (s.startsWith('up ')) return 'partial';
  return 'unknown';
}

function emptyStatus(name: string, _state: string): StackStatus {
  return { name, services: [], appliedAt: new Date(0).toISOString() };
}

function renderCompose(stack: StackSpec): string {
  const lines: string[] = [];
  lines.push('# Auto-generated by NineDeploy LocalOrchestrator (Sprint 4 G-10 PR-A).');
  lines.push('# Operator-edits are kept across `deployStack` re-runs because the');
  lines.push('# driver rewrites the whole file on every apply. Use a real Swarm');
  lines.push('# driver for hand-curated stacks.');
  lines.push('version: "3.9"');
  lines.push('');
  lines.push('networks:');
  for (const n of stack.networks) {
    lines.push(`  ${n.name}:`);
    lines.push(`    driver: ${n.driver}`);
    lines.push(`    attachable: ${n.attachable}`);
  }
  lines.push('');
  lines.push('services:');
  for (const svc of stack.services) {
    lines.push(`  ${svc.name}:`);
    lines.push(`    image: ${svc.image}`);
    if (svc.replicas > 1) {
      // The local driver collapses to 1; record the requested count
      // as a comment so a future Swarm driver honours it.
      lines.push(`    # requested replicas: ${svc.replicas} (local driver runs 1)`);
    }
    if (svc.port !== null) {
      lines.push(`    ports:`);
      lines.push(`      - "${svc.port}:${svc.port}"`);
    }
    if (Object.keys(svc.env).length > 0) {
      lines.push(`    environment:`);
      for (const [k, v] of Object.entries(svc.env)) {
        lines.push(`      ${k}: ${JSON.stringify(v)}`);
      }
    }
    if (svc.networks.length > 0) {
      lines.push(`    networks:`);
      for (const n of svc.networks) lines.push(`      - ${n}`);
    }
    if (svc.secrets.length > 0) {
      lines.push(`    secrets:`);
      for (const s of svc.secrets) lines.push(`      - ${s}`);
    }
    if (svc.configs.length > 0) {
      lines.push(`    configs:`);
      for (const c of svc.configs) lines.push(`      - ${c}`);
    }
    // F214: curl needs a URL — a bare path exits 3 without sending a request,
    // so the check could never pass. With no port there is no URL to probe.
    const healthUrl = svc.healthPath
      ? /^https?:\/\//.test(svc.healthPath)
        ? svc.healthPath
        : svc.port !== null
          ? `http://localhost:${svc.port}${svc.healthPath.startsWith('/') ? '' : '/'}${svc.healthPath}`
          : null
      : null;
    if (healthUrl) {
      lines.push(`    healthcheck:`);
      lines.push(`      test: ["CMD", "curl", "-f", "${healthUrl}"]`);
      lines.push(`      interval: 30s`);
      lines.push(`      timeout: 5s`);
      lines.push(`      retries: 3`);
    }
    if (Object.keys(svc.labels).length > 0) {
      lines.push(`    labels:`);
      for (const [k, v] of Object.entries(svc.labels)) {
        lines.push(`      ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  if (stack.secrets.length > 0) {
    lines.push('');
    lines.push('secrets:');
    for (const s of stack.secrets) {
      lines.push(`  ${s.name}:`);
      lines.push(`    file: ${s.name}.txt`);
    }
  }
  if (stack.configs.length > 0) {
    lines.push('');
    lines.push('configs:');
    for (const c of stack.configs) {
      lines.push(`  ${c.name}:`);
      lines.push(`    file: ${c.name}.txt`);
    }
  }
  if (stack.volumes.length > 0) {
    lines.push('');
    lines.push('volumes:');
    for (const v of stack.volumes) {
      lines.push(`  ${v.name}:`);
    }
  }
  return `${lines.join('\n')}\n`;
}
