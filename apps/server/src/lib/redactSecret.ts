/**
 * F568: a failed provider call as diagnostic text that never carries the
 * decrypted token. fetch's header validation rejects a token holding CR/LF/NUL
 * with a message that embeds the whole header value, and the token is
 * write-only everywhere else in this module.
 *
 * Moved out of `modules/sources.ts` (0.13) so the GitHub App client
 * (`lib/githubApp.ts`) redacts its installation tokens and App JWTs the same
 * way.
 */
export function providerErrorText(err: unknown, token: string): string {
  let text = err instanceof Error ? err.message : String(err);
  const lines = token.split(/[\r\n\0]+/).filter((p) => p.trim().length >= 4);
  const pieces = [token, token.trim(), ...lines].filter((p) => p.length > 0);
  for (const piece of pieces.sort((a, b) => b.length - a.length)) text = text.split(piece).join('[redacted]');
  return text;
}

/** `providerErrorText` for several secrets at once (a token AND the JWT that minted it). */
export function redactSecrets(err: unknown, secrets: readonly (string | null | undefined)[]): string {
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret) text = providerErrorText(text, secret);
  }
  return text;
}
