import type { NineDeployClient } from '@ninedeploy/sdk';

export async function firewallStatus(client: NineDeployClient): Promise<void> {
  try {
    const status = await client.firewall.status();
    console.log();
    console.log(`  \x1b[1mHost Firewall (UFW) Status:\x1b[0m ${status.active ? '\x1b[32mActive (Protecting)\x1b[0m' : '\x1b[33mInactive\x1b[0m'}`);
    console.log(`  \x1b[90mInstalled:\x1b[0m         ${status.installed ? 'yes' : 'no'}`);
    console.log(`  \x1b[90mDefault Policies:\x1b[0m  Incoming: ${status.defaultIncoming} | Outgoing: ${status.defaultOutgoing}`);
    console.log();

    if (status.rules && status.rules.length > 0) {
      console.log('  \x1b[1mActive Ingress & Port Rules:\x1b[0m');
      console.log(`  ${'-'.repeat(70)}`);
      console.log(`  ${'ID'.padEnd(5)} ${'To (Port)'.padEnd(20)} ${'Action'.padEnd(12)} ${'From'.padEnd(20)} Comment`);
      console.log(`  ${'-'.repeat(70)}`);
      for (const r of status.rules) {
        const actionColor = r.action.includes('ALLOW') ? '\x1b[32m' : '\x1b[31m';
        console.log(
          `  ${String(r.id).padEnd(5)} ${r.to.padEnd(20)} ${actionColor}${r.action.padEnd(12)}\x1b[0m ${r.from.padEnd(20)} ${r.comment || ''}`
        );
      }
      console.log(`  ${'-'.repeat(70)}`);
    } else {
      console.log('  \x1b[90mNo active port rules configured.\x1b[0m');
    }
    console.log();
  } catch (err) {
    console.error(`  \x1b[31m✗ Could not fetch firewall status:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export async function firewallToggle(client: NineDeployClient, enable: boolean): Promise<void> {
  try {
    await client.firewall.toggle(enable);
    console.log(`  \x1b[32m✓ Host firewall ${enable ? 'enabled' : 'disabled'}.\x1b[0m`);
  } catch (err) {
    console.error(`  \x1b[31m✗ Failed to toggle firewall:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export async function firewallAddRule(
  client: NineDeployClient,
  port: string,
  opts: { proto?: 'tcp' | 'udp' | 'any'; action?: 'allow' | 'deny' | 'limit'; from?: string; comment?: string }
): Promise<void> {
  try {
    await client.firewall.addRule({
      port,
      proto: opts.proto ?? 'tcp',
      action: opts.action ?? 'allow',
      from: opts.from,
      comment: opts.comment,
    });
    console.log(`  \x1b[32m✓ Rule added: ${opts.action ?? 'allow'} port ${port}/${opts.proto ?? 'tcp'}\x1b[0m`);
  } catch (err) {
    console.error(`  \x1b[31m✗ Failed to add firewall rule:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export async function firewallDeleteRule(client: NineDeployClient, id: string): Promise<void> {
  try {
    await client.firewall.deleteRule(id);
    console.log(`  \x1b[32m✓ Rule ${id} deleted.\x1b[0m`);
  } catch (err) {
    console.error(`  \x1b[31m✗ Failed to delete firewall rule:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export async function firewallApplyRecommended(client: NineDeployClient): Promise<void> {
  try {
    await client.firewall.applyRecommended();
    console.log('  \x1b[32m✓ Recommended VPS firewall profile applied (22 SSH, 80 HTTP, 443 HTTPS allowed; UFW enabled).\x1b[0m');
  } catch (err) {
    console.error(`  \x1b[31m✗ Failed to apply recommended firewall profile:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
