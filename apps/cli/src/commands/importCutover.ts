/**
 * `ninedeploy import cutover <plan.json> [--yes]`
 *
 * A1 step 3, domain half (docs/plans/COMPETITIVE_ROADMAP_2026-11.md). Adds
 * each planned domain to the service `import apply` created, but only once
 * that service is ready and the hostname's DNS already points at this panel.
 *
 * - Ready means the service is `running` and its latest deployment is
 *   `running` (succeeded). It is not an HTTP probe of the app, and this
 *   command never deploys.
 * - The DNS gate resolves each host here, with a direct DNS query (not the
 *   OS cache or hosts file), and passes when every A/AAAA address is one this
 *   panel expects: --expect, else Settings → DNS records' content. It stays
 *   strict because adding a domain makes Traefik request a certificate, and
 *   Let's Encrypt limits failed validations per hostname.
 * - --skip-dns-check <host> is for records behind a proxy (Cloudflare's
 *   orange cloud resolves to Cloudflare). It is refused unless the panel's
 *   Cloudflare integration is known to be off: that integration POSTs a new
 *   A record on every domain add, which next to a record that still points
 *   at the source would split traffic between the two hosts.
 * - It never adds the source's own generated hosts (sourceDefault) and
 *   reports wildcard hosts for a person: HTTP-01 cannot issue them.
 * - The panel is the truth for what exists: every run lists the service's
 *   domains first, so a domain added by hand or by a run that stopped counts
 *   as done. A `pending` domain (ownership proof outstanding) is verified
 *   once its DNS passes; the TXT challenge is printed, never stored.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getClient, type NineDeployClient } from '../client.js';
import { loadConfig } from '../config.js';
import { c, error, header, info, success } from '../lib/format.js';
import type { ImportPlan, PlanDomain } from '../lib/importers/plan.js';
import { type ImportReceipt, type ReceiptItem, renderReceipt, validatePlan, writeReceipt } from './importApply.js';

/** The panel calls `import cutover` makes; NineDeployClient satisfies it. */
export interface CutoverClient {
  services: { get: (id: number) => Promise<{ status: string }> };
  deploys: { list: (serviceId: number) => Promise<Array<{ id: number; status: string }>> };
  domains: {
    list: NineDeployClient['domains']['list'];
    create: NineDeployClient['domains']['create'];
    verify: NineDeployClient['domains']['verify'];
  };
  settings: { dnsRecords: { get: () => Promise<{ enabled: boolean; content: string | null }> } };
}

export interface DnsLookup {
  resolve4: (host: string) => Promise<string[]>;
  resolve6: (host: string) => Promise<string[]>;
  /** The servers queried, for the report. */
  servers: () => string[];
}

export function dnsLookup(server?: string): DnsLookup {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  if (server) r.setServers([server]);
  return { resolve4: (h) => r.resolve4(h), resolve6: (h) => r.resolve6(h), servers: () => r.getServers() };
}

/** A and AAAA of a host; a name with no record of a type gives none of it. */
export async function resolveHost(dns: DnsLookup, host: string): Promise<string[]> {
  const none = (err: unknown) => {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [] as string[];
    throw err;
  };
  const [a, aaaa] = await Promise.all([dns.resolve4(host).catch(none), dns.resolve6(host).catch(none)]);
  return [...a, ...aaaa];
}

export type CloudflareState = 'on' | 'off' | 'unknown';
export interface Expected {
  addresses: string[];
  source: string;
  cloudflare: CloudflareState;
}

/**
 * The addresses a host must resolve to. --expect wins; else the content the
 * panel writes into DNS records (Settings → DNS records), an admin-only read.
 * A hostname (CNAME mode) is resolved here; the panel's own DNS check
 * compares it literally, so it can never match there.
 */
export async function expectedAddresses(client: CutoverClient, dns: DnsLookup, expect: string[]): Promise<Expected> {
  let settings: { enabled: boolean; content: string | null } | null = null;
  try {
    settings = await client.settings.dnsRecords.get();
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 401 && status !== 403) throw err;
  }
  const cloudflare: CloudflareState = settings ? (settings.enabled ? 'on' : 'off') : 'unknown';
  const wanted = expect.length > 0 ? expect : settings?.content ? [settings.content] : [];
  const source = expect.length > 0 ? '--expect' : 'Settings → DNS records';
  if (wanted.length === 0) {
    throw new Error(settings
      ? 'This panel has no DNS records address set (Settings → DNS records), so there is nothing to compare DNS with. Pass --expect <this panel\'s public IP>.'
      : 'Only an admin can read the panel\'s DNS records address. Pass --expect <this panel\'s public IP>.');
  }
  const addresses: string[] = [];
  for (const w of wanted) {
    if (isIP(w)) addresses.push(canonicalIp(w));
    else {
      const resolved = await resolveHost(dns, w);
      if (resolved.length === 0) throw new Error(`The expected address ${w} (${source}) does not resolve.`);
      addresses.push(...resolved.map(canonicalIp));
    }
  }
  return { addresses: [...new Set(addresses)], source: wanted.some((w) => !isIP(w)) ? `${source}, ${wanted.join(', ')} resolved` : source, cloudflare };
}

export interface CutoverOptions {
  yes: boolean;
  /** Hosts whose DNS gate is skipped (proxied records). */
  skipDnsCheck: string[];
}
export interface CutoverDeps {
  client: CutoverClient;
  dns: DnsLookup;
  expected: Expected;
  receipt: ImportReceipt;
  save: (receipt: ImportReceipt) => void;
  now?: () => Date;
}
export interface CutoverResult {
  lines: string[];
  added: number;
  waiting: number;
  failed: number;
}

const lower = (h: string) => h.toLowerCase().replace(/\.$/, '');

/** One spelling per address, so `2001:DB8:0::1` and `2001:db8::1` compare equal. */
export function canonicalIp(ip: string): string {
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

/**
 * Why a host's DNS is not ready for a certificate, or null. Every A and AAAA
 * must be this panel's: Let's Encrypt validates over IPv6 first when an AAAA
 * exists, so a leftover record that still names the source fails the
 * certificate even when another record already points here.
 */
export function dnsProblem(resolved: string[], expected: string[]): string | null {
  if (resolved.length === 0) return 'does not resolve';
  const stray = resolved.map(canonicalIp).filter((a) => !expected.includes(a));
  if (stray.length === 0) return null;
  const which = stray.map((a) => `${isIP(a) === 6 ? 'AAAA' : 'A'} ${a}`).join(', ');
  return stray.length === resolved.length
    ? `resolves to ${which}, not ${expected.join(', ')}`
    : `${which} ${stray.length === 1 ? 'is' : 'are'} not this panel (expected ${expected.join(', ')}): remove ${stray.length === 1 ? 'it' : 'them'}, or pass --expect with ${stray.length === 1 ? 'it' : 'them'} if ${stray.length === 1 ? 'it is' : 'they are'} this panel's`;
}

/** Check readiness and DNS for every planned domain; with yes, add or verify those that pass. */
export async function cutover(plan: ImportPlan, opts: CutoverOptions, deps: CutoverDeps): Promise<CutoverResult> {
  const { client, dns, expected, receipt } = deps;
  const now = deps.now ?? (() => new Date());
  const skip = new Set(opts.skipDnsCheck.map(lower));
  const out: string[] = [];
  const planned = new Set(plan.services.flatMap((s) => s.domains.map((d) => lower(d.host))));
  for (const h of skip) if (!planned.has(h)) out.push(`  ! --skip-dns-check ${h}: no planned domain has that host`);
  const res: CutoverResult = { lines: out, added: 0, waiting: 0, failed: 0 };
  const put = (item: Omit<ReceiptItem, 'at'>) => {
    receipt.items[`domain:${item.ref}`] = { ...item, at: now().toISOString() };
    deps.save(receipt);
  };

  for (const s of plan.services) {
    const hosts: PlanDomain[] = [];
    const seen = new Set<string>();
    for (const d of s.domains) {
      if (d.sourceDefault || seen.has(lower(d.host))) continue;
      seen.add(lower(d.host));
      hosts.push(d);
    }
    if (hosts.length === 0) continue;
    const created = receipt.items[`service:${s.ref}`];
    if (!created || created.state !== 'done' || created.id === undefined) {
      out.push(`  – ${s.name}: not created yet (run import apply first)`);
      res.waiting += hosts.length;
      continue;
    }
    const serviceId = created.id;
    const existing = new Map((await client.domains.list(serviceId)).map((d) => [lower(d.hostname), d]));
    const svc = await client.services.get(serviceId);
    const last = (await client.deploys.list(serviceId))[0];
    const ready = svc.status === 'running' && last?.status === 'running';
    out.push(`  ${s.name} (#${serviceId}): service ${svc.status}, last deploy ${last ? last.status : 'none'}`);

    for (const d of hosts) {
      const host = lower(d.host);
      const ref = `${s.ref}:${host}`;
      const row = existing.get(host);
      if (row?.status === 'active') {
        out.push(`    ✓ ${host}: added (#${row.id})`);
        const prev = receipt.items[`domain:${ref}`];
        if (opts.yes && (prev?.state !== 'done' || prev.id !== row.id)) put({ kind: 'domain', ref, name: host, state: 'done', id: row.id, notes: [] });
        continue;
      }
      if (host.startsWith('*.')) {
        out.push(`    – ${host}: a wildcard needs a DNS-01 certificate; add it by hand`);
        res.waiting++;
        continue;
      }
      if (!ready) {
        out.push(`    – ${host}: waits until the service runs a successful deploy (deploy it and check it first)`);
        res.waiting++;
        continue;
      }
      // DNS gate.
      let note: string | null = null;
      if (skip.has(host)) {
        if (expected.cloudflare !== 'off') {
          out.push(`    ✗ ${host}: --skip-dns-check refused: ${expected.cloudflare === 'on'
            ? 'the panel\'s Cloudflare integration is on and would add a second A record next to the source\'s'
            : 'only an admin can see whether the panel\'s Cloudflare integration is on (it would add a second A record next to the source\'s)'}`);
          res.waiting++;
          continue;
        }
        note = 'DNS check skipped (--skip-dns-check)';
      } else {
        const gate = dnsProblem(await resolveHost(dns, host), expected.addresses);
        if (gate) {
          out.push(`    ✗ ${host}: ${gate}; fix DNS first`);
          res.waiting++;
          continue;
        }
      }
      if (!opts.yes) {
        out.push(`    + ${host}: ${note ?? 'DNS points here'}; would ${row ? 'verify the pending domain' : `add it (${d.https ? 'https' : 'http'})`}`);
        continue;
      }
      const notes = note ? [note] : [];
      if (row) {
        // Pending ownership proof: verifying flips it live, so it waited for the gate too.
        let v: Awaited<ReturnType<CutoverClient['domains']['verify']>>;
        try {
          v = await client.domains.verify(serviceId, row.id);
        } catch (err) {
          out.push(`    ✗ ${host}: verify failed: ${err instanceof Error ? err.message : String(err)}`);
          res.failed++;
          continue;
        }
        if (v.verified) {
          if (v.dnsWarning) notes.push(`DNS provider: ${v.dnsWarning}`);
          put({ kind: 'domain', ref, name: host, state: 'done', id: row.id, notes });
          out.push(`    ✓ ${host}: verified and live (#${row.id})`);
          res.added++;
        } else {
          out.push(`    – ${host}: ownership not proven yet${v.error ? ` (${v.error})` : ''}`);
          if (v.verification) out.push(`        publish TXT ${v.verification.recordName} = ${v.verification.recordValue}, then run this again`);
          res.waiting++;
        }
        continue;
      }
      put({ kind: 'domain', ref, name: host, state: 'pending', notes });
      let made: Awaited<ReturnType<CutoverClient['domains']['create']>>;
      try {
        made = await client.domains.create(serviceId, { hostname: host, ssl: d.https });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        put({ kind: 'domain', ref, name: host, state: 'failed', notes: [...notes, msg] });
        out.push(`    ✗ ${host}: ${msg}`);
        res.failed++;
        continue;
      }
      if (made.dnsWarning) notes.push(`DNS provider: ${made.dnsWarning}`);
      if (made.status === 'pending') notes.push('ownership proof pending (TXT)');
      put({ kind: 'domain', ref, name: host, state: 'done', id: made.id, notes });
      // A pending domain is not routed yet: it waits for its TXT proof.
      if (made.status === 'pending') res.waiting++;
      else res.added++;
      out.push(`    ✓ ${host}: added (#${made.id}, ${made.status})`);
      if (made.verification) {
        out.push(`        publish TXT ${made.verification.recordName} = ${made.verification.recordValue}, then run this again to verify`);
      }
    }
  }
  return res;
}

export interface ImportCutoverOpts {
  receipt?: string;
  yes?: boolean;
  expect?: string[];
  resolver?: string;
  skipDnsCheck?: string[];
}

export async function importCutoverAction(
  planPath: string,
  opts: ImportCutoverOpts,
  deps: { client?: CutoverClient; panel?: string; dns?: DnsLookup } = {},
): Promise<void> {
  try {
    const plan = validatePlan(JSON.parse(readFileSync(planPath, 'utf8')));
    const receiptPath = opts.receipt ?? `${planPath.replace(/\.json$/i, '')}.receipt.json`;
    if (!existsSync(receiptPath)) throw new Error(`No receipt at ${receiptPath}: run \`ninedeploy import apply ${planPath} --yes\` first.`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as ImportReceipt;
    const panel = (deps.panel ?? loadConfig().baseUrl).replace(/\/+$/, '');
    if (receipt.panel !== panel) throw new Error(`The receipt is for ${receipt.panel}, but the CLI is signed in to ${panel}.`);
    if (opts.resolver && !isIP(opts.resolver)) throw new Error(`--resolver takes an IP address, got "${opts.resolver}".`);
    const client = deps.client ?? getClient();
    const dns = deps.dns ?? dnsLookup(opts.resolver);
    const expected = await expectedAddresses(client, dns, opts.expect ?? []);
    header(`Cutover into ${panel}`);
    info(`Expected address: ${expected.addresses.join(', ')} (${expected.source})`);
    info(`Resolver: ${dns.servers().join(', ') || 'system default'}`);
    if (expected.cloudflare === 'on') info('The Cloudflare integration is on: each domain added here also gets an A record created in Cloudflare.');
    const result = await cutover(plan, { yes: !!opts.yes, skipDnsCheck: opts.skipDnsCheck ?? [] }, {
      client, dns, expected, receipt, save: (r) => writeReceipt(receiptPath, r),
    });
    console.log(result.lines.length ? result.lines.join('\n') : '  No domains to move (the plan has none besides the source\'s own hosts).');
    if (!opts.yes) {
      info(`${c.dim('Nothing was added.')} Run again with --yes to add the domains marked +.`);
      return;
    }
    const items = Object.values(receipt.items).filter((i) => i.kind === 'domain');
    if (items.length) console.log(renderReceipt({ ...receipt, items: Object.fromEntries(items.map((i) => [`domain:${i.ref}`, i])) }));
    if (result.failed) error(`${result.failed} domain(s) failed. Fix the cause and run the same command again. Receipt: ${receiptPath}`);
    else if (result.waiting) info(`${result.added} added, ${result.waiting} waiting. Run the same command again once they are ready. Receipt: ${receiptPath}`);
    else success(`Done: every planned domain is on this panel. Receipt: ${receiptPath}`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
}
