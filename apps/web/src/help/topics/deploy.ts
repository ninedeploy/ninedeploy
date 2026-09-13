import type { HelpTopic } from '../types.js';

export const DEPLOY_TOPICS: Record<string, HelpTopic> = {
  dashboard: {
    title: 'Dashboard',
    summary:
      'The landing overview of the whole instance: service status at a glance, live host resources, recent deployments and the latest audit events — the fastest place to answer "is everything healthy?"',
    sections: [
      {
        heading: 'What you see here',
        bullets: [
          'Service tiles with their current state: idle, deploying, running, stopped or error.',
          'Host CPU, memory and disk gauges for this node (and agent nodes, when configured).',
          'The most recent deployments with their trigger and status; failed ones link straight to their build logs.',
          'Quick links into the Deploy group: Hub for templates, Services for the full inventory.',
        ],
      },
      {
        heading: 'Typical next steps',
        steps: [
          'Scan for red/error tiles or failed deploys — open the service and check its Deploys tab.',
          'Use ⌘K / Ctrl+K to jump to any service or page by name.',
          'Watch the setup banner at the top until every recommended step is done.',
        ],
      },
      {
        heading: 'Live events',
        body: [
          'The dashboard numbers refresh on a polling interval. For a real-time stream of audit events (deploys, deletes, logins), click the pulse icon in the top-right header — it opens the live events drawer.',
        ],
        tip: 'Persistent high memory on the gauges? Set CPU/memory limits on the service (Service → Settings) and check the Monitoring page for history.',
      },
    ],
    related: [
      { label: 'Services list', helpId: 'services' },
      { label: 'Monitoring & metrics', helpId: 'monitoring' },
      { label: 'Audit ledger (Activity)', helpId: 'activity' },
    ],
  },

  hub: {
    title: 'Hub — 1-Click Templates',
    summary:
      'The template gallery: a curated registry of popular open-source apps that NineDeploy can stand up in a single confirmation — image, port, env scaffolding and database wiring already figured out.',
    sections: [
      {
        heading: 'Deploying a template',
        steps: [
          'Search or filter the gallery, then open a template card to review what will run.',
          'Confirm the suggested service name (and overrides if you need them).',
          'Hit Deploy. NineDeploy pulls the image, creates the service and boots it like any other release.',
          'Open the new service to attach a domain or tweak env vars — a template URL is assigned automatically if your panel is configured for it.',
        ],
      },
      {
        heading: 'Templates that need a database',
        body: [
          'Database-backed templates declare their dependency. On deploy, NineDeploy can provision the matching managed engine (Postgres, MySQL, Redis, Mongo, …) from the Databases page and inject the connection string into the service as environment variables.',
        ],
      },
      {
        heading: 'Custom registries',
        body: [
          'The built-in registry ships with the panel. Operators can point NineDeploy at a custom template source (Settings → Integrations); the fetched registry is cached for a few hours.',
        ],
        tip: 'Everything a template creates is a normal service — you can edit its env, domains, volumes and build config afterwards like anything else.',
      },
    ],
    related: [
      { label: 'Services list', helpId: 'services' },
      { label: 'Managed databases', helpId: 'databases' },
      { label: 'Manifest Creator', helpId: 'manifest-creator' },
    ],
  },

  'manifest-creator': {
    title: 'Manifest Creator',
    summary:
      'A guided editor for the .ninedeploy manifest — the declarative file that describes how a repository is built, run, exposed and resourced. Generate a correct manifest here, then commit it to the repo root so every service using that repo behaves the same.',
    sections: [
      {
        heading: 'How to use it',
        steps: [
          'Start from one of the presets (Node, Next.js, FastAPI, Django, Go, Rust, Rails, Laravel, Java, monorepo, worker, API + database) or blank.',
          'Walk the grouped sections — Core, Build pipeline, Operations, Traffic, Observability. The sidebar tracks how much you have configured.',
          'Already have a .ninedeploy file? Use Import to paste or upload it — it is validated with the same schema the deploy pipeline uses and loaded into the form.',
          'Every change is undoable (Undo / Redo in the header), and the draft survives page reloads.',
          'Use the live validation banner and the secret-scan feedback to catch mistakes before committing.',
          'Copy or download the YAML and commit it as .ninedeploy in the repository root.',
        ],
      },
      {
        heading: 'What the manifest controls',
        bullets: [
          'Runtime type and start command; build pack (Nixpacks or Dockerfile) with install/build commands.',
          'Environment variables and secret references.',
          'Domains and edge middlewares; static site routing.',
          'CPU/memory resources and restart policy.',
          'Pre/post-deploy and pre-stop hooks (release commands, migrations).',
          'Watch paths for auto-deploys and PR preview settings.',
        ],
      },
      {
        heading: 'Where it takes effect',
        body: [
          'Services pick up the manifest from the repository on their next deploy. The service\'s "Manifest & Traefik" tab shows the effective file, so you can verify what actually applied.',
        ],
        tip: 'A manifest is optional — services configured purely through the UI keep working; the manifest just makes the setup reproducible in the repo.',
      },
    ],
    related: [
      { label: 'Service · Manifest & Traefik tab', helpId: 'service.manifest' },
      { label: 'Service · Deploys', helpId: 'service.deploys' },
    ],
  },

  services: {
    title: 'Services',
    summary:
      'The inventory of every service this panel manages, across all workspaces and projects you can see — with live status, tags and quick actions. This is where new services are created.',
    sections: [
      {
        heading: 'Creating a service',
        steps: [
          'Click New Service and pick the origin: a Git repository (requires a credential from the Sources page) or a container image.',
          'For Git: choose the repository, branch and — if auto-detection needs help — the build pack and commands.',
          'Review the summary and create. The first Deploy builds the image and starts the blue-green release.',
        ],
      },
      {
        heading: 'Filtering the list',
        body: [
          'The chips in the top bar filter by workspace, project and label. Within one chip group matches are OR-ed; different groups are AND-ed. The selection persists per browser.',
        ],
      },
      {
        heading: 'Status meanings',
        bullets: [
          'idle — created but never deployed.',
          'deploying — a build or release is in flight (blue-green: old version keeps serving).',
          'running — healthy container behind Traefik.',
          'stopped — container exists but is not running.',
          'error — last deploy or health check failed; the previous release is still live.',
          'deleting — teardown in progress.',
        ],
        tip: 'A service stuck in "deploying" for a long time is usually waiting on the health check — check its Deploys tab and health path in Settings.',
      },
    ],
    related: [
      { label: 'Service · Deploys tab', helpId: 'service.deploys' },
      { label: 'Git sources & webhooks', helpId: 'sources' },
      { label: 'Templates (Hub)', helpId: 'hub' },
    ],
  },
};
