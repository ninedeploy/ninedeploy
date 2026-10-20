import type { AiFixProposal } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, kv, spinner, success } from '../lib/format.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * 0.16.16: `ninedeploy deploys diagnose <service> <deployId> [--apply] [--json]`.
 * The configured AI provider diagnoses a failed deployment's build log. When
 * it proposes a settings change, `--apply` applies it with the ordinary
 * service update (all its rules apply) and starts a deploy; proposed file
 * edits are printed as find/replace for you to make in the repository.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** Model text, line by line, with control sequences removed (plain() also drops newlines). */
const printLines = (text: string, indent = '  ') => {
  for (const line of text.split('\n')) console.log(`${indent}${plain(line)}`);
};

/** The proposed settings as `name: value` lines. */
export function settingLines(settings: NonNullable<AiFixProposal['settings']>): string[] {
  const lines: string[] = [];
  if (settings.port !== undefined) lines.push(`port: ${settings.port}`);
  if (settings.healthPath !== undefined) lines.push(`healthPath: ${settings.healthPath}`);
  for (const [k, v] of Object.entries(settings.build ?? {})) lines.push(`build.${k}: ${v}`);
  return lines;
}

export async function deploysDiagnose(
  client: NineDeployClient,
  ref: string,
  depRaw: string,
  opts: { apply?: boolean; json?: boolean } = {},
): Promise<void> {
  const depId = Number(depRaw);
  if (!Number.isInteger(depId) || depId <= 0) {
    error('<deployId> must be a positive integer');
    return;
  }
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const res = opts.json ? await client.ai.diagnose(id, depId) : await spinner('Diagnosing the build log', () => client.ai.diagnose(id, depId));
    if (opts.json && !opts.apply) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (!opts.json) {
      header(`AI diagnosis of deployment #${depId}`);
      info(`by ${plain(res.model)}`);
      console.log();
      printLines(res.diagnosis);
    }
    const proposal = res.proposal ?? null;
    if (!opts.json && proposal?.settings) {
      console.log();
      console.log(`  ${c.bold('Proposed settings change')}`);
      for (const line of settingLines(proposal.settings)) printLines(line, '    ');
    }
    if (!opts.json && proposal?.files) {
      for (const f of proposal.files) {
        console.log();
        kv('File', plain(f.path));
        if (f.why) printLines(f.why, '    ');
        printLines(f.find, '    - ');
        printLines(f.replace, '    + ');
      }
    }
    if (!opts.apply) {
      if (!opts.json && proposal?.settings) {
        console.log();
        info(`Apply it with: ninedeploy deploys diagnose ${plain(ref)} ${depId} --apply`);
      }
      return;
    }
    if (!proposal?.settings) {
      error('The diagnosis proposes no settings change to apply.');
      return;
    }
    const settings = proposal.settings;
    await spinner('Applying the change', () => client.services.update(id, settings as Parameters<typeof client.services.update>[1]));
    const dep = await spinner('Starting a deploy', () => client.deploys.trigger(id));
    if (opts.json) {
      console.log(JSON.stringify({ ...res, applied: true, deploymentId: dep.deploymentId }, null, 2));
      return;
    }
    success(`Applied. Deployment #${dep.deploymentId} is building; follow it with: ninedeploy deploys watch ${id} ${dep.deploymentId}`);
  } catch (err) {
    error(message(err));
  }
}
