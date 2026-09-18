import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { run, capture } from '../../lib/exec.js';
import type { EgressIpRule, EgressIpSelector, IEgressIpDriver } from '../types.js';

/**
 * iptables-based egress IP driver — Sprint 5, Gap G-15 (PR #22).
 *
 * The reference implementation: an `iptables -t nat -A POSTROUTING`
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
 *   - `detach()` is best-effort: a missing iptables rules surfaces
 *     as a 500 with a descriptive message, but the in-process
 *     state and the on-disk state are both updated so a future
 *     `list()` does not return a phantom.
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

const snatArgs = (op: '-A' | '-D' | '-C', cidr: string, ip: string, projectId: number): string[] => [
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

  async attach(selector: EgressIpSelector, ip: string): Promise<EgressIpRule> {
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
      await this.detach(selector);
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
          snatArgs('-A', cidr, ip, selector.projectId),
          { heartbeatMs: 10_000, heartbeatLabel: `egress attach project ${selector.projectId}` },
          () => {},
        );
        applied.push(cidr);
      }
    } catch (err) {
      for (const cidr of applied) await this.deleteRule(cidr, ip, selector.projectId);
      throw new Error(
        `iptables -t nat -A POSTROUTING failed for project ${selector.projectId}: ${err instanceof Error ? err.message : String(err)}`,
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

  async detach(selector: EgressIpSelector): Promise<void> {
    const existing = this.rules.get(selector.projectId);
    if (!existing) return;
    // Remove exactly what attach added. Rules persisted before r240 carry no
    // list: fall back to the selector's CIDR, then to a fresh lookup.
    let cidrs = existing.sourceCidrs ?? (existing.selector.sourceCidr ? [existing.selector.sourceCidr] : []);
    if (cidrs.length === 0) cidrs = await this.resolveCidrs(selector.projectId).catch(() => []);
    // Best-effort: the rule may already be gone, or iptables may be missing.
    // The state is scrubbed either way so `list()` never returns a phantom.
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
          await run('iptables', snatArgs('-A', cidr, rule.ip, projectId), {}, () => {});
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
    } catch {
      /* already gone, or iptables missing */
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
