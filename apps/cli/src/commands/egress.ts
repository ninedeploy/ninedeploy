/**
 * `ninedeploy egress {list,set,clear}` — Sprint 5, Gap G-15.
 *
 * Operator-side wrapper around the active `IEgressIpDriver`. The
 * CLI is the canonical way to attach a stable outbound IP to a
 * project: hosting providers run `ninedeploy egress set <projectId>
 * <ip>` after the project is created, and the next deploy's
 * `service.deployed` event fires the matching iptables SNAT.
 */
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

export interface EgressRule {
  selector: { projectId: number; sourceCidr?: string };
  ip: string;
  createdAt: string;
}

export interface EgressDriverView {
  name: string;
  rules: EgressRule[];
}

// ── `ninedeploy egress list` ──────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function egressList(client: NineDeployClient): Promise<{ drivers: EgressDriverView[] }> {
  return await client.egress.list();
}

export async function egressListAction(client: NineDeployClient): Promise<void> {
  header('Egress IP rules');
  let result: { drivers: EgressDriverView[] };
  try {
    result = await egressList(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.drivers.length === 0) {
    info('No egress IP drivers are registered. Install one via Settings → Plugins.');
    return;
  }
  for (const d of result.drivers) {
    info(`Driver: ${d.name}`);
    if (d.rules.length === 0) {
      info('  (no rules)');
    } else {
      for (const r of d.rules) {
        info(`  project ${r.selector.projectId} → ${r.ip}  (since ${r.createdAt})`);
      }
    }
  }
}

// ── `ninedeploy egress set <projectId> <ip>` ──────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function egressSet(
  client: NineDeployClient,
  projectId: number,
  ip: string,
  driver?: string,
): Promise<{ ok: boolean; driver: string; rule: EgressRule; error?: string }> {
  return await client.egress.set({ projectId, ip, driver });
}

export async function egressSetAction(
  client: NineDeployClient,
  projectIdStr: string,
  ip: string,
  opts: { driver?: string } = {},
): Promise<void> {
  const projectId = Number(projectIdStr);
  if (!Number.isFinite(projectId)) {
    error('Usage: ninedeploy egress set <projectId> <ip> [--driver <name>]');
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof egressSet>>;
  try {
    result = await egressSet(client, projectId, ip, opts.driver);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  // r198: the route answers a refusal as 200 `{ ok: false, error }`; this
  // used to dereference the missing `rule` and crash with a TypeError.
  if (!result.ok) {
    error(result.error ?? 'Egress IP attach was refused');
    process.exitCode = 1;
    return;
  }
  success(`Egress IP ${result.rule.ip} attached to project ${projectId} via ${result.driver}`);
}

// ── `ninedeploy egress clear <projectId>` ────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function egressClear(
  client: NineDeployClient,
  projectId: number,
  driver?: string,
): Promise<{ ok: boolean; driver: string; error?: string }> {
  return driver ? await client.egress.clear(projectId, driver) : await client.egress.clear(projectId);
}

export async function egressClearAction(
  client: NineDeployClient,
  projectIdStr: string,
  opts: { driver?: string } = {},
): Promise<void> {
  const projectId = Number(projectIdStr);
  if (!Number.isFinite(projectId)) {
    error('Usage: ninedeploy egress clear <projectId> [--driver <name>]');
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof egressClear>>;
  try {
    result = await egressClear(client, projectId, opts.driver);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    error(result.error ?? 'Egress IP detach was refused');
    process.exitCode = 1;
    return;
  }
  success(`Egress IP cleared for project ${projectId} via ${result.driver}`);
}
