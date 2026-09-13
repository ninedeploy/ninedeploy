/**
 * Client-side secret lint for the Manifest Creator preview.
 *
 * This is the *same* pattern list the server's deploy-time loader uses —
 * `SECRET_PATTERNS` lives in `@ninedeploy/schemas` precisely so every
 * surface that touches a manifest (server, CLI, this form) scans with
 * identical rules. The only difference is presentation: the loader fails
 * the file, this lint flags the offending field name inline so the
 * operator can fix the slip before committing.
 */
import { SECRET_PATTERNS, redact, type NinedeployManifest } from '@ninedeploy/schemas';

export interface SecretLintHit {
  patternId: string;
  description: string;
  /** Index path of the field in the manifest ("env.aliases.DATABASE_URL"). */
  path: string;
  /** The offending value, redacted. */
  redacted: string;
}

/** Walk every string value in a manifest and return any secret-pattern hits. */
export function lintManifest(manifest: NinedeployManifest): SecretLintHit[] {
  const hits: SecretLintHit[] = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      for (const pattern of SECRET_PATTERNS) {
        const match = pattern.regex.exec(value);
        if (match && match.index !== undefined) {
          hits.push({
            patternId: pattern.id,
            description: pattern.description,
            path,
            redacted: redact(match[0]),
          });
        }
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        visit(v, path ? `${path}.${k}` : k);
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        visit(value[i], `${path}[${i}]`);
      }
    }
  };
  visit(manifest, '');
  return hits;
}
