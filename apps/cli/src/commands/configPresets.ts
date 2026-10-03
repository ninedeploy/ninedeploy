/**
 * `ninedeploy config-preset {list,get,register,apply,remove}` — Sprint 3, Gap G-23, PR-A.
 *
 * A preset is a named bundle of `configCenter` writes an operator can
 * register once and apply to a fresh instance with one call. The CLI
 * is the operator-side counterpart of the kernel plugin (which owns
 * the schema) and the HTTP surface (which is the actual apply engine).
 *
 * Split:
 *   - `list` and `get` are read-only — they hit `GET /v1/config-presets`
 *     and `GET /v1/config-presets/:id` and pretty-print the result.
 *   - `register <id>` reads a JSON values object from `--file` (or
 *     stdin) and POSTs it. A future PR will let the panel also
 *     register via the UI; today the CLI is the only registration
 *     path because the schema is intentionally a thin wrapper.
 *   - `apply <id>` is the one-shot "I just want it to work" command.
 *     The body is empty unless the operator wants to override a
 *     single value for this call only (handy for smoke tests).
 *   - `remove <id>` unregisters. It does NOT undo the apply — the
 *     values are still in configCenter. Re-running the preset
 *     later would write the same values back; that is the entire
 *     point of a registry.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

export interface ConfigPresetRegisterOptions {
  /** Path to a JSON file holding the preset's values. */
  file?: string;
  /** Inline description (free text, max 500 chars). */
  description?: string;
}

// ── `ninedeploy config-preset list` ────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function configPresetList(client: NineDeployClient): Promise<{ presets: string[] }> {
  return await client.configPresets.list();
}

export async function configPresetListAction(client: NineDeployClient): Promise<void> {
  header('Config presets');
  let result: { presets: string[] };
  try {
    result = await configPresetList(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.presets.length === 0) {
    info('No presets are registered. Run `ninedeploy config-preset register <id> --file <path>`.');
    return;
  }
  for (const name of result.presets) info(`• ${name}`);
}

// ── `ninedeploy config-preset get <id>` ────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function configPresetGet(
  client: NineDeployClient,
  id: string,
): Promise<{
  id: string;
  description: string | null;
  values: Record<string, unknown>;
  createdAt: string;
}> {
  return await client.configPresets.get(id);
}

export async function configPresetGetAction(client: NineDeployClient, id: string): Promise<void> {
  header(`Config preset: ${id}`);
  let result: Awaited<ReturnType<typeof configPresetGet>>;
  try {
    result = await configPresetGet(client, id);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.description) info(result.description);
  info(`${Object.keys(result.values).length} key(s) in this preset:`);
  for (const [key, value] of Object.entries(result.values)) {
    info(`  ${key} = ${JSON.stringify(value)}`);
  }
}

// ── `ninedeploy config-preset register <id>` ──────────────────────────────

/** Pure entry point — reads the file, parses JSON, posts to the server. */
export async function configPresetRegister(
  client: NineDeployClient,
  id: string,
  opts: ConfigPresetRegisterOptions = {},
): Promise<{ ok: boolean; id: string; keyCount: number }> {
  if (!opts.file) {
    throw new Error('--file <path> is required (a JSON object of key → value pairs)');
  }
  const filePath = resolve(opts.file);
  const raw = readFileSync(filePath, 'utf8');
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${opts.file} must contain a JSON object (key → value)`);
  }
  return await client.configPresets.register({
    id,
    description: opts.description,
    values: values as Record<string, unknown>,
  });
}

export async function configPresetRegisterAction(
  client: NineDeployClient,
  id: string,
  opts: ConfigPresetRegisterOptions = {},
): Promise<void> {
  header('Config preset register');
  if (!id) {
    error('Usage: ninedeploy config-preset register <id> --file <path> [--description <text>]');
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof configPresetRegister>>;
  try {
    result = await configPresetRegister(client, id, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  success(`Registered preset "${result.id}" with ${result.keyCount} key(s)`);
}

// ── `ninedeploy config-preset apply <id>` ──────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function configPresetApply(
  client: NineDeployClient,
  id: string,
  opts: { override?: Record<string, unknown> } = {},
): Promise<{
  ok: boolean;
  id: string;
  keyCount: number;
  failureCount?: number;
  failures?: Array<{ key: string; status: 'failed'; reason?: string }>;
}> {
  return await client.configPresets.apply(id, opts);
}

export async function configPresetApplyAction(
  client: NineDeployClient,
  id: string,
  opts: { override?: Record<string, unknown> } = {},
): Promise<void> {
  header('Config preset apply');
  if (!id) {
    error('Usage: ninedeploy config-preset apply <id> [--override <json>]');
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof configPresetApply>>;
  try {
    result = await configPresetApply(client, id, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    error(
      `Preset "${result.id}" applied with ${result.failureCount ?? 0} failure(s) of ${result.keyCount} key(s)`,
    );
    process.exitCode = 1;
    return;
  }
  success(`Applied preset "${result.id}" — ${result.keyCount} key(s) written`);
}

// ── `ninedeploy config-preset remove <id>` ─────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function configPresetRemove(
  client: NineDeployClient,
  id: string,
): Promise<{ ok: boolean; id: string }> {
  return await client.configPresets.remove(id);
}

export async function configPresetRemoveAction(client: NineDeployClient, id: string): Promise<void> {
  header('Config preset remove');
  if (!id) {
    error('Usage: ninedeploy config-preset remove <id>');
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof configPresetRemove>>;
  try {
    result = await configPresetRemove(client, id);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  success(`Removed preset "${result.id}" (live configCenter values are unchanged)`);
}
