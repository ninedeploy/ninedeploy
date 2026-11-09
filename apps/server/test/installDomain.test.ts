/**
 * A2 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): install.sh --domain/--email.
 * Bare metal SOURCES .env, so the validators are the security boundary: a
 * value that reaches .env must never be something a shell would act on.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureBash, fixtureBashPath } from './bashFixture.js';

const bash = fixtureBash(spawnSync);
const installerFile = fileURLToPath(new URL('../../../install.sh', import.meta.url));
const installer = fixtureBashPath(spawnSync, installerFile, bash);
const sh = readFileSync(installerFile, 'utf8');
const run = (script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(bash, ['-c', `NINEDEPLOY_INSTALL_SOURCE_ONLY=1 . "$1"\n${script}`, 'install-domain-test', installer, ...args], { encoding: 'utf8', timeout: 10000, env });

describe('install.sh panel domain helpers', () => {
  it.each([
    ['panel.example.com', true],
    ['a.b.example.co', true],
    ['xn--bcher-kva.example', true],
    ['localhost', false],
    ['Panel.Example.com', false], // the flag is lowercased before it is checked
    ['-panel.example.com', false],
    ['panel-.example.com', false],
    ['panel..example.com', false],
    ['panel.example.com.', false],
    ['panel.example.123', false],
    ['$(id).example.com', false],
    ['panel.example.com\nevil.example.com', false],
    ['panel.example.com;reboot', false],
    ['', false],
    [`${'a'.repeat(64)}.example.com`, false],
  ])('valid_panel_domain %j = %s', (value, ok) => {
    expect(run('valid_panel_domain "$ND_VALUE"', [], { ...process.env, ND_VALUE: value }).status).toBe(ok ? 0 : 1);
  });

  it.each([
    ['you@example.com', true],
    ['first.last+certs@mail.example.org', true],
    ['you@example', false],
    ['you example.com', false],
    ['you@example.com\n$(id)', false],
    ['$(id)@example.com', false],
    ['"quoted"@example.com', false],
    ['', false],
  ])('valid_acme_email %j = %s', (value, ok) => {
    expect(run('valid_acme_email "$ND_VALUE"', [], { ...process.env, ND_VALUE: value }).status).toBe(ok ? 0 : 1);
  });

  it('env_file_set replaces a line or appends one, leaving the rest alone', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-env-'));
    try {
      writeFileSync(path.join(dir, '.env'), 'A=1\nNINEDEPLOY_DOMAIN=old.example.com\nB=2\n');
      const res = run('cd "$2" && env_file_set NINEDEPLOY_DOMAIN panel.example.com && env_file_set NINEDEPLOY_PUBLIC_IP 203.0.113.7', [fixtureBashPath(spawnSync, dir, bash)]);
      expect(res.status, res.stderr).toBe(0);
      const lines = readFileSync(path.join(dir, '.env'), 'utf8').trim().split('\n');
      expect(lines).toEqual(['A=1', 'B=2', 'NINEDEPLOY_DOMAIN=panel.example.com', 'NINEDEPLOY_PUBLIC_IP=203.0.113.7']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warn_domain_dns only warns, under set -euo pipefail, for every DNS answer', () => {
    // getent exits 2 for NXDOMAIN and for an AAAA-only name; a shell function
    // stands in for it so no real resolver is involved.
    const probe = (getent: string) =>
      run(`set -euo pipefail\ngetent() { ${getent}; }\ndetect_server_ip() { printf 203.0.113.7; }\nwarn_domain_dns panel.example.com\necho survived`);
    const nx = probe('return 2');
    expect(nx.stdout, nx.stderr).toContain('survived');
    expect(nx.stdout).toContain('does not resolve yet');
    const here = probe("printf '203.0.113.7     STREAM panel.example.com\\n'");
    expect(here.stdout).toContain('resolves to this server (203.0.113.7)');
    expect(here.stdout).toContain('survived');
    const elsewhere = probe("printf '198.51.100.9    STREAM panel.example.com\\n'");
    expect(elsewhere.stdout).toContain('resolves to 198.51.100.9');
    expect(elsewhere.stdout).toContain('survived');
  });

  it('prompt_panel_domain asks nothing without a terminal, during a self-update, or when the flag gave a domain', () => {
    const probe = 'PANEL_DOMAIN_ARG="$2"; ACME_EMAIL_ARG=""; prompt_panel_domain </dev/null; printf "[%s|%s]" "$PANEL_DOMAIN_ARG" "$ACME_EMAIL_ARG"';
    expect(run(probe, ['']).stdout).toBe('[|]');
    expect(run(probe, ['panel.example.com']).stdout).toBe('[panel.example.com|]');
    expect(run(probe, [''], { ...process.env, ND_SELF_UPDATE_TARGET: 'v1.2.3' }).stdout).toBe('[|]');
  });
});

describe('install.sh --domain/--email arguments', () => {
  // The validation runs right after argument parsing, before anything touches
  // the host: an invalid value stops the run there. The invalid --version is a
  // backstop checked just after it, so a validator that wrongly passed can
  // never let this test start a real install.
  const installer = (args: string[]) =>
    spawnSync(bash, [fixtureBashPath(spawnSync, installerFile, bash), ...args, '--version', 'not-a-version'], { encoding: 'utf8', timeout: 10000 });

  it('refuses an invalid domain or email before doing anything', () => {
    const badDomain = installer(['--domain', 'panel.example.com;reboot']);
    expect(badDomain.status).toBe(1);
    expect(badDomain.stdout).toContain('Invalid --domain');
    const badEmail = installer(['--email=not-an-address']);
    expect(badEmail.status).toBe(1);
    expect(badEmail.stdout).toContain('Invalid --email');
    // A bare trailing --domain fails while the arguments are parsed.
    const bare = spawnSync(bash, [fixtureBashPath(spawnSync, installerFile, bash), '--domain'], { encoding: 'utf8', timeout: 10000 });
    expect(bare.status).toBe(1);
    expect(bare.stdout).toContain('--domain requires a hostname');
  });

  it('wires the values into both install modes', () => {
    // Docker: written with upsert_env; the compose file passes them on.
    expect(sh).toContain('upsert_env NINEDEPLOY_DOMAIN "$PANEL_DOMAIN_ARG"');
    expect(sh).toContain('upsert_env NINEDEPLOY_ACME_EMAIL "$ACME_EMAIL_ARG"');
    expect(sh).toContain('upsert_env NINEDEPLOY_PUBLIC_URL "https://$PANEL_DOMAIN_ARG"');
    const compose = readFileSync(new URL('../../../docker-compose.prod.yml', import.meta.url), 'utf8');
    expect(compose).toContain('NINEDEPLOY_DOMAIN: ${NINEDEPLOY_DOMAIN:-}');
    expect(compose).toContain('NINEDEPLOY_PUBLIC_IP: ${NINEDEPLOY_PUBLIC_IP:-}');
    // Bare metal: env_file_set, and the https public URL only with an email.
    expect(sh).toContain('env_file_set NINEDEPLOY_DOMAIN "$PANEL_DOMAIN_ARG"');
    expect(sh).toContain('env_file_set NINEDEPLOY_ACME_EMAIL "$ACME_EMAIL_ARG"');
    expect(sh).toMatch(/if \[ -n "\$\{NINEDEPLOY_ACME_EMAIL:-\}" \]; then\n\s+env_file_set NINEDEPLOY_PUBLIC_URL "https:\/\/\$PANEL_DOMAIN_ARG"/);
    // The prompt runs on a first install only, in both modes.
    expect(sh).toContain('if [ "$fresh_env" = true ]; then prompt_panel_domain; fi');
    expect(sh).toContain('if [ ! -f ".env" ]; then prompt_panel_domain; fi');
    // Helpers are defined before the source-only guard, so CI can call them.
    const guard = sh.indexOf('if [ "${NINEDEPLOY_INSTALL_SOURCE_ONLY:-}" = "1" ]');
    for (const fn of ['valid_panel_domain', 'valid_acme_email', 'env_file_set', 'prompt_panel_domain', 'warn_domain_dns']) {
      expect(sh.indexOf(`\n${fn}() {`), fn).toBeGreaterThan(0);
      expect(sh.indexOf(`\n${fn}() {`), fn).toBeLessThan(guard);
    }
  });
});
