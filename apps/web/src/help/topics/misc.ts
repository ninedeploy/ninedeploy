import type { HelpTopic } from '../types.js';

export const MISC_TOPICS: Record<string, HelpTopic> = {
  general: {
    title: 'NineDeploy Help',
    summary:
      'NineDeploy is a self-hosted deployment panel: it builds your Git repositories or container images, ships them as zero-downtime blue-green Docker releases behind Traefik, and manages the databases, domains, backups, cron jobs and team access around them. This panel shows help for exactly where you are — press ? anywhere to reopen it.',
    sections: [
      {
        heading: 'Core concepts',
        bullets: [
          'Service — one deployable app. Its type is docker (containers), pm2 (host Node processes) or compose (docker compose stacks).',
          'Deployment — one build + release run. Every successful run records an exact image digest, which is what makes rollback instant and reliable.',
          'Blue-green release — the new container boots alongside the old one and only receives traffic after passing its health check. A failed release never touches the running version.',
          'Workspace / Project / Label — three independent, optional tagging dimensions on a service. Workspaces also carry team members and roles.',
          'Hub — the one-click template gallery for common open-source apps.',
          'Traefik — the single exposed entrypoint. All domains route through it; TLS certificates are issued automatically.',
        ],
      },
      {
        heading: 'Where things live',
        bullets: [
          'Deploy group: Hub (templates), Manifest Creator, Dashboard, Services.',
          'Organize group: Workspaces, Projects, Labels.',
          'Data group: Databases, Volumes, Backups.',
          'Network group: Domains, Traefik, Networks, Tunnels, Topology.',
          'System group: Monitoring, Settings, About (plus Activity, Docker, Sources, Servers, Users and Volumes for instance operators). Some entries only appear in Advanced mode.',
        ],
      },
      {
        heading: 'Getting started',
        steps: [
          'Sign in and follow the setup banner on the Dashboard.',
          'Operators add Git credentials on the Sources page (personal access token or SSH deploy key) — or skip this by deploying a template or a public image.',
          'Create a service (Services → New, or pick one in the Hub) and hit Deploy.',
          'Attach a domain on the service\'s Network tab and a managed database from the Databases page as needed.',
        ],
      },
      {
        heading: 'Getting unstuck',
        body: [
          'The docs/ folder inside your NineDeploy installation holds the full guides: manifest reference, private-repo walkthrough, Traefik ingress, databases & backups, RBAC, security/SSO and a symptom-based troubleshooting guide.',
          'The About page shows your version and the update channel; the Activity page is the full audit ledger of everything that happened.',
        ],
        tip: 'Press ? (or F1) on any page to reopen this help panel. The magnifier (⌘K / Ctrl+K) jumps to any page or service by name.',
      },
    ],
    related: [
      { label: 'Dashboard', helpId: 'dashboard' },
      { label: 'Deploying your first app (Services)', helpId: 'services' },
      { label: 'One-click templates (Hub)', helpId: 'hub' },
      { label: 'Git sources & webhooks', helpId: 'sources' },
    ],
  },
};
