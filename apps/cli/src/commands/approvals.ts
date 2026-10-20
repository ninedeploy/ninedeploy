import type { ApprovalItem, Environment } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, fmtTime, header, info, spinner, success, table } from '../lib/format.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * 0.16.13 protected lanes and deploy approvals:
 *
 *   ninedeploy lanes list [--json]
 *   ninedeploy lanes protect <lane> on|off
 *   ninedeploy lanes require-approval <lane> on|off
 *   ninedeploy approvals list [--json]
 *   ninedeploy approvals approve <service> [--deployment <id>]
 *   ninedeploy approvals reject <service> [--deployment <id>]
 *
 * `<lane>` is an id, a slug or a name; `<service>` an id, a slug or a name.
 * Without `--deployment`, approve and reject act on the service's oldest
 * waiting deploy. Withdrawing your own waiting deploy is
 * `ninedeploy deploys cancel <serviceId> <deployId>`.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** Skip the spinner for `--json` so stdout stays parseable. */
const load = <T>(json: boolean | undefined, msg: string, fn: () => Promise<T>): Promise<T> => (json ? fn() : spinner(msg, fn));

/** `on` / `off` as a boolean; null after printing why not. */
export function onOff(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  error(`Expected on or off (got "${plain(raw)}")`);
  return null;
}

/** A lane by id, slug or name; null after printing why not. Several lanes may share a name across workspaces. */
export async function resolveLane(client: NineDeployClient, ref: string): Promise<Environment | null> {
  const lanes = await client.environments.list();
  const byId = /^\d+$/.test(ref) ? lanes.filter((l) => l.id === Number(ref)) : [];
  const matches = byId.length > 0 ? byId : lanes.filter((l) => l.slug === ref || l.name === ref);
  if (matches.length === 0) {
    error(`No lane named "${plain(ref)}".`);
    return null;
  }
  if (matches.length > 1) {
    error(`Several lanes are named "${plain(ref)}" (ids ${matches.map((l) => l.id).join(', ')}). Use the id.`);
    return null;
  }
  return matches[0]!;
}

const flag = (v: boolean | undefined): string => (v ? c.yellow('on') : c.gray('off'));

/** `ninedeploy lanes list [--json]` */
export async function lanesList(client: NineDeployClient, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const lanes = await load(opts.json, 'Loading lanes', () => client.environments.list());
    if (opts.json) {
      console.log(JSON.stringify(lanes, null, 2));
      return;
    }
    header('Deployment lanes');
    table(
      lanes.map((l) => ({
        id: l.id,
        name: plain(l.name),
        workspace: l.workspaceId,
        services: l.serviceCount,
        protected: flag(l.protected),
        approval: flag(l.requireApproval),
      })),
      ['id', 'name', 'workspace', 'services', 'protected', 'approval'],
    );
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy lanes protect <lane> on|off` and `ninedeploy lanes require-approval <lane> on|off` */
export async function lanesSwitch(
  client: NineDeployClient,
  which: 'protected' | 'requireApproval',
  ref: string,
  value: string,
): Promise<void> {
  const on = onOff(value);
  if (on === null) return;
  try {
    const lane = await resolveLane(client, ref);
    if (!lane) return;
    const updated = await spinner('Saving the lane', () => client.environments.update(lane.id, { [which]: on }));
    const name = plain(updated.name);
    if (which === 'protected') {
      success(
        on
          ? `"${name}" is protected: its variable values, logs and shells are for workspace admins only.`
          : `"${name}" is no longer protected.`,
      );
    } else {
      success(
        on
          ? `Deploys into "${name}" now wait for a workspace admin's approval.`
          : `Deploys into "${name}" no longer wait for approval. Deploys already waiting still need a decision.`,
      );
    }
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy approvals list [--json]` */
export async function approvalsList(client: NineDeployClient, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const res = await load(opts.json, 'Loading deploys waiting for approval', () => client.deploys.approvals());
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    header('Waiting for approval');
    if (res.items.length === 0) {
      info('No deploy is waiting for approval.');
      return;
    }
    table(
      res.items.map((d: ApprovalItem) => ({
        id: d.id,
        service: plain(d.serviceName),
        commit: d.commitSha ? d.commitSha.slice(0, 7) : d.imageDigest ? d.imageDigest.slice(7, 19) : c.dim('—'),
        message: plain((d.message ?? '').split('\n')[0]!.slice(0, 50)),
        trigger: d.trigger,
        waiting: fmtTime(d.createdAt),
        you: d.mayReview ? c.green('may approve') : c.gray('admins only'),
      })),
      ['id', 'service', 'commit', 'message', 'trigger', 'waiting', 'you'],
    );
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy approvals approve|reject <service> [--deployment <id>]` */
export async function approvalsDecide(
  client: NineDeployClient,
  decision: 'approve' | 'reject',
  ref: string,
  opts: { deployment?: string } = {},
): Promise<void> {
  let depId: number | undefined;
  if (opts.deployment !== undefined) {
    const n = Number(opts.deployment);
    if (!Number.isInteger(n) || n <= 0) {
      error('--deployment must be a positive integer');
      return;
    }
    depId = n;
  }
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    if (depId === undefined) {
      const waiting = (await client.deploys.approvals()).items.find((d) => d.serviceId === id);
      if (!waiting) {
        error('No deploy of this service is waiting for approval.');
        return;
      }
      depId = waiting.id;
    }
    const target = depId;
    if (decision === 'approve') {
      await spinner('Approving', () => client.deploys.approve(id, target));
      success(`Deployment #${target} approved: it builds next.`);
    } else {
      await spinner('Rejecting', () => client.deploys.reject(id, target));
      success(`Deployment #${target} rejected: it will not run.`);
    }
  } catch (err) {
    error(message(err));
  }
}
