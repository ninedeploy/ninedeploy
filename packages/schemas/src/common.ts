import { z } from 'zod';

/** URL-safe slug used for projects, services, routes. */
export const slug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and hyphens');

/**
 * POSIX environment-variable name, as accepted by `docker run --env-file` and
 * shells: letters, digits and underscores, starting with a letter or
 * underscore. Surrounding whitespace is trimmed so sloppy input is normalized;
 * anything else (e.g. `MY VAR`) is rejected — such a key would otherwise break
 * the deploy at `docker run --env-file` time.
 */
export const envVarName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'must be a valid environment variable name (letters, digits, underscore; cannot start with a digit)',
  );

export const id = z.number().int().positive();

/**
 * An absolute HTTP path (health checks, probe targets).
 *
 * Health paths are concatenated onto `http://host:port` before the result is
 * parsed as a URL, so an unconstrained string can rewrite the authority: the
 * value `@evil.example.com/` turns `http://127.0.0.1:3000@evil.example.com/`
 * into a request to evil.example.com with `127.0.0.1:3000` as userinfo. The
 * leading slash plus the character allowlist (no `@`, no `\`) removes that.
 */
export const httpPath = z
  .string()
  .max(200)
  .regex(
    /^\/[A-Za-z0-9\-._~!$&'()*+,;=:%/?[\]]*$/,
    'must be an absolute path beginning with "/" (no host, no "@")',
  );

/**
 * A git remote URL restricted to transports we actually support.
 *
 * `z.url()` alone accepts any parseable URL, including `file://` (local
 * repository disclosure) and `ext::sh -c …`, git's arbitrary-command
 * transport. Modern git refuses `ext::` on its own and simple-git blocks
 * several related options, but neither is this application's control — so the
 * scheme is pinned here rather than relying on the toolchain to stay strict.
 */
export const gitRepoUrl = z
  .url()
  .refine((value) => /^(?:https?|ssh):\/\//i.test(value), {
    message: 'repoUrl must be an http(s) or ssh URL',
  });

/**
 * 0.13: the base URL of an operator-supplied git provider API or web UI
 * (a Gitea instance, GitHub Enterprise Server, `https://github.com`).
 *
 * `http:` is accepted HERE on purpose: whether plain http is allowed depends on
 * the server's `NINEDEPLOY_ALLOW_PRIVATE_EGRESS` escape hatch, which this
 * package cannot see. The server refuses `http:` unless that flag is set, and
 * every call still goes through its egress guard. Rejecting http in the schema
 * would make the documented escape hatch (an internal http-only Gitea)
 * unusable. Userinfo, query and fragment are refused — a base URL never needs
 * them, and userinfo would smuggle credentials into a URL that gets logged.
 * Trailing slashes are dropped so `${base}/api/v1/…` joins cleanly.
 */
export const providerBaseUrl = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url({ protocol: /^https?$/, message: 'must be an http(s) URL' }))
  // Everything after the scheme: no `@` (userinfo), `?` or `#`.
  .refine((value) => !/[@?#]/.test(value.slice(value.indexOf(':') + 3)), {
    message: 'must be a base URL without credentials, query or fragment',
  })
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * A git branch/ref name. Reaches `git checkout` / `git pull` as an argv
 * element, so a value starting with `-` would be read as an option rather
 * than a ref; the allowlist also rules out the `..` and whitespace forms git
 * itself rejects in `check-ref-format`.
 */
export const gitBranch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'invalid branch name')
  .refine((v) => !v.includes('..') && !v.endsWith('.lock'), { message: 'invalid branch name' });

/**
 * A path interpreted relative to the checked-out repository.
 *
 * A LEADING SLASH IS ALLOWED and means "from the repo root" — that is the
 * existing convention for `baseDir` (`/`, `/app`), so rejecting it here would
 * break real configurations. What is rejected is anything that could climb out
 * of the checkout once resolved: `..` segments, NUL, and Windows drive
 * letters.
 *
 * This is a usability guard, not the security boundary. The sinks
 * (`docker build -f` / its build context, `docker compose -f`) resolve these
 * values against the work dir, so they re-anchor the path themselves — see
 * `lib/repoPath.ts`.
 */
const insideRepo = (value: string): boolean =>
  !/^[A-Za-z]:/.test(value) &&
  !value.includes('\0') &&
  !value.split(/[\\/]/).includes('..');

export const repoRelativePath = z
  .string()
  .trim()
  .max(400)
  .refine(insideRepo, { message: 'must be a path inside the repository (no "..")' });

/** Same rules as {@link repoRelativePath}; named for the build-context field. */
export const repoBaseDir = repoRelativePath;

/**
 * Absolute path inside a container (e.g. `/data`, `/var/lib/uploads`).
 * Rejected: empty, relative, paths containing NUL, parent-relative segments,
 * or a leading double slash (Docker treats `//` as the named-volume named
 * bind-mount form which is not what we want here).
 */
export const containerPath = z
  .string()
  .min(1)
  .max(1024)
  // Anchored on both ends: the old `^\/[^/].*` prefix-match let `/a/../b`,
  // embedded NUL/newline and interior `//` through. Segments are non-empty,
  // slash-free and control-char-free; a lone `/` stays valid.
  .regex(/^\/(?:[^/\0\n\r]+\/?)*$/, 'must be an absolute path starting with a single "/"')
  .refine((v) => !v.split('/').includes('..'), { message: 'must not contain ".." segments' });

/**
 * Docker named-volume name: letters (BOTH cases — the `i` flag is deliberate,
 * r474: docker itself accepts uppercase volume names, and rejecting them
 * would break attach flows against pre-existing out-of-band volumes), digits,
 * underscores, hyphens and dots; must start with alnum; max 64 chars (the
 * volume driver limit on most filesystems). The managed prefixes `nd-svc-` /
 * `nd-db-` are lowercased by construction; a non-managed name attaches a
 * pre-existing volume the client created out-of-band.
 */
export const dockerVolumeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/i, 'invalid docker volume name');

/** Cursor-style pagination params. */
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.coerce.number().int().positive().optional(),
});
export type Pagination = z.infer<typeof pagination>;

/** Standard error envelope returned by the API. */
export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

/** A page of results. */
export function page<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.number().int().positive().nullable(),
    total: z.number().int().nonnegative().optional(),
  });
}
