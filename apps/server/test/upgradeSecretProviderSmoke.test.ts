import { describe, expect, it } from 'vitest';
import { expectedUpgradeSecretProviders } from '../../../scripts/lib/upgrade-secret-providers.mjs';

describe('upgrade smoke secret provider expectations', () => {
  it.each(['v0.14.0', 'v0.18.4'])('retains the historical provider set for %s', version => {
    expect(expectedUpgradeSecretProviders(version, false)).toBe('aws:false,vault:false');
    expect(expectedUpgradeSecretProviders(version, true)).toBe('aws:false,vault:true');
  });
  it.each(['v0.18.5', 'v0.19.0', 'v1.0.0'])('checks every current provider for %s', version => {
    expect(expectedUpgradeSecretProviders(version, false)).toBe('aws:false,azure:false,exec:false,gcp:false,onepassword:false,vault:false');
    expect(expectedUpgradeSecretProviders(version, true)).toBe('aws:false,azure:false,exec:false,gcp:false,onepassword:false,vault:true');
  });
  it('rejects an invalid version rather than choosing the wrong expectation', () => {
    expect(() => expectedUpgradeSecretProviders('not-a-version', false)).toThrow(/Invalid upgrade target/);
  });
});
