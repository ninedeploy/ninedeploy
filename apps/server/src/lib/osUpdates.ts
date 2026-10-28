import { OS_UPDATES_MAX, osUpdateStatus, type OsPendingUpdate, type OsUpdateStatus } from '@ninedeploy/schemas';
import { capture } from './exec.js';

/**
 * OS security updates (G4.2), shared by the panel host and the node agent.
 *
 * The panel reads a host's pending package updates, its automatic-update
 * setting and whether a reboot is pending, and can switch automatic SECURITY
 * updates on or off: unattended-upgrades on Debian/Ubuntu (whose default
 * origins are the security pockets), dnf-automatic with
 * `upgrade_type = security` on Fedora/RHEL. It never reboots a host, and
 * turns unattended-upgrades' own automatic reboot off explicitly.
 *
 * Every command runs on the host through a short-lived privileged helper
 * (`nsenter -t 1` into PID 1's namespaces, the same helper host shells use),
 * because the panel and the agent may themselves run in containers. The
 * scripts are fixed text chosen by an action name; nothing a caller sends
 * reaches a shell.
 */

export type OsUpdateAction = 'status' | 'refresh' | 'enable' | 'disable';
export const OS_UPDATE_ACTIONS: readonly OsUpdateAction[] = ['status', 'refresh', 'enable', 'disable'];

/** Reads everything as `key=value` lines. `R=1` refreshes the package lists first. */
const STATUS_SCRIPT = String.raw`
ID=unknown; VERSION_ID=; PRETTY_NAME=
if [ -r /etc/os-release ]; then . /etc/os-release; fi
echo "os=$ID"
echo "version=$VERSION_ID"
echo "name=$PRETTY_NAME"
if command -v apt-get >/dev/null 2>&1; then
  echo "pm=apt"
  if [ "$R" = 1 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || echo "warn=apt-get update failed"
  fi
  LC_ALL=C apt list --upgradable 2>/dev/null | sed -n 's#^\([^/ ]*\)/\([^ ]*\) \([^ ]*\) [^ ]* \[upgradable from: \([^]]*\)\]$#pkg=\1|\3|\4|\2#p'
  if dpkg -s unattended-upgrades 2>/dev/null | grep -q '^Status: install ok installed'; then echo "autoInstalled=1"; else echo "autoInstalled=0"; fi
  if apt-config dump 2>/dev/null | grep -q '^APT::Periodic::Unattended-Upgrade "1";'; then echo "autoEnabled=1"; else echo "autoEnabled=0"; fi
  if [ -f /var/run/reboot-required ]; then echo "reboot=1"; else echo "reboot=0"; fi
  if [ -f /var/run/reboot-required.pkgs ]; then sed 's/^/rebootPkg=/' /var/run/reboot-required.pkgs; fi
elif command -v dnf >/dev/null 2>&1; then
  echo "pm=dnf"
  if [ "$R" = 1 ]; then F=--refresh; else F=; fi
  dnf -q check-update $F 2>/dev/null | awk 'NF==3 && $1 ~ /\./ { print "pkg=" $1 "|" $2 "||" $3 }'
  dnf -q updateinfo list --security --available 2>/dev/null | awk 'NF>=3 { print "sec=" $NF }'
  if rpm -q dnf-automatic >/dev/null 2>&1 || rpm -q dnf5-plugin-automatic >/dev/null 2>&1; then echo "autoInstalled=1"; else echo "autoInstalled=0"; fi
  if systemctl is-enabled --quiet dnf-automatic.timer 2>/dev/null || systemctl is-enabled --quiet dnf5-automatic.timer 2>/dev/null; then echo "autoEnabled=1"; else echo "autoEnabled=0"; fi
  # Exit 1 means "reboot needed" only when the command exists: a missing dnf
  # plugin exits 1 as well, so it is probed with --help first.
  if command -v needs-restarting >/dev/null 2>&1; then NR=needs-restarting
  elif dnf needs-restarting --help >/dev/null 2>&1; then NR="dnf needs-restarting"
  else NR=; fi
  if [ -n "$NR" ]; then
    $NR -r >/dev/null 2>&1
    if [ $? = 1 ]; then echo "reboot=1"; else echo "reboot=0"; fi
  else
    echo "reboot=unknown"
  fi
else
  echo "pm=unsupported"
fi
`;

/** Automatic security updates on; unattended-upgrades must never reboot by itself. */
const ENABLE_SCRIPT = String.raw`
set -e
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  if ! dpkg -s unattended-upgrades 2>/dev/null | grep -q '^Status: install ok installed'; then
    apt-get update -qq
    apt-get install -y -qq unattended-upgrades
  fi
  printf '%s\n' '// Written by NineDeploy: install security updates automatically.' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
  printf '%s\n' '// Written by NineDeploy: never reboot on its own.' 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/52ninedeploy-no-reboot
elif command -v dnf >/dev/null 2>&1; then
  if ! rpm -q dnf-automatic >/dev/null 2>&1 && ! rpm -q dnf5-plugin-automatic >/dev/null 2>&1; then
    dnf -y -q install dnf-automatic || dnf -y -q install dnf5-plugin-automatic
  fi
  if [ -f /etc/dnf/automatic.conf ]; then
    sed -i -e 's/^upgrade_type[[:space:]]*=.*/upgrade_type = security/' -e 's/^apply_updates[[:space:]]*=.*/apply_updates = yes/' /etc/dnf/automatic.conf
    grep -q '^upgrade_type' /etc/dnf/automatic.conf || sed -i 's/^\[commands\]/[commands]\nupgrade_type = security/' /etc/dnf/automatic.conf
    grep -q '^apply_updates' /etc/dnf/automatic.conf || sed -i 's/^\[commands\]/[commands]\napply_updates = yes/' /etc/dnf/automatic.conf
  else
    printf '%s\n' '[commands]' 'upgrade_type = security' 'apply_updates = yes' 'reboot = never' > /etc/dnf/automatic.conf
  fi
  if systemctl list-unit-files dnf5-automatic.timer >/dev/null 2>&1 && systemctl list-unit-files dnf5-automatic.timer | grep -q dnf5-automatic; then
    systemctl enable --now dnf5-automatic.timer
  else
    systemctl enable --now dnf-automatic.timer
  fi
else
  echo "This host has neither apt nor dnf." >&2
  exit 3
fi
`;

/** Automatic updates off; the package stays installed. */
const DISABLE_SCRIPT = String.raw`
set -e
if command -v apt-get >/dev/null 2>&1; then
  printf '%s\n' '// Written by NineDeploy: automatic updates are off.' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "0";' > /etc/apt/apt.conf.d/20auto-upgrades
elif command -v dnf >/dev/null 2>&1; then
  systemctl disable --now dnf-automatic.timer 2>/dev/null || true
  systemctl disable --now dnf5-automatic.timer 2>/dev/null || true
else
  echo "This host has neither apt nor dnf." >&2
  exit 3
fi
`;

/** The fixed script for an action. */
export function osUpdateScript(action: OsUpdateAction): string {
  switch (action) {
    case 'status':
      return `R=0\n${STATUS_SCRIPT}`;
    case 'refresh':
      return `R=1\n${STATUS_SCRIPT}`;
    case 'enable':
      return ENABLE_SCRIPT;
    case 'disable':
      return DISABLE_SCRIPT;
  }
}

/** `docker run` arguments that run `script` on the host (PID 1's namespaces) with `image`. */
export function hostScriptArgs(image: string, script: string): string[] {
  return [
    'run',
    '--rm',
    '--privileged',
    '--pid=host',
    '--net=host',
    '--ipc=host',
    '--uts=host',
    '--label',
    'ninedeploy.os-updates=1',
    '--entrypoint',
    'nsenter',
    image,
    '-t',
    '1',
    '-m',
    '-u',
    '-i',
    '-n',
    '-p',
    '--',
    '/bin/sh',
    '-c',
    script,
  ];
}

/** How long one action may take (an install can download packages). */
export const OS_UPDATE_TIMEOUT_MS = 8 * 60 * 1000;

/** Run an action on the host through `image`; resolves the status read afterwards. */
export async function runOsUpdateAction(image: string, action: OsUpdateAction, now: Date = new Date()): Promise<OsUpdateStatus> {
  const run = (script: string) => capture('docker', hostScriptArgs(image, script), { timeoutMs: OS_UPDATE_TIMEOUT_MS });
  if (action === 'enable' || action === 'disable') await run(osUpdateScript(action));
  const out = await run(osUpdateScript(action === 'refresh' ? 'refresh' : 'status'));
  return parseOsStatus(out, now);
}

const clip = (s: string, n = 200) => s.trim().slice(0, n);

/** Parse the status script's `key=value` lines. Unknown keys are ignored; the result is schema-checked. */
export function parseOsStatus(out: string, now: Date = new Date()): OsUpdateStatus {
  const os = { id: 'unknown', version: '', name: '' };
  let pm: OsUpdateStatus['packageManager'] = 'unsupported';
  const updates: OsPendingUpdate[] = [];
  const dnfSecurity: string[] = [];
  let total = 0;
  let installed = false;
  let enabled = false;
  let reboot: boolean | null = null;
  const rebootPackages: string[] = [];
  const warnings: string[] = [];

  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      case 'os':
        os.id = clip(value, 64) || 'unknown';
        break;
      case 'version':
        os.version = clip(value, 64);
        break;
      case 'name':
        os.name = clip(value);
        break;
      case 'pm':
        pm = value === 'apt' || value === 'dnf' ? value : 'unsupported';
        break;
      case 'pkg': {
        const [name = '', version = '', from = '', origin = ''] = value.split('|');
        if (!name || !version) break;
        total += 1;
        if (updates.length < OS_UPDATES_MAX) {
          // apt: the suites the version comes from ("jammy-updates,jammy-security").
          const security = pm === 'apt' && origin.split(',').some((s) => /-security$/.test(s.trim()));
          updates.push({ name: clip(name), version: clip(version), from: from ? clip(from) : null, security });
        }
        break;
      }
      case 'sec':
        if (dnfSecurity.length < 5000) dnfSecurity.push(value.trim());
        break;
      case 'autoInstalled':
        installed = value === '1';
        break;
      case 'autoEnabled':
        enabled = value === '1';
        break;
      case 'reboot':
        reboot = value === '1' ? true : value === '0' ? false : null;
        break;
      case 'rebootPkg':
        if (rebootPackages.length < 200 && value.trim()) rebootPackages.push(clip(value));
        break;
      case 'warn':
        if (warnings.length < 20) warnings.push(clip(value));
        break;
    }
  }

  // dnf: `check-update` names packages `name.arch`; security advisories list NEVRAs (`name-[epoch:]version-release.arch`).
  if (pm === 'dnf' && dnfSecurity.length > 0) {
    for (const u of updates) {
      const dot = u.name.lastIndexOf('.');
      const base = dot > 0 ? u.name.slice(0, dot) : u.name;
      const arch = dot > 0 ? u.name.slice(dot + 1) : '';
      u.security = dnfSecurity.some((nevra) => nevra.startsWith(`${base}-`) && /^\d/.test(nevra.slice(base.length + 1).replace(/^\d+:/, '')) && (!arch || nevra.endsWith(`.${arch}`)));
    }
  }

  return osUpdateStatus.parse({
    os,
    packageManager: pm,
    updates,
    updatesTruncated: total > updates.length,
    securityCount: updates.filter((u) => u.security).length,
    autoUpdates: { installed, enabled: installed && enabled },
    rebootRequired: pm === 'unsupported' ? null : reboot,
    rebootPackages,
    warnings,
    checkedAt: now.toISOString(),
  });
}
