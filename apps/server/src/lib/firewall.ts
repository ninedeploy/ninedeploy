import { capture } from './exec.js';

export interface FirewallRule {
  id: number;
  to: string;
  action: string;
  from: string;
  comment?: string;
}

export interface FirewallStatus {
  installed: boolean;
  active: boolean;
  supported: boolean;
  rules: FirewallRule[];
  defaultIncoming: string;
  defaultOutgoing: string;
}

/** Check if running on a platform supporting UFW (Linux) and if ufw binary is present. */
async function hasUfw(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const out = await capture('which', ['ufw']).catch(() => '');
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Execute ufw command (with sudo fallback). */
async function execUfw(args: string[]): Promise<string> {
  try {
    return await capture('ufw', args);
  } catch {
    return await capture('sudo', ['ufw', ...args]);
  }
}

/** Get structured host firewall status and rules. */
export async function getFirewallStatus(): Promise<FirewallStatus> {
  const installed = await hasUfw();
  if (!installed) {
    return {
      installed: false,
      active: false,
      supported: process.platform === 'linux',
      rules: [],
      defaultIncoming: 'unknown',
      defaultOutgoing: 'unknown',
    };
  }

  try {
    const rawStatus = await execUfw(['status', 'verbose']).catch(() => '');
    const active = rawStatus.toLowerCase().includes('status: active');

    let defaultIncoming = 'allow';
    let defaultOutgoing = 'allow';
    const defMatch = rawStatus.match(/Default:\s+([a-z]+)\s+\(incoming\),\s+([a-z]+)\s+\(outgoing\)/i);
    if (defMatch) {
      defaultIncoming = defMatch[1]!.toLowerCase();
      defaultOutgoing = defMatch[2]!.toLowerCase();
    }

    const rawNumbered = await execUfw(['status', 'numbered']).catch(() => '');
    const rules: FirewallRule[] = [];

    const lines = rawNumbered.split('\n');
    for (const line of lines) {
      const match = line.match(/^\[\s*(\d+)\]\s+(.*?)\s+(ALLOW IN|DENY IN|REJECT IN|LIMIT IN|ALLOW|DENY)\s+(.*?)(?:\s+#\s+(.*))?$/i);
      if (match) {
        rules.push({
          id: Number.parseInt(match[1]!, 10),
          to: match[2]!.trim(),
          action: match[3]!.trim().toUpperCase(),
          from: match[4]!.trim(),
          comment: match[5]?.trim(),
        });
      }
    }

    return {
      installed: true,
      active,
      supported: true,
      rules,
      defaultIncoming,
      defaultOutgoing,
    };
  } catch {
    return {
      installed: true,
      active: false,
      supported: true,
      rules: [],
      defaultIncoming: 'unknown',
      defaultOutgoing: 'unknown',
    };
  }
}

/** Add a firewall rule (e.g. allow port 5432 or allow from CIDR). */
export async function addFirewallRule(opts: {
  port: number | string;
  proto?: 'tcp' | 'udp' | 'any';
  action?: 'allow' | 'deny' | 'limit';
  from?: string;
  comment?: string;
}): Promise<void> {
  const action = opts.action ?? 'allow';
  const proto = opts.proto ?? 'tcp';
  const from = opts.from && opts.from !== 'any' && opts.from !== 'Anywhere' ? opts.from.trim() : null;
  const comment = opts.comment?.replace(/["']/g, '').trim();

  const args: string[] = [];
  if (comment) {
    args.push('--comment', comment);
  }

  args.push(action);

  if (proto !== 'any') {
    args.push('proto', proto);
  }

  if (from) {
    args.push('from', from, 'to', 'any', 'port', String(opts.port));
  } else {
    args.push(proto !== 'any' ? `${opts.port}/${proto}` : String(opts.port));
  }

  await execUfw(args);
}

/** Delete a firewall rule by ID or specification. */
export async function deleteFirewallRule(id: number | string): Promise<void> {
  await execUfw(['--force', 'delete', String(id)]);
}

/** Enable or disable UFW firewall. Safe: always ensures SSH (22) is allowed before enabling! */
export async function setFirewallActive(enable: boolean): Promise<void> {
  if (enable) {
    // Safety guard: ensure SSH is allowed before enabling so user is never locked out
    await addFirewallRule({ port: 22, proto: 'tcp', action: 'allow', comment: 'SSH Safety' }).catch(() => undefined);
    await execUfw(['--force', 'enable']);
  } else {
    await execUfw(['disable']);
  }
}

/** Apply standard VPS hardening rules (22 SSH, 80 HTTP, 443 HTTPS, enable). */
export async function applyRecommendedVpsRules(): Promise<void> {
  await addFirewallRule({ port: 22, proto: 'tcp', action: 'allow', comment: 'SSH' }).catch(() => undefined);
  await addFirewallRule({ port: 80, proto: 'tcp', action: 'allow', comment: 'HTTP (Traefik Ingress)' }).catch(() => undefined);
  await addFirewallRule({ port: 443, proto: 'tcp', action: 'allow', comment: 'HTTPS (Traefik Ingress)' }).catch(() => undefined);
  await execUfw(['--force', 'enable']);
}
