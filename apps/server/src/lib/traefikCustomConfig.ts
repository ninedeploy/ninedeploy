import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import { CORE_SCHEMA, load } from 'js-yaml';
import { settings, type DB } from '@ninedeploy/db';
import {
  TRAEFIK_CUSTOM_CONFIG_MAX_BYTES,
  type TraefikCustomConfig,
  type TraefikCustomConfigIssue,
  type TraefikCustomConfigState,
  type TraefikCustomConfigValidation,
} from '@ninedeploy/schemas';
import { config } from '../config.js';
import {
  certificatesConfigPath,
  customConfigPath,
  escapeTemplateDelims,
  generatedConfigPath,
  renderStaticConfig,
  TRAEFIK_CONTAINER,
  TRAEFIK_IMAGE,
  traefikDynamicDir,
} from '../engine/proxy.js';
import { decrypt, encrypt } from './crypto.js';
import { capture, run, sleep } from './exec.js';
import { hostPathFor } from './hostPath.js';
import { getSettingJson, setSettingJson, setSettingString } from './settings.js';

/**
 * The operator's custom Traefik dynamic config (0.14, DESIGN §2.3).
 *
 * In directory mode ONE file Traefik cannot decode freezes every dynamic
 * update — the generated routes included — so a candidate passes three
 * gates before it is kept: a pure validator (this file's rules 1–8), a
 * preflight in a throwaway Traefik with no network, and a post-write scan
 * of the live Traefik's log that reverts to the last good version.
 *
 * The database is the source of truth (encrypted settings keys); boot writes
 * `dynamic/custom.yml` back from the last good version (M12).
 */

export const CUSTOM_CONFIG_KEY = 'traefik_custom_config_encrypted';
export const CUSTOM_CONFIG_LAST_GOOD_KEY = 'traefik_custom_config_last_good_encrypted';
/** Plain JSON `{status, lastError}` — not secret, so not encrypted. */
export const CUSTOM_CONFIG_STATUS_KEY = 'traefik_custom_config_status';

/** Rule 5: every name the custom file defines. Generated names can never match. */
export const CUSTOM_NAME_RE = /^custom[-_][A-Za-z0-9_-]{1,100}$/;
/** The panel router's priority (engine/proxy.ts PANEL_ROUTER_PRIORITY); custom routers stay below it. */
const MAX_PRIORITY = 100_000;
const MAX_NODES = 50_000;
/** Rule 7, matched case-insensitively (Traefik's decoder ignores key case). `<<` is a YAML merge Traefik applies but CORE_SCHEMA does not. */
const REFUSED_KEYS = new Set(['plugin', 'certfile', 'keyfile', 'rootcas', 'ca', 'cafiles', '<<']);
const SECTIONS: Record<'http' | 'tcp', string[]> = {
  http: ['routers', 'middlewares', 'services', 'serverstransports'],
  tcp: ['routers', 'services', 'middlewares'],
};

export const PREFLIGHT_WAIT_MS = 5_000;
export const POST_WRITE_WAIT_MS = 4_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Case-insensitive key lookup — Traefik matches field names that way. */
const pick = (o: Obj, key: string): unknown => {
  const k = Object.keys(o).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : o[k];
};
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A reference to a name the custom file did not define (`svc_x`, `mw_y@file`). */
const isCustomRef = (ref: string): boolean => CUSTOM_NAME_RE.test(ref.replace(/@file$/, ''));

/**
 * Validate a candidate (pure, synchronous). `ok` is `errors.length === 0`;
 * warnings never block a save.
 */
export function validateCustomConfig(
  content: string,
  ctx: { acmeEmailSet: boolean },
): TraefikCustomConfigValidation {
  const errors: TraefikCustomConfigIssue[] = [];
  const warnings: TraefikCustomConfigIssue[] = [];
  const done = () => ({ ok: errors.length === 0, errors, warnings });

  // Rule 1: UTF-8, no NUL, ≤ 256 KiB.
  if (typeof content !== 'string' || content.trim() === '') {
    errors.push({ path: '', message: 'the config is empty' });
    return done();
  }
  if (content.includes('\u0000')) errors.push({ path: '', message: 'the config contains a NUL character' });
  if (LONE_SURROGATE.test(content)) errors.push({ path: '', message: 'the config is not valid UTF-8' });
  if (Buffer.byteLength(content, 'utf8') > TRAEFIK_CUSTOM_CONFIG_MAX_BYTES) {
    errors.push({ path: '', message: 'the config is larger than 256 KiB' });
  }
  if (errors.length) return done();

  // Rule 2: CORE_SCHEMA YAML, no aliases, bounded walk.
  let root: unknown;
  try {
    root = load(content, { schema: CORE_SCHEMA });
  } catch (err) {
    errors.push({ path: '', message: `not valid YAML: ${String((err as Error).message).split('\n')[0]}` });
    return done();
  }
  if (root == null) {
    errors.push({ path: '', message: 'the config is empty' });
    return done();
  }
  if (!isObj(root)) {
    errors.push({ path: '', message: 'the config must be a mapping with `http`, `tcp` or `tls` at the top' });
    return done();
  }
  const seen = new Set<object>();
  let nodes = 0;
  const walk = (v: unknown, at: string): boolean => {
    if (++nodes > MAX_NODES) {
      errors.push({ path: at, message: `the config has more than ${MAX_NODES} nodes` });
      return false;
    }
    if (typeof v !== 'object' || v === null) return true;
    if (seen.has(v)) {
      errors.push({ path: at, message: 'YAML aliases (`*name`) are not allowed' });
      return true;
    }
    seen.add(v);
    if (Array.isArray(v)) return v.every((x, i) => walk(x, `${at}[${i}]`));
    const lower = new Set<string>();
    for (const [k, x] of Object.entries(v)) {
      const p = at ? `${at}.${k}` : k;
      const lk = k.toLowerCase();
      // Rule 7 (and the merge key, which would smuggle keys past rule 6).
      if (REFUSED_KEYS.has(lk)) errors.push({ path: p, message: `\`${k}\` is not allowed in a custom config` });
      if (lower.has(lk)) errors.push({ path: p, message: `\`${k}\` is defined twice (keys are case-insensitive)` });
      lower.add(lk);
      if (!walk(x, p)) return false;
    }
    return true;
  };
  if (!walk(root, '')) return done();

  // Rules 3–6.
  for (const [top, value] of Object.entries(root)) {
    const t = top.toLowerCase();
    if (t === 'udp') {
      errors.push({ path: top, message: '`udp` is not supported in a custom config' });
      continue;
    }
    if (t === 'tls') {
      if (!isObj(value)) {
        errors.push({ path: top, message: '`tls` must be a mapping' });
        continue;
      }
      for (const [k, opts] of Object.entries(value)) {
        if (k.toLowerCase() !== 'options') {
          errors.push({
            path: `${top}.${k}`,
            message: `\`tls.${k}\` is not allowed; upload certificates under Traefik → Certificates instead`,
          });
          continue;
        }
        checkNames(opts, `${top}.${k}`, errors);
      }
      continue;
    }
    if (t !== 'http' && t !== 'tcp') {
      errors.push({ path: top, message: `\`${top}\` is not allowed; use \`http\`, \`tcp\` or \`tls.options\`` });
      continue;
    }
    if (!isObj(value)) {
      errors.push({ path: top, message: `\`${top}\` must be a mapping` });
      continue;
    }
    for (const [section, defs] of Object.entries(value)) {
      const p = `${top}.${section}`;
      if (!SECTIONS[t].includes(section.toLowerCase())) {
        errors.push({ path: p, message: `\`${p}\` is not allowed; use ${SECTIONS[t].map((s) => `\`${t}.${s}\``).join(', ')}` });
        continue;
      }
      if (!checkNames(defs, p, errors)) continue;
      if (section.toLowerCase() === 'routers') {
        for (const [name, r] of Object.entries(defs as Obj)) checkRouter(r, `${p}.${name}`, t, ctx, errors, warnings);
      }
      if (section.toLowerCase() === 'middlewares') {
        for (const [name, m] of Object.entries(defs as Obj)) {
          const chain = isObj(m) ? pick(m, 'chain') : undefined;
          const list = isObj(chain) ? pick(chain, 'middlewares') : undefined;
          if (Array.isArray(list)) referenceWarnings(list, `${p}.${name}.chain.middlewares`, warnings);
        }
      }
    }
  }
  return done();
}

/** Rule 5 over one section: a mapping whose every key is a `custom-` name. */
function checkNames(defs: unknown, at: string, errors: TraefikCustomConfigIssue[]): boolean {
  if (!isObj(defs)) {
    errors.push({ path: at, message: `\`${at}\` must be a mapping of names` });
    return false;
  }
  let ok = true;
  for (const name of Object.keys(defs)) {
    if (!CUSTOM_NAME_RE.test(name)) {
      ok = false;
      errors.push({
        path: `${at}.${name}`,
        message: `\`${name}\` must start with \`custom-\` or \`custom_\` (letters, digits, \`-\` and \`_\`, up to 100 more)`,
      });
    }
  }
  return ok;
}

function referenceWarnings(refs: unknown[], at: string, warnings: TraefikCustomConfigIssue[], single = false): void {
  refs.forEach((ref, i) => {
    if (typeof ref === 'string' && !isCustomRef(ref) && !ref.endsWith('@internal')) {
      warnings.push({
        path: single ? at : `${at}[${i}]`,
        message: `\`${ref}\` is a generated name; it changes or disappears when its domain does`,
      });
    }
  });
}

/** Rule 6. */
function checkRouter(
  r: unknown,
  at: string,
  kind: 'http' | 'tcp',
  ctx: { acmeEmailSet: boolean },
  errors: TraefikCustomConfigIssue[],
  warnings: TraefikCustomConfigIssue[],
): void {
  if (!isObj(r)) {
    errors.push({ path: at, message: 'a router must be a mapping' });
    return;
  }
  const allowed = kind === 'tcp' ? ['websecure'] : ['web', 'websecure'];
  const eps = pick(r, 'entryPoints');
  if (eps === undefined) {
    if (kind === 'tcp') errors.push({ path: `${at}.entryPoints`, message: 'a TCP router must list `entryPoints: [websecure]`' });
  } else if (!Array.isArray(eps) || eps.some((e) => typeof e !== 'string' || !allowed.includes(e))) {
    errors.push({ path: `${at}.entryPoints`, message: `entryPoints must be within ${allowed.map((a) => `\`${a}\``).join(', ')}` });
  }
  const priority = pick(r, 'priority');
  if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority) || priority >= MAX_PRIORITY)) {
    errors.push({ path: `${at}.priority`, message: `priority must be a number below ${MAX_PRIORITY} (the panel router's)` });
  }
  const tls = pick(r, 'tls');
  if (tls !== undefined && tls !== null && !isObj(tls)) {
    errors.push({ path: `${at}.tls`, message: '`tls` must be a mapping' });
  } else if (isObj(tls)) {
    const resolver = pick(tls, 'certResolver');
    if (resolver !== undefined) {
      if (resolver !== 'letsencrypt') {
        errors.push({ path: `${at}.tls.certResolver`, message: 'the only certificate resolver is `letsencrypt`' });
      } else if (!ctx.acmeEmailSet) {
        errors.push({ path: `${at}.tls.certResolver`, message: '`letsencrypt` needs an ACME email (Settings → Security)' });
      }
    }
    const options = pick(tls, 'options');
    if (typeof options === 'string') referenceWarnings([options], `${at}.tls.options`, warnings, true);
  }
  const service = pick(r, 'service');
  if (typeof service === 'string') referenceWarnings([service], `${at}.service`, warnings, true);
  const mws = pick(r, 'middlewares');
  if (Array.isArray(mws)) referenceWarnings(mws, `${at}.middlewares`, warnings);
}

// ── Traefik log classification ────────────────────────────────────────────

const ERROR_LINE = /\bERR\b|\bFTL\b|level=(error|fatal)|"level":"(error|fatal)"/i;
const FILE_PROVIDER = /providerName=file|custom\.yml|ninedeploy\.yml|certificates\.yml|\/etc\/traefik\/dynamic|building configuration|reading configuration|cannot (unmarshal|decode)|yaml:/i;

/**
 * Split Traefik log text into file-provider errors (the file did not load:
 * reject) and other errors (a router referencing something missing: warn).
 * Best-effort: the wording varies between Traefik versions (DESIGN §2.7).
 */
export function classifyTraefikLog(text: string): { fileErrors: string[]; otherErrors: string[] } {
  const fileErrors: string[] = [];
  const otherErrors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !ERROR_LINE.test(line)) continue;
    (FILE_PROVIDER.test(line) ? fileErrors : otherErrors).push(line.slice(0, 500));
  }
  return { fileErrors, otherErrors };
}

// ── storage ────────────────────────────────────────────────────────────────

interface Envelope {
  content: string;
  sha256: string;
  updatedAt: string;
  updatedByUserId: number | null;
}
interface StatusRow {
  status: TraefikCustomConfigState;
  lastError: string | null;
}

async function readEnvelope(db: DB, key: string): Promise<Envelope | null | 'unreadable'> {
  const row = await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.key, key) });
  if (typeof row?.value !== 'string' || row.value === '') return null;
  try {
    const env = JSON.parse(decrypt(row.value)) as Envelope;
    return typeof env?.content === 'string' ? env : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

const envelopeFor = (content: string, userId: number | null): Envelope => ({
  content,
  sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  updatedAt: new Date().toISOString(),
  updatedByUserId: userId,
});

/** GET /v1/traefik/custom-config. */
export async function getCustomConfigState(db: DB): Promise<TraefikCustomConfig> {
  const current = await readEnvelope(db, CUSTOM_CONFIG_KEY);
  if (current === null || current === 'unreadable') {
    return {
      content: null,
      sha256: null,
      updatedAt: null,
      updatedBy: null,
      status: 'none',
      lastError: current === 'unreadable' ? 'the stored config could not be decrypted with the current master key' : null,
    };
  }
  const status = await getSettingJson<StatusRow>(db, CUSTOM_CONFIG_STATUS_KEY, null);
  return {
    content: current.content,
    sha256: current.sha256,
    updatedAt: current.updatedAt,
    updatedBy: current.updatedByUserId,
    status: status?.status === 'rejected' ? 'rejected' : 'applied',
    lastError: status?.lastError ?? null,
  };
}

/** Atomic 0600 write into the dynamic directory. */
function writePrivate(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Rule 8: the file Traefik reads goes through the F520 template escape. */
const renderCustomFile = (content: string): string => escapeTemplateDelims(content);

// ── preflight ──────────────────────────────────────────────────────────────

export type PreflightResult =
  | { ok: true; warnings: string[] }
  | { ok: false; unavailable: true; message: string }
  | { ok: false; unavailable: false; errors: string[] };

/**
 * Load the candidate in a throwaway Traefik: `--network none`, read-only, no
 * ACME, the current generated routes and certificates beside it, log level
 * ERROR. Never touches the live container; always removes its own.
 */
export async function preflightCustomConfig(content: string): Promise<PreflightResult> {
  const work = path.join(config.paths.dataDir, 'traefik-preflight', randomUUID());
  const name = `ninedeploy-traefik-preflight-${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(path.join(work, 'dynamic'), { recursive: true });
    writeFileSync(path.join(work, 'traefik.yml'), renderStaticConfig(null, null, { logLevel: 'ERROR' }));
    for (const f of [generatedConfigPath(), certificatesConfigPath()]) {
      if (existsSync(f)) copyFileSync(f, path.join(work, 'dynamic', path.basename(f)));
    }
    writeFileSync(path.join(work, 'dynamic', 'custom.yml'), renderCustomFile(content), { mode: 0o600 });
    try {
      await capture(
        'docker',
        [
          'run', '-d', '--name', name, '--network', 'none', '--read-only',
          '-v', `${await hostPathFor(work)}:/etc/traefik:ro`,
          TRAEFIK_IMAGE,
        ],
        { timeoutMs: 120_000 },
      );
    } catch (err) {
      return { ok: false, unavailable: true, message: err instanceof Error ? err.message : String(err) };
    }
    await sleep(PREFLIGHT_WAIT_MS);
    let logs: string;
    try {
      logs = await capture('docker', ['logs', name], { timeoutMs: 30_000 });
    } catch (err) {
      return { ok: false, unavailable: true, message: err instanceof Error ? err.message : String(err) };
    }
    const { fileErrors, otherErrors } = classifyTraefikLog(logs);
    return fileErrors.length ? { ok: false, unavailable: false, errors: fileErrors } : { ok: true, warnings: otherErrors };
  } finally {
    await run('docker', ['rm', '-f', name], {}, () => undefined).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}

// ── save / clear / boot ─────────────────────────────────────────────────────

export type ApplyResult =
  | { kind: 'invalid'; validation: TraefikCustomConfigValidation }
  | { kind: 'unavailable'; message: string }
  | { kind: 'preflight_failed'; errors: string[]; warnings: TraefikCustomConfigIssue[] }
  | { kind: 'rejected'; errors: string[]; sha256: string; reverted: 'last_good' | 'removed' }
  | { kind: 'applied'; sha256: string; warnings: TraefikCustomConfigIssue[] };

/** Save, clear and boot materialisation run one at a time. */
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * PUT: validate → preflight → write → watch the live Traefik's log → keep it
 * as last good, or revert. Nothing is written unless the preflight passed.
 */
export function applyCustomConfig(
  db: DB,
  input: { content: string; userId: number | null; acmeEmailSet: boolean },
): Promise<ApplyResult> {
  return serial(async () => {
    const validation = validateCustomConfig(input.content, { acmeEmailSet: input.acmeEmailSet });
    if (!validation.ok) return { kind: 'invalid', validation };
    const pre = await preflightCustomConfig(input.content);
    if (!pre.ok) {
      return pre.unavailable
        ? { kind: 'unavailable', message: pre.message }
        : { kind: 'preflight_failed', errors: pre.errors, warnings: validation.warnings };
    }
    const envelope = envelopeFor(input.content, input.userId);
    const since = new Date().toISOString();
    writePrivate(customConfigPath(), renderCustomFile(input.content));
    await sleep(POST_WRITE_WAIT_MS);
    let fileErrors: string[] = [];
    try {
      fileErrors = classifyTraefikLog(
        await capture('docker', ['logs', '--since', since, TRAEFIK_CONTAINER], { timeoutMs: 30_000 }),
      ).fileErrors;
    } catch {
      /* best effort: the preflight is the real guard (DESIGN §2.7) */
    }
    const sealed = encrypt(JSON.stringify(envelope));
    if (fileErrors.length) {
      const lastGood = await readEnvelope(db, CUSTOM_CONFIG_LAST_GOOD_KEY);
      let reverted: 'last_good' | 'removed' = 'removed';
      if (lastGood && lastGood !== 'unreadable') {
        writePrivate(customConfigPath(), renderCustomFile(lastGood.content));
        reverted = 'last_good';
      } else {
        rmSync(customConfigPath(), { force: true });
      }
      // The operator keeps their attempt to edit; Traefik keeps the last good one.
      await setSettingString(db, CUSTOM_CONFIG_KEY, sealed);
      await setSettingJson<StatusRow>(db, CUSTOM_CONFIG_STATUS_KEY, {
        status: 'rejected',
        lastError: fileErrors.join('\n').slice(0, 2000),
      });
      return { kind: 'rejected', errors: fileErrors, sha256: envelope.sha256, reverted };
    }
    await setSettingString(db, CUSTOM_CONFIG_KEY, sealed);
    await setSettingString(db, CUSTOM_CONFIG_LAST_GOOD_KEY, sealed);
    await setSettingJson<StatusRow>(db, CUSTOM_CONFIG_STATUS_KEY, { status: 'applied', lastError: null });
    const warnings = [
      ...validation.warnings,
      ...pre.warnings.map((message) => ({ path: '', message: `Traefik: ${message}` })),
    ];
    return { kind: 'applied', sha256: envelope.sha256, warnings };
  });
}

/** DELETE: remove the file and every stored version. Returns whether one existed. */
export function clearCustomConfig(db: DB): Promise<{ cleared: boolean; sha256: string | null }> {
  return serial(async () => {
    const current = await readEnvelope(db, CUSTOM_CONFIG_KEY);
    const existed = existsSync(customConfigPath()) || current !== null;
    rmSync(customConfigPath(), { force: true });
    await db
      .delete(settings)
      .where(inArray(settings.key, [CUSTOM_CONFIG_KEY, CUSTOM_CONFIG_LAST_GOOD_KEY, CUSTOM_CONFIG_STATUS_KEY]));
    return { cleared: existed, sha256: current && current !== 'unreadable' ? current.sha256 : null };
  });
}

/**
 * M12, boot: write `custom.yml` from the last good version (the database is
 * the source of truth), or remove a file no stored version backs. An
 * undecryptable version leaves the file as it is. Never throws.
 */
export function materialiseCustomConfig(db: DB, log: (line: string) => void = () => undefined): Promise<void> {
  return serial(async () => {
    try {
      mkdirSync(traefikDynamicDir(), { recursive: true });
      const lastGood = await readEnvelope(db, CUSTOM_CONFIG_LAST_GOOD_KEY);
      if (lastGood === 'unreadable') {
        log('custom traefik config: the stored version could not be decrypted; leaving custom.yml as it is');
        return;
      }
      if (lastGood === null) {
        rmSync(customConfigPath(), { force: true });
        return;
      }
      writePrivate(customConfigPath(), renderCustomFile(lastGood.content));
    } catch (err) {
      log(`custom traefik config: could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
