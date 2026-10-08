import { readFileSync } from 'node:fs';
import type { TraefikCustomConfigIssue } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, header, info, kv, spinner, success } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * 0.14: the operator's custom Traefik dynamic config (`custom.yml`) —
 * `ninedeploy proxy config get|validate|set|clear`. Operator only on the
 * server. Findings, errors and the stored YAML are printed through the F1011
 * sanitiser (line by line, so the YAML keeps its line breaks).
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** Multi-line text with every control sequence removed from each line. */
const lines = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => plain(l))
    .join('\n');

function printIssues(label: string, issues: TraefikCustomConfigIssue[], color: (s: string) => string): void {
  if (issues.length === 0) return;
  console.log(`  ${color(label)}`);
  for (const i of issues) console.log(`    ${color('•')} ${i.path ? `${plain(i.path)}: ` : ''}${plain(i.message)}`);
}

function readConfigFile(file: string | undefined, usage: string): string | null {
  if (!file) {
    error(usage);
    return null;
  }
  try {
    const content = readFileSync(file, 'utf8');
    if (!content.trim()) {
      error(`${file} is empty`);
      return null;
    }
    return content;
  } catch (err) {
    error(`Cannot read ${file}: ${message(err)}`);
    return null;
  }
}

/** `ninedeploy proxy config get` */
export async function proxyConfigGet(client: NineDeployClient): Promise<void> {
  try {
    const cfg = await spinner('Reading the custom config', () => client.traefik.customConfig.get());
    header('Custom Traefik config');
    const color = cfg.status === 'applied' ? c.green : cfg.status === 'rejected' ? c.red : c.gray;
    kv('Status', color(cfg.status));
    kv('SHA-256', cfg.sha256);
    kv('Updated', cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleString() : null);
    kv('Updated by', cfg.updatedBy === null ? null : `user #${cfg.updatedBy}`);
    if (cfg.lastError) kv('Last error', c.red(plain(cfg.lastError)));
    if (cfg.content === null) {
      info('No custom config saved. Write one and run `ninedeploy proxy config set --file <path>`.');
      return;
    }
    console.log();
    console.log(lines(cfg.content));
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy proxy config validate --file <path>` — no state change. */
export async function proxyConfigValidate(client: NineDeployClient, opts: { file?: string } = {}): Promise<void> {
  const content = readConfigFile(opts.file, 'Usage: ninedeploy proxy config validate --file <path>');
  if (content === null) return;
  try {
    const res = await spinner('Validating', () => client.traefik.customConfig.validate(content));
    printIssues('Errors', res.errors, c.red);
    printIssues('Warnings', res.warnings, c.yellow);
    if (res.ok) success('The config is valid');
    else error(`The config has ${res.errors.length} error(s)`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy proxy config set --file <path>` — validated and applied atomically by the server. */
export async function proxyConfigSet(client: NineDeployClient, opts: { file?: string } = {}): Promise<void> {
  const content = readConfigFile(opts.file, 'Usage: ninedeploy proxy config set --file <path>');
  if (content === null) return;
  try {
    const res = await spinner('Validating and applying', () => client.traefik.customConfig.set(content));
    success(`Custom config applied (sha256 ${res.sha256.slice(0, 12)})`);
    printIssues('Warnings', res.warnings, c.yellow);
  } catch (err) {
    const details = (err as { details?: { errors?: TraefikCustomConfigIssue[]; warnings?: TraefikCustomConfigIssue[] } }).details;
    if (details?.errors) printIssues('Errors', details.errors, c.red);
    if (details?.warnings) printIssues('Warnings', details.warnings, c.yellow);
    error(message(err));
  }
}

/** `ninedeploy proxy config clear [--yes]` — removes every custom router, service and middleware. */
export async function proxyConfigClear(client: NineDeployClient, opts: { yes?: boolean } = {}): Promise<void> {
  if (!opts.yes) {
    const confirm = await prompt('Type "clear" to remove the custom Traefik config', '');
    if (confirm.trim() !== 'clear') {
      info('Aborted.');
      return;
    }
  }
  try {
    const res = await spinner('Clearing the custom config', () => client.traefik.customConfig.clear());
    if (res.cleared) success('Custom config removed');
    else info('There was no custom config to remove.');
  } catch (err) {
    error(message(err));
  }
}
