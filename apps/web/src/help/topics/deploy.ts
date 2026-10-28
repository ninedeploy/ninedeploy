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
          'Click New Service and pick the origin: a Git repository (requires a Git credential — operators manage them on the Sources page) or a container image.',
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

  'settings.deploy-freeze': {
    title: 'Settings · Deploy freeze',
    summary:
      'Hold deploys during a release week, an incident or a holiday: the whole instance, a workspace, a project or an environment, with a reason and an optional end.',
    sections: [
      {
        heading: 'What a freeze does',
        bullets: [
          'Every deploy it covers waits in the queue, whatever started it: the UI, the API, a git push, a deploy hook, a schedule, an image poll or a rollback.',
          'The deploy log of a held deploy says which freeze holds it and why.',
          'When the freeze ends or is lifted, the held deploys start. Nothing is dropped.',
          'A workspace freeze also covers the services in its environments; a PR preview is covered through its parent service.',
        ],
        tip: 'To roll back during a freeze, lift it first: rollbacks are held too.',
      },
    ],
    related: [{ label: 'Service · Deploys tab', helpId: 'service.deploys' }],
  },

  'settings.gitops': {
    title: 'Settings · GitOps',
    summary:
      'The instance as one YAML file in a repository: projects, their services, domains and project grants. The panel shows what differs from the file, alerts when that changes, and applies the file on request.',
    sections: [
      {
        heading: 'The file',
        bullets: [
          'version: "1", then projects, each with slug, name, an optional workspace slug and description, services (slug, name, type, image or repoUrl and branch, port, domains) and grants (email and role).',
          'Fields you leave out are not managed. Secrets never belong in it: a file that looks like it holds one is refused.',
          'Export the panel as the file to start, or to write edits made in the panel back: commit the downloaded file.',
        ],
      },
      {
        heading: 'Drift and applying',
        bullets: [
          'Each difference is in the file only, in the panel only, or different. The panel reads the file on the interval you set, or when you press Check now.',
          'A new difference, or a file that cannot be read, is audited as alert.gitops_drift or alert.gitops_failed, which notifies the channels that receive alerts.',
          'Applying reads the file again and creates and updates through the ordinary API with your rights, so every check still applies. It never deletes: what is in the panel only stays until you remove it.',
        ],
      },
    ],
  },

  'settings.image-scanning': {
    title: 'Settings · Image scanning',
    summary:
      'Trivy scans the image of every docker deploy on the panel host before it gets traffic, and rescans running images on a schedule. Off by default.',
    sections: [
      {
        heading: 'How it works',
        bullets: [
          'Trivy runs in a throwaway container and reads the image from docker save; it never gets the Docker socket. Its vulnerability database is kept in the ninedeploy-trivy-cache volume.',
          'Each service shows its latest scan on its Deploys tab: counts by severity and the findings, most severe first.',
          'Running images are rescanned on the interval you set (default every 24 hours). New fixable critical findings are audited as image_scan.critical, which notifies the channels that receive audit events.',
          'Services on nodes, on Swarm and Compose stacks are not scanned yet.',
        ],
      },
      {
        heading: 'The deploy gate',
        bullets: [
          'Report only: scans never block.',
          'Block critical (or critical and high): a deploy whose new image has such findings fails before it gets traffic, and the previous release keeps serving.',
          'By default the gate counts only findings with a fixed version available, since a base image often carries CVEs that cannot be fixed.',
          'A scan that cannot run, for example with no network to update the database, never blocks a deploy; the deploy log says so.',
        ],
      },
    ],
    related: [{ label: 'Service · Deploys tab', helpId: 'service.deploys' }],
  },
};
