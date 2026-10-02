import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * r702: install.sh's release download, executed for real. The REAL
 * fetch_release_tarball (cut out of install.sh) runs on top of the REAL
 * helpers (sourced through the r576 source-only mode) with only `curl` and
 * `cosign` faked on PATH — so the paths below are the installer's own, not a
 * re-typed copy: checksummed archive, fail-closed mismatch / signature, and
 * the unchanged codeload path for tags that predate published checksums.
 */
const installerPath = new URL('../../../install.sh', import.meta.url);
const installer = readFileSync(installerPath, 'utf8');
const bashOk = spawnSync('bash', ['-c', 'command -v tar >/dev/null && command -v sha256sum >/dev/null'], { encoding: 'utf8' }).status === 0;
const toBash = (p: string) => {
  const res = spawnSync('bash', ['-c', `cygpath -u '${p}' 2>/dev/null || printf '%s' '${p}'`], { encoding: 'utf8' });
  return res.stdout.trim();
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** fetch_release_tarball's text, exactly as install.sh defines it. */
function fetchFunction(): string {
  const start = installer.indexOf('\nfetch_release_tarball() {');
  expect(start).toBeGreaterThan(-1);
  const end = installer.indexOf('\n}\n', start);
  return installer.slice(start + 1, end + 3);
}

const FAKE_CURL = `#!/usr/bin/env bash
# Serves release assets from $FAKE_ASSETS by basename and GitHub's tag
# archive from $FAKE_ASSETS/codeload.tar.gz; a missing file is a 404.
out=""; fmt=""; fail=false; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) fmt="$2"; shift ;;
    -m|--retry|--retry-delay) shift ;;
    https://*) url="$1" ;;
    -*f*) case "$1" in --*) ;; *) fail=true ;; esac ;;
  esac
  shift
done
echo "$url" >> "$FAKE_LOG"
if [ "\${FAKE_NETWORK_DOWN:-}" = "1" ]; then [ -n "$fmt" ] && printf '000'; exit 6; fi
case "$url" in
  */archive/refs/tags/*) src="$FAKE_ASSETS/codeload.tar.gz" ;;
  */releases/download/*) src="$FAKE_ASSETS/\${url##*/}" ;;
  *) src="" ;;
esac
if [ -n "$src" ] && [ -f "$src" ]; then
  cat "$src" > "$out"
  [ -n "$fmt" ] && printf '200'
  exit 0
fi
if [ "$fail" = true ]; then exit 22; fi
printf 'Not Found' > "$out"
[ -n "$fmt" ] && printf '404'
exit 0
`;

const FAKE_COSIGN = `#!/usr/bin/env bash
if [ "$1" = "verify-blob" ] && [ "$2" = "--help" ]; then
  [ "\${FAKE_COSIGN_OLD:-}" = "1" ] && { echo "  --bundle string"; exit 0; }
  echo "  --new-bundle-format   expect a Sigstore bundle"; exit 0
fi
echo "$*" >> "$FAKE_COSIGN_LOG"
[ "\${FAKE_COSIGN_RC:-0}" = "0" ] || { echo "Error: none of the expected identities matched"; exit 1; }
exit 0
`;

interface Scenario {
  tag: string;
  /** Which assets the fake release serves. */
  sums?: 'good' | 'tampered' | 'unlisted' | 'none';
  bundle?: boolean;
  codeload?: boolean;
  cosign?: 'none' | 'ok' | 'bad' | 'old';
  networkDown?: boolean;
  env?: Record<string, string>;
}

function run(s: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'nd-r702-'));
  dirs.push(root);
  const assets = join(root, 'assets');
  const bin = join(root, 'bin');
  mkdirSync(assets);
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'curl'), 0o755);
  if ((s.cosign ?? 'none') !== 'none') {
    writeFileSync(join(bin, 'cosign'), FAKE_COSIGN);
    chmodSync(join(bin, 'cosign'), 0o755);
  }
  writeFileSync(join(root, 'fn.sh'), fetchFunction());
  const version = s.tag.slice(1);
  const B = (p: string) => toBash(p);
  const script = [
    'set -euo pipefail',
    `NINEDEPLOY_INSTALL_SOURCE_ONLY=1 . "${B(installerPath.pathname.replace(/^\/([A-Za-z]:)/, '$1'))}"`,
    `. "${B(join(root, 'fn.sh'))}"`,
    // Fixture: a NineDeploy-shaped tree under one top-level directory.
    `mkdir -p "${B(root)}/src/ninedeploy-${s.tag}"`,
    `printf '{\\n  "name": "ninedeploy",\\n  "version": "${version}"\\n}\\n' > "${B(root)}/src/ninedeploy-${s.tag}/package.json"`,
    `: > "${B(root)}/src/ninedeploy-${s.tag}/pnpm-workspace.yaml"`,
    `tar -czf "${B(assets)}/ninedeploy-${s.tag}.tar.gz" -C "${B(root)}/src" "ninedeploy-${s.tag}"`,
    s.codeload ? `cp "${B(assets)}/ninedeploy-${s.tag}.tar.gz" "${B(assets)}/codeload.tar.gz"` : ':',
    `printf '#!/usr/bin/env bash\\n' > "${B(assets)}/install.sh"`,
    `real=$(sha256sum "${B(assets)}/ninedeploy-${s.tag}.tar.gz" | awk '{print $1}')`,
    `inst=$(sha256sum "${B(assets)}/install.sh" | awk '{print $1}')`,
    {
      good: `printf '%s  %s\\n%s  install.sh\\n' "$real" "ninedeploy-${s.tag}.tar.gz" "$inst" > "${B(assets)}/SHA256SUMS"`,
      tampered: `printf '%s  %s\\n' "$(printf '%064d' 0)" "ninedeploy-${s.tag}.tar.gz" > "${B(assets)}/SHA256SUMS"`,
      unlisted: `printf '%s  install.sh\\n' "$inst" > "${B(assets)}/SHA256SUMS"`,
      none: ':',
    }[s.sums ?? 'none'],
    s.bundle ? `echo '{}' > "${B(assets)}/SHA256SUMS.sigstore.json"` : ':',
    `export PATH="${B(bin)}:$PATH" FAKE_ASSETS="${B(assets)}" FAKE_LOG="${B(root)}/curl.log" FAKE_COSIGN_LOG="${B(root)}/cosign.log"`,
    `: > "${B(root)}/curl.log"`,
    `if fetch_release_tarball "${s.tag}" "${B(root)}/dest"; then echo "RESULT=ok"; else echo "RESULT=unavailable"; fi`,
  ].join('\n');
  const env: Record<string, string> = { ...process.env, ...(s.env ?? {}) } as Record<string, string>;
  if (s.networkDown) env['FAKE_NETWORK_DOWN'] = '1';
  if (s.cosign === 'bad') env['FAKE_COSIGN_RC'] = '1';
  if (s.cosign === 'old') env['FAKE_COSIGN_OLD'] = '1';
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
  const output = `${res.stdout}${res.stderr}`;
  const log = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
  return {
    status: res.status,
    output,
    result: /RESULT=(\w+)/.exec(res.stdout)?.[1] ?? 'refused',
    urls: log('curl.log').split('\n').filter(Boolean),
    cosign: log('cosign.log'),
    unpacked: existsSync(join(root, 'dest', 'package.json')),
  };
}

const RELEASE = 'https://github.com/NineDeploy/NineDeploy/releases/download';
const CODELOAD = 'https://github.com/NineDeploy/NineDeploy/archive/refs/tags';

describe.skipIf(!bashOk)('r702: install.sh verifies the release archive against SHA256SUMS', () => {
  it('installs the release archive asset whose sha256 SHA256SUMS lists — never the codeload tarball', () => {
    const r = run({ tag: 'v0.10.43', sums: 'good' });
    expect(r.result, r.output).toBe('ok');
    expect(r.unpacked).toBe(true);
    expect(r.urls).toEqual([`${RELEASE}/v0.10.43/SHA256SUMS`, `${RELEASE}/v0.10.43/ninedeploy-v0.10.43.tar.gz`]);
    expect(r.output).toContain('ninedeploy-v0.10.43.tar.gz matches the release\'s SHA256SUMS');
    // No cosign: said in one line, and the checksum still decides.
    expect(r.output).toContain('cosign is not installed — the release signature is not checked (the archive checksum is)');
  });

  it('a checksum mismatch stops the installer (exit 1) without unpacking or falling back', () => {
    const r = run({ tag: 'v0.10.43', sums: 'tampered', codeload: true });
    expect(r.result, r.output).toBe('refused');
    expect(r.status).toBe(1);
    expect(r.output).toContain('Checksum mismatch for ninedeploy-v0.10.43.tar.gz');
    expect(r.unpacked).toBe(false);
    expect(r.urls.some((u) => u.startsWith(CODELOAD))).toBe(false);
  });

  it('SHA256SUMS that does not list the archive is a refusal, not a download', () => {
    const r = run({ tag: 'v0.10.43', sums: 'unlisted', codeload: true });
    expect(r.result, r.output).toBe('refused');
    expect(r.output).toContain('does not list exactly one checksum for ninedeploy-v0.10.43.tar.gz');
    expect(r.urls).toEqual([`${RELEASE}/v0.10.43/SHA256SUMS`]);
  });

  it('with cosign present, verifies the SHA256SUMS bundle against the release workflow identity', () => {
    const r = run({ tag: 'v0.10.43', sums: 'good', bundle: true, cosign: 'ok' });
    expect(r.result, r.output).toBe('ok');
    expect(r.urls).toContain(`${RELEASE}/v0.10.43/SHA256SUMS.sigstore.json`);
    expect(r.cosign).toContain('verify-blob --new-bundle-format --bundle');
    expect(r.cosign).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com');
    expect(r.cosign).toContain(
      '--certificate-identity-regexp ^https://github\\.com/(?i:ninedeploy/ninedeploy)/\\.github/workflows/release-publish\\.yml@refs/(tags/v[0-9]+\\.[0-9]+\\.[0-9]+|heads/main)$',
    );
    expect(r.output).toContain("signed by NineDeploy's release workflow");
  });

  it('a signature that does not verify — or a missing bundle — stops the installer', () => {
    const bad = run({ tag: 'v0.10.43', sums: 'good', bundle: true, cosign: 'bad', codeload: true });
    expect(bad.result, bad.output).toBe('refused');
    expect(bad.output).toContain('did NOT verify against NineDeploy\'s release workflow');
    expect(bad.output).toContain('none of the expected identities matched'); // cosign's own reason is shown
    expect(bad.unpacked).toBe(false);
    // Nothing SHA256SUMS lists was fetched before the signature was checked.
    expect(bad.urls.some((u) => u.endsWith('.tar.gz'))).toBe(false);

    const missing = run({ tag: 'v0.10.43', sums: 'good', bundle: false, cosign: 'ok' });
    expect(missing.result, missing.output).toBe('refused');
    expect(missing.output).toContain('Could not download SHA256SUMS.sigstore.json');
  });

  it('the explicit opt-out and a cosign too old for bundles fall back to the checksum, loudly', () => {
    const skip = run({ tag: 'v0.10.43', sums: 'good', bundle: true, cosign: 'bad', env: { NINEDEPLOY_SKIP_SIGNATURE_VERIFY: '1' } });
    expect(skip.result, skip.output).toBe('ok');
    expect(skip.output).toContain('NINEDEPLOY_SKIP_SIGNATURE_VERIFY=1 — the release signature is not checked');
    expect(skip.cosign).toBe('');

    const old = run({ tag: 'v0.10.43', sums: 'good', bundle: true, cosign: 'old' });
    expect(old.result, old.output).toBe('ok');
    expect(old.output).toContain('too old to read Sigstore bundles');
  });

  it('a release that publishes checksums is never installed from the unverified codeload tarball', () => {
    // SHA256SUMS 404 for a >= v0.10.43 tag (stripped asset, unpublished tag).
    const missing = run({ tag: 'v0.10.44', sums: 'none', codeload: true });
    expect(missing.result, missing.output).toBe('unavailable');
    expect(missing.urls).toEqual([`${RELEASE}/v0.10.44/SHA256SUMS`]);
    expect(missing.output).toContain('not installing an unverified archive of a release that publishes checksums');
    // The asset host unreachable: same — the caller's existing fallback decides.
    const down = run({ tag: 'v0.10.43', sums: 'good', codeload: true, networkDown: true });
    expect(down.result, down.output).toBe('unavailable');
    expect(down.output).toContain('HTTP 000');
  });

  it('tags that predate published checksums keep the codeload path, with a one-line warning', () => {
    const r = run({ tag: 'v0.10.42', sums: 'none', codeload: true });
    expect(r.result, r.output).toBe('ok');
    expect(r.unpacked).toBe(true);
    expect(r.urls).toEqual([`${RELEASE}/v0.10.42/SHA256SUMS`, `${CODELOAD}/v0.10.42.tar.gz`]);
    expect(r.output).toContain("v0.10.42 predates published release checksums — installing GitHub's tag archive, verified by TLS only (as before)");
  });

  it('an older tag whose release was given checksums later (a re-run) is verified like a new one', () => {
    const r = run({ tag: 'v0.10.40', sums: 'tampered', codeload: true });
    expect(r.result, r.output).toBe('refused');
    expect(r.output).toContain('Checksum mismatch');
  });
});

describe('r702: the installer keeps its other guarantees around the new download', () => {
  it('a mismatch EXITS (no git fallback) while an unavailable release still returns to the caller', () => {
    const fn = fetchFunction();
    // fail = exit; every refusal path uses it, the unavailable paths return 1.
    expect(fn).toContain('fail "Checksum mismatch for $_asset');
    expect(fn).toContain('fail "The signature on $_ref\'s SHA256SUMS did NOT verify');
    expect(fn.indexOf('verify_checksums_signature')).toBeLessThan(fn.indexOf('sha256sums_lookup'));
    // The codeload URL is only reachable on the pre-checksum branch.
    const codeload = fn.indexOf('/archive/refs/tags/');
    expect(fn.lastIndexOf('elif release_has_checksums "$_ref"; then', codeload)).toBeGreaterThan(-1);
    // r262/r357: fetch_release_tarball still runs BEFORE the rollback is
    // prepared, so a refusal leaves the running tree untouched and the EXIT
    // trap restarts the stopped service.
    const release = installer.slice(installer.indexOf('\nupgrade_from_release() {'));
    expect(release.indexOf('prepare_upgrade_rollback "$_stage"')).toBeGreaterThan(release.indexOf('fetch_release_tarball'));
    expect(installer).toContain('trap restore_service_on_exit EXIT');
  });

  it('the provenance comment states what is guaranteed, and that the trust root is GitHub plus Sigstore', () => {
    const fn = fetchFunction();
    expect(fn).toContain('the archive is byte-for-byte the one SHA256SUMS lists (fail-closed)');
    expect(fn).toContain('The trust root is GitHub (account, Actions, OIDC) plus Sigstore');
    expect(fn).toContain('is no maintainer-held key');
  });
});
