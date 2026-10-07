import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { run, capture } from '../../lib/exec.js';
import type { EgressIpRule, EgressIpSelector, IEgressIpDriver } from '../types.js';

/**
 * iptables-based egress IP driver — Sprint 5, Gap G-15 (PR #22).
 *
 * The reference implementation: an `iptables -t nat -I POSTROUTING`
 * SNAT rule scoped to a project's Docker network. The driver
 * never throws on a missing `iptables` binary or a missing kernel
 * module — the rules file on disk is the source of truth across a
 * kernel restart, so a kernel without iptables still sees the
 * project listed in `list()` and reports the failure on the next
 * `attach()` attempt.
 *
 * State lives in two places:
 *   - in-process `Map<projectId, EgressIpRule>` (lost on restart),
 *   - on disk under `/var/lib/ninedeploy/egress/<projectId>.rules`
 *     (a JSON file the kernel rehydrates from on boot).
 *
 * Contract:
 *   - `attach()` is idempotent on (projectId, ip) — re-apply is a
 *     no-op. A different ip for the same projectId REPLACES the
 *     rule (the old SNAT is removed first).
 *   - `detach()` is best-effort: a rule that is already gone (or a
 *     host without iptables) still scrubs the in-process and on-disk
 *     state so a future `list()` does not return a phantom. A delete
 *     that fails while the rule is still in the kernel throws and keeps
 *     the state, so the live rule stays detachable (F230).
 *   - Calls for the same project are serialized (F229).
 *   - `list()` returns every rule the driver has, sorted by
 *     projectId for stable rendering in the panel.
 */
const RULES_ROOT = '/var/lib/ninedeploy/egress';

export interface IptablesEgressOptions {
  /** Override the on-disk root, e.g. for tests. */
  rootDir?: string;
  /**
   * r240: the source subnets a project's traffic leaves from. The driver used
   * to inspect `ninedeploy_proj_<id>`, a network nothing creates (every
   * service runs on its own `nd-svc-<slug>` bridge), so every attach without
   * an explicit CIDR failed. The kernel plugin supplies a resolver over the
   * project's services.
   */
  resolveCidrs?: (projectId: number) => Promise<string[]>;
}

// F228: rules are INSERTED (`-I`, position 1), never appended. Docker inserts
// `-s <subnet> ! -o <bridge> -j MASQUERADE` into nat/POSTROUTING when it creates
// the bridge, and the first terminating match wins, so an appended SNAT rule
// for the same subnet is never reached.
const snatArgs = (op: '-I' | '-D' | '-C', cidr: string, ip: string, projectId: number): string[] => [
  '-t', 'nat', op, 'POSTROUTING',
  '-s', cidr,
  '!', '-d', cidr,
  '-j', 'SNAT',
  '--to-source', ip,
  '-m', 'comment', '--comment', `ninedeploy-egress-${projectId}`,
];

export class IptablesEgressDriver implements IEgressIpDriver {
  readonly name = 'iptables';

  private readonly rootDir: string;
  private readonly rules = new Map<number, EgressIpRule>();
  private readonly resolveCidrs: (projectId: number) => Promise<string[]>;
  /** F229: per-project tail of the attach/detach queue. */
  private readonly queues = new Map<number, Promise<void>>();

  constructor(opts: IptablesEgressOptions = {}) {
    this.rootDir = opts.rootDir ?? RULES_ROOT;
    this.resolveCidrs =
      opts.resolveCidrs ??
      (async (id) => {
        const cidr = await lookupProjectCidr(id);
        return cidr ? [cidr] : [];
      });
    // Rehydrate from disk on boot so a kernel restart sees the
    // current state. Failures here are non-fatal: a future
    // `attach()` will overwrite the on-disk state.
    this.rehydrate();
  }

  /**
   * F229: attach/detach for one project run one at a time. Both read the
   * in-process map before an awaited iptables call and write it after, so two
   * overlapping calls each added a kernel rule while the map kept one; the
   * extra copy outlived detach() (which removes one match) untracked.
   */
  private serialize<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(projectId, tail);
    void tail.then(() => {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    });
    return next;
  }

  attach(selector: EgressIpSelector, ip: string): Promise<EgressIpRule> {
    return this.serialize(selector.projectId, () => this.attachUnlocked(selector, ip));
  }

  detach(selector: EgressIpSelector): Promise<void> {
    return this.serialize(selector.projectId, () => this.detachUnlocked(selector));
  }

  private async attachUnlocked(selector: EgressIpSelector, ip: string): Promise<EgressIpRule> {
    // Validate the IP via a regex; we do not want a typo to
    // silently become "0.0.0.0/0" in iptables.
    if (!isValidIPv4(ip)) {
      throw new Error(`Egress IP "${ip}" is not a valid IPv4 address`);
    }
    const cidrs = selector.sourceCidr
      ? [selector.sourceCidr]
      : [...new Set(await this.resolveCidrs(selector.projectId))].sort();
    if (cidrs.length === 0) {
      throw new Error(`Could not determine source CIDR for project ${selector.projectId}; specify one explicitly`);
    }

    // Same IP over the same networks is a no-op. Anything else (a new IP, or
    // a project that gained a service bridge) replaces the old rules.
    const existing = this.rules.get(selector.projectId);
    if (existing) {
      if (existing.ip === ip && sameList(existing.sourceCidrs ?? [], cidrs)) return existing;
      await this.detachUnlocked(selector);
    }

    // One SNAT rule per source network. The comment is what makes the rule
    // discoverable for `detach()`. A rejected rule (host namespace,
    // CAP_NET_ADMIN missing) rolls back the ones already added and throws;
    // the in-process + on-disk state are not updated so a later call retries.
    const applied: string[] = [];
    try {
      for (const cidr of cidrs) {
        await run(
          'iptables',
          snatArgs('-I', cidr, ip, selector.projectId),
          { heartbeatMs: 10_000, heartbeatLabel: `egress attach project ${selector.projectId}` },
          () => {},
        );
        applied.push(cidr);
      }
    } catch (err) {
      for (const cidr of applied) await this.deleteRule(cidr, ip, selector.projectId).catch(() => undefined);
      throw new Error(
        `iptables -t nat -I POSTROUTING failed for project ${selector.projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const rule: EgressIpRule = {
      selector,
      ip,
      createdAt: new Date().toISOString(),
      sourceCidrs: cidrs,
    };
    this.rules.set(selector.projectId, rule);
    this.persist(selector.projectId, rule);
    return rule;
  }

  private async detachUnlocked(selector: EgressIpSelector): Promise<void> {
    const existing = this.rules.get(selector.projectId);
    if (!existing) return;
    // Remove exactly what attach added. Rules persisted before r240 carry no
    // list: fall back to the selector's CIDR, then to a fresh lookup.
    let cidrs = existing.sourceCidrs ?? (existing.selector.sourceCidr ? [existing.selector.sourceCidr] : []);
    if (cidrs.length === 0) cidrs = await this.resolveCidrs(selector.projectId).catch(() => []);
    // Best-effort: the rule may already be gone, or iptables may be missing,
    // and the state is then scrubbed so `list()` never returns a phantom. A
    // rule still present after a failed delete throws (F230) and keeps it.
    for (const cidr of cidrs) await this.deleteRule(cidr, existing.ip, selector.projectId);
    this.rules.delete(selector.projectId);
    this.persistDelete(selector.projectId);
  }

  /**
   * r240: iptables rules do not survive a host reboot, and the driver only
   * reloaded its JSON, so after a restart `list()` showed rules that were no
   * longer in the kernel. Re-add every persisted rule that is missing.
   */
  async reapply(): Promise<{ restored: number; failed: number }> {
    let restored = 0;
    let failed = 0;
    for (const rule of this.rules.values()) {
      const projectId = rule.selector.projectId;
      const cidrs = rule.sourceCidrs ?? (rule.selector.sourceCidr ? [rule.selector.sourceCidr] : []);
      for (const cidr of cidrs) {
        try {
          await run('iptables', snatArgs('-C', cidr, rule.ip, projectId), {}, () => {});
          continue; // already present
        } catch {
          /* missing: add it below */
        }
        try {
          await run('iptables', snatArgs('-I', cidr, rule.ip, projectId), {}, () => {});
          restored++;
        } catch {
          failed++;
        }
      }
    }
    return { restored, failed };
  }

  private async deleteRule(cidr: string, ip: string, projectId: number): Promise<void> {
    try {
      await run(
        'iptables',
        snatArgs('-D', cidr, ip, projectId),
        { heartbeatMs: 10_000, heartbeatLabel: `egress detach project ${projectId}` },
        () => {},
      );
    } catch (err) {
      // F230: run() only reports the exit code, so "no such rule" and "delete
      // failed" (e.g. xtables lock held, exit 4) look alike. Swallow only when
      // the rule is verifiably absent (or iptables is missing: -C fails too);
      // otherwise the caller would forget a rule that is still live.
      const stillPresent = await run('iptables', snatArgs('-C', cidr, ip, projectId), {}, () => {}).then(
        () => true,
        () => false,
      );
      if (stillPresent) {
        throw new Error(
          `iptables -t nat -D POSTROUTING failed for project ${projectId} (${cidr}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async list(): Promise<EgressIpRule[]> {
    return Array.from(this.rules.values()).sort((a, b) => a.selector.projectId - b.selector.projectId);
  }

  // --- private helpers ---------------------------------------------------

  private rehydrate(): void {
    try {
      const entries = readdirSync(this.rootDir) as string[];
      for (const entry of entries) {
        if (!entry.endsWith('.rules')) continue;
        const projectId = Number(entry.replace(/\.rules$/, ''));
        if (!Number.isFinite(projectId)) continue;
        try {
          const text = readFileSync(`${this.rootDir}/${entry}`, 'utf8');
          const parsed = JSON.parse(text) as EgressIpRule;
          this.rules.set(projectId, parsed);
        } catch {
          // Half-written file; skip.
        }
      }
    } catch {
      // Root dir absent on a fresh install — no rules to load.
    }
  }

  private persist(projectId: number, rule: EgressIpRule): void {
    try {
      mkdirSync(this.rootDir, { recursive: true });
      writeFileSync(
        `${this.rootDir}/${projectId}.rules`,
        JSON.stringify(rule, null, 2),
        'utf8',
      );
    } catch {
      // Best-effort — the in-process state is still authoritative
      // for the rest of this kernel's lifetime.
    }
  }

  private persistDelete(projectId: number): void {
    try {
      const path = `${this.rootDir}/${projectId}.rules`;
      if (existsSync(path)) rmSync(path);
    } catch {
      // Best-effort
    }
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isValidIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

async function lookupProjectCidr(projectId: number): Promise<string | null> {
  // Best-effort: ask docker for the project's network CIDR. If the
  // project does not exist yet (or docker is unreachable), the
  // caller will need to specify the CIDR explicitly.
  try {
    const out = await capture('docker', [
      'network', 'inspect',
      `ninedeploy_proj_${projectId}`,
      '--format', '{{(index .IPAM.Config 0).Subnet}}',
    ]);
    const cidr = (out ?? '').trim();
    return cidr.length > 0 ? cidr : null;
  } catch {
    return null;
  }
}
