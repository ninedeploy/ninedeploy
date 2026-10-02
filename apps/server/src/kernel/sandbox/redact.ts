/**
 * r533: what a sandbox plugin must not see when a hook payload or event
 * crosses the IPC boundary.
 *
 * Hook payloads carry whole DB rows (`deploy:before`/`deploy:after` hand over
 * the `services` row, `database:before_delete` the `databases` row,
 * `proxy:sync_routes` domains, `server:before_announce` the enrolment token).
 * Those rows hold secrets that the permission model does nothing about —
 * the plugin does not need to READ a file when the panel posts the value to
 * it. The redaction is by FIELD NAME, recursively, so a column added later
 * under an obviously-secret name is covered without touching this file:
 *
 *   - any key matching SECRET_KEY below (password / passphrase / secret /
 *     token / api key / private key / credential(s) / htpasswd / basicAuth /
 *     authorization / cookie / master key) — e.g. `passwordEncrypted`,
 *     `verificationToken`, `basicAuth`, the announce `token`;
 *   - `env` / `envVars` / `environment` objects (raw env maps);
 *   - `composeContent` — a compose file routinely inlines
 *     `POSTGRES_PASSWORD: …`, and it cannot be redacted line by line safely;
 *   - credentials embedded in a URL's userinfo (`https://user:tok@host/…` in
 *     `repoUrl`) — the URL stays, the userinfo becomes `[redacted]`.
 *
 * Everything else (ids, names, slugs, image, branch, commit, ports, status,
 * hostnames, …) is passed through unchanged, so plugins keyed on those keep
 * working.
 *
 * Hooks can AMEND their payload, and the sandbox echoes the payload it was
 * given when a handler returns nothing — so a redacted copy flowing back into
 * the pipeline would replace the real values with placeholders. `restore()`
 * puts the originals back wherever the result still holds the exact
 * placeholder this module produced; a value the plugin deliberately changed
 * is left as the plugin set it (that is what tapping a hook permits).
 */

export const REDACTED = '[redacted]';

const SECRET_KEY =
  /passw(or)?d|passphrase|secret|token|api[-_]?key|private[-_]?key|credential|htpasswd|basic[-_]?auth|^auth(orization)?$|cookie|master[-_]?key/i;
const ENV_KEY = /^(env|envVars|environment)$/i;
const OPAQUE_KEY = /^compose[-_]?content$/i;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/i;

/** Nested-depth ceiling: DB rows are shallow; anything deeper is not ours to walk. */
const MAX_DEPTH = 12;

type Path = Array<string | number>;

interface Replacement {
  path: Path;
  original: unknown;
  placeholder: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether the value under a matched key gets replaced. Flags and counters are
 * not secrets (`isSecret: false` in `config.changed` must survive), absent
 * values tell the plugin nothing, and an `environment` that is a plain string
 * ("production") is a label, not an env map.
 */
function shouldRedact(key: string, val: unknown): boolean {
  if (val === null || val === undefined || val === '') return false;
  if (typeof val === 'boolean' || typeof val === 'number') return false;
  if (ENV_KEY.test(key)) return typeof val === 'object';
  return SECRET_KEY.test(key) || OPAQUE_KEY.test(key);
}

export interface RedactedPayload<T> {
  value: T;
  /** Number of fields replaced — 0 means `value` is a plain copy. */
  redactedCount: number;
  /** Put the originals back into a hook result wherever the placeholder survived. */
  restore(result: unknown): unknown;
}

export function redactForSandbox<T>(input: T): RedactedPayload<T> {
  const replacements: Replacement[] = [];

  const walk = (v: unknown, path: Path, depth: number): unknown => {
    if (typeof v === 'string') {
      const m = URL_USERINFO.exec(v);
      if (m) {
        const placeholder = `${m[1]}${REDACTED}@${v.slice(m[0].length)}`;
        replacements.push({ path, original: v, placeholder });
        return placeholder;
      }
      return v;
    }
    if (depth >= MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map((item, i) => walk(item, [...path, i], depth + 1));
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v)) {
      if (shouldRedact(key, val)) {
        replacements.push({ path: [...path, key], original: val, placeholder: REDACTED });
        out[key] = REDACTED;
      } else {
        out[key] = walk(val, [...path, key], depth + 1);
      }
    }
    return out;
  };

  const value = walk(input, [], 0) as T;

  return {
    value,
    redactedCount: replacements.length,
    restore(result: unknown): unknown {
      if (replacements.length === 0) return result;
      // The whole payload was one redacted string (a bare URL): restore it.
      const root = replacements.find((r) => r.path.length === 0);
      if (root) return result === root.placeholder ? root.original : result;
      if (result === null || typeof result !== 'object') return result;
      for (const r of replacements) {
        let parent: any = result;
        for (const seg of r.path.slice(0, -1)) {
          parent = parent?.[seg as keyof typeof parent];
          if (parent === null || typeof parent !== 'object') break;
        }
        if (parent === null || typeof parent !== 'object') continue;
        const leaf = r.path[r.path.length - 1]!;
        if (parent[leaf] === r.placeholder) parent[leaf] = r.original;
      }
      return result;
    },
  };
}
