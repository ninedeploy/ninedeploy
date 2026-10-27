/** Expected provider state in a fresh upgrade smoke, including historical releases. */
export function expectedUpgradeSecretProviders(version, vaultConfigured) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid upgrade target version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  const expanded = major > 0 || minor > 18 || (minor === 18 && patch >= 5);
  const kinds = expanded ? ['aws', 'azure', 'exec', 'gcp', 'onepassword', 'vault'] : ['aws', 'vault'];
  return kinds.map((kind) => `${kind}:${kind === 'vault' && vaultConfigured}`).sort().join(',');
}
