import type { KernelContext, KernelPlugin } from '../types.js';

export class CloudflareTunnelsPlugin implements KernelPlugin {
  readonly id = 'cloudflare-tunnels';
  readonly name = 'Cloudflare Zero Trust Tunnels';
  readonly version = '1.0.0';
  readonly description = 'Expose services securely to the internet without opening inbound firewall ports via Cloudflare Tunnel';
  readonly author = 'NineDeploy Core';
  readonly icon = 'ShieldCheck';
  readonly isOfficial = true;

  /**
   * No config keys.
   *
   * This plugin used to declare `account_id` and `tunnel_token` (the latter
   * marked `isSecret`, so the panel rendered a password field and encrypted
   * whatever was typed into it) — and nothing anywhere read either one. A
   * tunnel's credentials live per tunnel in the `tunnels` table: the Tunnels
   * page stores `tokenEncrypted` and `engine/tunnel.ts` hands it to the
   * cloudflared container through a 0600 env-file. An operator who pasted
   * their Zero Trust token into the plugin's field configured nothing, while
   * believing they had configured the tunnel runner.
   */
  readonly configSchema = [];

  readonly menuItems = [
    {
      id: 'cf-tunnels-nav',
      slot: 'sidebar:secondary' as const,
      label: 'Cloudflare Tunnels',
      route: '/tunnels',
      icon: 'Globe',
      order: 40,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    // Tap deploy after hook to verify route exposure
    const unhook = ctx.hooks.tap(
      'deploy.after',
      async (context) => {
        const deployCtx = context as { serviceId?: number; domain?: string };
        ctx.events.emit('tunnel.route_evaluated', {
          serviceId: deployCtx.serviceId,
          domain: deployCtx.domain,
        });
        return deployCtx;
      },
      { priority: 50 },
    );

    this.unsubs.push(unhook);
  }

  destroy(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }
}
