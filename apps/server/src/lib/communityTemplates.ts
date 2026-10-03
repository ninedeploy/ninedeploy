/**
 * `ninedeploy templates community {list,import,remove}` —
 * G-13 community catalog contribution.
 *
 * The bundled template registry ships with the app
 * (and a remote URL is overridable via
 * `NINEDEPLOY_TEMPLATE_REGISTRY_URL`). Community
 * contributions are a third source: any `*.json` file
 * dropped into `<dataDir>/community-templates/` is
 * loaded, validated against the template schema, and
 * merged into the catalog the panel shows. The merge is
 * by `id`: a community entry with the same id as a
 * bundled entry is dropped (the bundled entry is the
 * installable baseline; community entries are roadmap
 * items until the loader refuses `npm` / `git` /
 * `local` plugin sources).
 *
 * Auth: read = member, write = admin. The list path
 * catches every parse error per file and returns the
 * error in the response; the panel can show "5 valid,
 * 1 invalid (foo.json: ...)".
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { parseTemplates, type Template } from '../templates/registry.js';

const DIR = 'community-templates';

function dir(): string {
  return join(config.paths.dataDir, DIR);
}

/**
 * Template ids become FILE NAMES (`<id>.json`), so the id must be a
 * filename-safe slug: no separators, no dot segments. `join()` happily
 * resolves `../..` out of the community dir otherwise, turning a template
 * paste into an arbitrary-file write/delete.
 */
function assertSafeFileId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new Error(`Invalid template id "${id}": must be a filename-safe slug (letters, digits, dot, dash, underscore)`);
  }
}

export interface CommunityTemplateEntry {
  /** Template id (from the JSON). */
  id: string;
  /** The parsed `Template` object. */
  template: Template;
  /** File name on disk (relative to the community dir). */
  file: string;
  /** File size in bytes. */
  bytes: number;
  /** Last-modified epoch ms. */
  mtime: number;
}

export interface CommunityListResult {
  /** The list of valid entries, sorted by id. */
  entries: CommunityTemplateEntry[];
  /** Files that failed to parse; the operator can
   *  see exactly which file and which line broke. */
  errors: Array<{ file: string; error: string }>;
  /** Total bytes on disk. */
  totalBytes: number;
}

/** List every valid community template plus a per-file
 *  error list for files that failed to parse. */
export async function listCommunityTemplates(): Promise<CommunityListResult> {
  const out: CommunityTemplateEntry[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let totalBytes = 0;
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    // No community dir yet — return empty. The first
    // `import` call will create it.
    return { entries: [], errors: [], totalBytes: 0 };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir(), name);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      errors.push({ file: name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    totalBytes += raw.length;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const templates = parseTemplates([parsed]);
      const t = templates[0];
      if (!t) {
        errors.push({ file: name, error: 'No template object in file' });
        continue;
      }
      out.push({
        id: t.id,
        template: t,
        file: name,
        bytes: raw.length,
        mtime: 0,
      });
    } catch (err) {
      errors.push({ file: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { entries: out, errors, totalBytes };
}

/**
 * Add a community template. The body is the raw JSON
 * content of a single template envelope. The helper
 * validates the file, picks a stable filename
 * (`<id>.json`), and refuses to overwrite an existing
 * file unless `replace: true` is passed.
 */
export async function importCommunityTemplate(
  rawJson: string,
  opts: { replace?: boolean } = {},
): Promise<{ id: string; file: string; bytes: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const templates = parseTemplates([parsed]);
  const t = templates[0];
  if (!t) throw new Error('No template object in file');
  assertSafeFileId(t.id);
  await mkdir(dir(), { recursive: true });
  const file = `${t.id}.json`;
  const path = join(dir(), file);
  // Refuse to overwrite unless explicitly asked. This
  // matches the panel's "this id is already in the
  // catalog" UX; a deliberate replace is a separate
  // path so the operator doesn't lose a community
  // entry to a copy/paste.
  if (!opts.replace) {
    try {
      await readFile(path);
      throw new Error(`Template "${t.id}" already exists; pass replace: true to overwrite`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Template "')) throw err;
      // ENOENT (file does not exist) is the success path.
    }
  }
  // Pretty-print so the file is diffable when the
  // operator reviews the community contribution.
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { id: t.id, file, bytes: rawJson.length };
}

/** Remove a community template by id. */
export async function removeCommunityTemplate(id: string): Promise<{ id: string; removed: boolean }> {
  assertSafeFileId(id);
  const path = join(dir(), `${id}.json`);
  try {
    await unlink(path);
    return { id, removed: true };
  } catch {
    return { id, removed: false };
  }
}
