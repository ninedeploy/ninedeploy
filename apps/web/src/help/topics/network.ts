import type { HelpTopic } from '../types.js';

export const NETWORK_TOPICS: Record<string, HelpTopic> = {
  domains: {
    title: 'Domains',
    summary:
      'The global inventory of every hostname routed by this panel, across all services — with certificate status and quick SSL controls. Per-domain routing rules live on each service\'s Network tab.',
    sections: [
      {
        heading: 'What this page is for',
        bullets: [
          'Answer "which service is this domain on?" without hunting through services.',
          'Check certificate state: issued, pending or failed, per hostname.',
          'Spot orphans — domains pointing at services that no longer exist.',
        ],
      },
      {
        heading: 'Adding domains the right way',
        steps: [
          'Open the service → Network & Domains tab and add the hostname there.',
          'Point DNS at this server (or let the panel create a Cloudflare record automatically).',
          'TLS is issued automatically; the domain then appears in this list with its owner.',
        ],
        tip: 'A domain showing "pending" for a long time almost always means DNS does not yet point at this server — the HTTP-01 challenge cannot complete until it does.',
      },
    ],
    related: [
      { label: 'Service · Network & domains', helpId: 'service.network' },
      { label: 'Traefik status', helpId: 'traefik' },
    ],
  },

  traefik: {
    title: 'Traefik',
    summary:
      'The control page for Traefik, the panel\'s single exposed reverse proxy: version and status, the certificate list, dynamic configuration, logs and a restart control. Every domain on the panel routes through it.',
    sections: [
      {
        heading: 'When to use this page',
        bullets: [
          'A domain 404s — inspect the dynamic config to see whether a router exists for the host.',
          'Certificate issues — the cert list shows what was issued for which domain and when.',
          'After low-level changes — a controlled restart picks up config cleanly.',
        ],
      },
      {
        heading: 'Restarting Traefik',
        body: [
          'Restarting drops all inbound traffic for a few seconds — every service on the panel is unreachable while it comes back. Prefer config changes that Traefik hot-reloads; keep restarts for genuine trouble.',
        ],
        tip: 'The dashboard is the wrong place to add routes: domains and middlewares are managed per service, and Traefik config here is generated from them.',
      },
    ],
    related: [
      { label: 'Domains', helpId: 'domains' },
      { label: 'Service · Network & domains', helpId: 'service.network' },
      { label: 'Tunnels (Cloudflare)', helpId: 'tunnels' },
    ],
  },

  networks: {
    title: 'Networks',
    summary:
      'The Docker networks on this host: the shared ninedeploy network that Traefik and your services use, plus any user-created networks you can attach services to.',
    sections: [
      {
        heading: 'How the panel uses networks',
        bullets: [
          'The ninedeploy network is created and managed by the panel — Traefik is the only container published to the host, and it reaches everything over this network.',
          'Create a user network to let two services talk to each other privately (e.g. an app and a cache) without exposing ports.',
          'Attach services to extra networks from their settings; the Architecture tab visualises the result.',
        ],
        tip: 'Keep host-published ports to a minimum: service-to-service traffic over a shared Docker network never leaves the host.',
      },
    ],
    related: [
      { label: 'Topology', helpId: 'topology' },
      { label: 'Docker page', helpId: 'docker' },
    ],
  },

  tunnels: {
    title: 'Tunnels (Cloudflare)',
    summary:
      'Manage cloudflared tunnels: expose services publicly through Cloudflare without opening any inbound ports on this server — useful behind NAT, strict firewalls or for zero-trust setups.',
    sections: [
      {
        heading: 'Creating a tunnel',
        steps: [
          'Connect your Cloudflare account (the built-in guided setup walks through the token and zone selection).',
          'Create the tunnel; the panel runs the cloudflared connector for you.',
          'Map public hostnames to local services; Cloudflare routes visitor traffic through the tunnel to Traefik.',
        ],
      },
      {
        heading: 'Good to know',
        bullets: [
          'No port forwarding is needed — outbound-only connection to Cloudflare\'s edge.',
          'Certificates for tunnelled hostnames are handled by Cloudflare\'s edge, not by local ACME.',
          'Deleting a tunnel tears down the connector; the DNS records it created at Cloudflare are removed with it.',
        ],
        tip: 'Combining tunnels with per-domain basic auth or IP allowlists (service → Network tab) gives you a quick private-by-Internet, public-by-tunnel setup.',
      },
    ],
    related: [
      { label: 'Domains', helpId: 'domains' },
      { label: 'Traefik', helpId: 'traefik' },
    ],
  },

  topology: {
    title: 'Topology',
    summary:
      'The instance-wide graph: every service, database, domain and volume, and the wiring between them through Traefik and Docker networks.',
    sections: [
      {
        heading: 'Using it',
        bullets: [
          'Click a node to jump to the underlying page (service, database or domain).',
          'Edges show real dependencies — what talks to what, and what would break if a node went away.',
          'Per-service detail graphs live on the service\'s Architecture tab.',
        ],
        tip: 'Before deleting a database or volume, find it here first — the attached services are your blast radius.',
      },
    ],
    related: [
      { label: 'Service · Architecture', helpId: 'service.architecture' },
      { label: 'Networks', helpId: 'networks' },
    ],
  },
};
