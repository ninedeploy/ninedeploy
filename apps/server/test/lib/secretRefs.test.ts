import { describe, expect, it } from 'vitest';
import { findSecretRefs, hasSecretRef, replaceSecretRefs } from '../../src/lib/secretRefs.js';
import { hasVaultRef } from '../../src/lib/vault.js';

/** `${{body}}` without writing a template-looking literal. */
const ref = (body: string) => ['$', '{{', body, '}}'].join('');

describe('secret reference grammar (0.14, DESIGN §4.1)', () => {
  it('parses every provider form', () => {
    const value = [
      ref('infisical:API_KEY'),
      ref('doppler:db.pass-1'),
      ref('vault:team/app/prod#db_password'),
      ref('aws:prod/db'),
      ref('aws:arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf#password'),
    ].join(' ');
    expect(findSecretRefs(value)).toEqual([
      { provider: 'infisical', raw: ref('infisical:API_KEY'), key: 'API_KEY' },
      { provider: 'doppler', raw: ref('doppler:db.pass-1'), key: 'db.pass-1' },
      { provider: 'vault', raw: ref('vault:team/app/prod#db_password'), path: 'team/app/prod', field: 'db_password' },
      { provider: 'aws', raw: ref('aws:prod/db'), secretId: 'prod/db', jsonKey: null },
      {
        provider: 'aws',
        raw: ref('aws:arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf#password'),
        secretId: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf',
        jsonKey: 'password',
      },
    ]);
  });

  it('accepts names and ARNs with the full AWS id charset', () => {
    expect(hasSecretRef(ref('aws:a+b=c.d@e:f/g_h-i'))).toBe(true);
    expect(hasSecretRef(ref(`aws:${'a'.repeat(2048)}`))).toBe(true);
    expect(hasSecretRef(ref(`aws:${'a'.repeat(2049)}`))).toBe(false);
  });

  it('refuses dot segments, edge slashes and a missing field in a vault path', () => {
    for (const bad of [
      'vault:../sys#x',
      'vault:a/../b#x',
      'vault:a/./b#x',
      'vault:.#x',
      'vault:..#x',
      'vault:a/..#x',
      'vault:/a#x',
      'vault:a/#x',
      'vault:a//b#x',
      'vault:a',
      'vault:a#',
      'vault:a b#x',
      'vault:a#x/y',
      'aws:',
      'aws:a#',
      'aws:a b',
      'onepassword:x',
    ]) {
      expect(hasSecretRef(ref(bad)), bad).toBe(false);
    }
    // Dots inside a segment are fine.
    expect(findSecretRefs(ref('vault:.hidden/x..y#f'))).toHaveLength(1);
  });

  it('never matches across a closing }}', () => {
    expect(hasSecretRef(`${ref('vault:a')}#b}}`)).toBe(false);
    expect(hasSecretRef(['$', '{{aws:a}}b}}'].join(''))).toBe(true);
    expect(findSecretRefs(['$', '{{aws:a}}b}}'].join(''))[0]).toMatchObject({ secretId: 'a' });
    expect(hasSecretRef(['$', '{{vault:a}}', '$', '{{x#b}}'].join(''))).toBe(false);
  });

  it('is stateless between calls (no shared lastIndex)', () => {
    const v = ref('aws:x');
    expect([hasSecretRef(v), hasSecretRef(v), hasSecretRef(v)]).toEqual([true, true, true]);
  });

  it('replaces in a single pass: a resolved value is never re-scanned', () => {
    const value = `a=${ref('aws:one')} b=${ref('vault:p#f')} c=${ref('doppler:K')}`;
    const out = replaceSecretRefs(value, (r) => (r.provider === 'aws' ? ref('vault:p#f') : `<${r.provider}>`));
    expect(out).toBe(`a=${ref('vault:p#f')} b=<vault> c=<doppler>`);
  });

  it('hasVaultRef delegates to hasSecretRef (mount point M14)', () => {
    for (const v of [ref('vault:a#b'), ref('aws:x'), ref('aws:x#k'), ref('infisical:K'), ref('doppler:K')]) {
      expect(hasVaultRef(v), v).toBe(true);
    }
    expect(hasVaultRef('plain')).toBe(false);
    expect(hasVaultRef(ref('vault:a'))).toBe(false);
  });
});
