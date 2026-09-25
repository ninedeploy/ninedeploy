import type { HelpTopic } from '../types.js';

// Written with unicode escapes (repo convention — see EnvCard.tsx) so the
// literal `${{…}}` vault syntax does not trip lint/suspicious/noTemplateCurlyInString.
const REF_INFISICAL = '\u0024\u007B\u007Binfisical:KEY\u007D\u007D';
const REF_DOPPLER = '\u0024\u007B\u007Bdoppler:KEY\u007D\u007D';

/** Help topics for the 14 tabs of a single service (/services/:id?tab=…). */
export const SERVICE_TAB_TOPICS: Record<string, HelpTopic> = {
  'service.overview': {
    title: 'Service · Overview',
    summary:
      'The landing tab of one service: live container state, health and resource usage, quick actions, its tags and the latest deployment status — everything for the daily "is it up and is it okay?" check.',
    sections: [
      {
        heading: 'Quick actions',
        bullets: [
          'Start / Stop / Restart control the current container without a rebuild.',
          'Deploy kicks off a new build + release (see the Deploys tab for history and rollback).',
          'The URL chip opens the service through its assigned domain, when one is attached.',
        ],
      },
      {
        heading: 'Reading this tab',
        bullets: [
          'Status mirrors the container: running, stopped, deploying, error or idle.',
          'Resource gauges show the container\'s live CPU/memory against its limits.',
          'The tags card manages workspace / project / label membership for filtering.',
        ],
      },
      {
        heading: 'If something looks wrong',
        steps: [
          'Check the Deploys tab — did the latest run fail, and why (build log)?',
          'Open the Activity Logs tab for the container\'s runtime output.',
          'Verify the health check path in Settings matches an endpoint that answers 2xx.',
        ],
        tip: 'Blue-green deploys keep the previous release serving when a new one fails — an "error" service is often still reachable on its old version.',
      },
    ],
    related: [
      { label: 'Service · Deploys', helpId: 'service.deploys' },
      { label: 'Service · Activity logs', helpId: 'service.activity' },
      { label: 'Monitoring', helpId: 'monitoring' },
    ],
  },

  'service.terminal': {
    title: 'Service · Terminal & Exec',
    summary:
      'An interactive shell into the running container, plus one-off command execution — for debugging inside the exact environment your app runs in. Operator-only, and every session is written to the audit ledger.',
    sections: [
      {
        heading: 'Opening a shell',
        steps: [
          'Make sure the service is running — exec needs a live container.',
          'Click Open Terminal; a PTY attaches to the container.',
          'Work as usual; the session runs as the container\'s own user and filesystem.',
        ],
      },
      {
        heading: 'Good to know',
        bullets: [
          'The terminal shows the container\'s filesystem — changes are lost on the next deploy unless they are on a volume.',
          'pm2-type services execute on the host Node process instead of a container.',
          'Sessions are audited; who ran what is visible on the Activity page.',
        ],
        tip: 'For non-interactive fixes (e.g. clearing a cache path), a one-off exec command is often cleaner than an interactive shell.',
      },
    ],
    related: [
      { label: 'Service · File browser', helpId: 'service.files' },
      { label: 'Audit ledger (Activity)', helpId: 'activity' },
    ],
  },

  'service.architecture': {
    title: 'Service · Architecture',
    summary:
      'A visual map of this service\'s runtime topology: its containers, the networks they sit on, attached volumes and how Traefik routes traffic to them.',
    sections: [
      {
        heading: 'Using the graph',
        bullets: [
          'Follow the arrows from the internet through Traefik to the running container.',
          'Volume nodes show what persists across deploys; database nodes show managed engines attached to this service.',
          'The instance-wide picture (every service at once) lives on the Topology page.',
        ],
      },
    ],
    related: [
      { label: 'Instance topology', helpId: 'topology' },
      { label: 'Service · Volumes', helpId: 'service.volumes' },
      { label: 'Service · Network & domains', helpId: 'service.network' },
    ],
  },

  'service.manifest': {
    title: 'Service · Manifest & Traefik',
    summary:
      'The service\'s effective .ninedeploy manifest and the generated Traefik routing configuration — the ground truth of how this service is built and exposed right now.',
    sections: [
      {
        heading: 'Reading it',
        bullets: [
          'The manifest is what the panel reads from the repository (if the repo ships one); UI-only services show the config they were created with.',
          'The Traefik section shows the dynamic routing rules derived from the service\'s domains and middlewares.',
        ],
      },
      {
        heading: 'Changing it',
        steps: [
          'Edit the manifest here (or in the repo with the Manifest Creator) and save.',
          'Redeploy — manifest changes apply on the next release, never mid-flight.',
          'Re-open this tab to confirm the effective file updated.',
        ],
        tip: 'Treat this tab as the source of truth when the service behaves differently than the UI settings suggest — overrides and repo manifests show up here.',
      },
    ],
    related: [
      { label: 'Manifest Creator', helpId: 'manifest-creator' },
      { label: 'Service · Network & domains', helpId: 'service.network' },
    ],
  },

  'service.compose': {
    title: 'Service · Compose File',
    summary:
      'The YAML of an inline compose stack — the stack you pasted when creating the service. Only shown for inline stacks; a git-repo compose service keeps its file in the repository.',
    sections: [
      {
        heading: 'Editing the stack',
        steps: [
          'Edit the YAML and press Save — the server validates it with the same preflight the create wizard runs.',
          'Press Save & redeploy (or redeploy later) — running containers only change on the next deploy.',
        ],
        tip: 'The routed compose service must still be declared in the file, or the save is refused.',
      },
    ],
    related: [
      { label: 'Service · Deploys', helpId: 'service.deploys' },
      { label: 'Service · Manifest & Traefik', helpId: 'service.manifest' },
    ],
  },

  'service.deploys': {
    title: 'Service · Deploys',
    summary:
      'The deployment history: every build + release run with its trigger (manual, webhook, CLI or schedule), status, duration and the exact image digest it produced. Deploying, rolling back, cancelling and diffing all happen here.',
    sections: [
      {
        heading: 'How a deploy runs',
        bullets: [
          'queued → building → deploying → running (or failed / cancelled / superseded).',
          'Blue-green: the new container boots alongside the old one and must pass its health check before traffic flips.',
          'If the build or health check fails, the previous release keeps serving untouched.',
          'Each successful run stores its image digest — that is what rollback reuses.',
        ],
      },
      {
        heading: 'Deploy now',
        steps: [
          'Open this tab and press Deploy.',
          'Pick the branch/commit if you want something other than the default.',
          'Watch the live build log; the run moves through building and deploying on its own.',
        ],
      },
      {
        heading: 'Roll back',
        steps: [
          'Find any past successful deployment in the history.',
          'Press Rollback on it — NineDeploy re-releases the exact recorded image digest, no rebuild needed.',
          'Confirm the service returns to running; the rollback itself appears as a new entry in the history.',
        ],
      },
      {
        heading: 'Cancel an in-flight deploy',
        steps: [
          'While the run is queued or building, press Cancel.',
          'The in-flight container is discarded; the currently running release is never affected.',
        ],
      },
      {
        heading: 'Config diff',
        body: [
          'Each run stores a snapshot of the service configuration. Selecting a run shows a diff against the previous release — exactly which env vars, domains or build settings changed, independent of the code.',
        ],
      },
      {
        heading: 'Automatic deploys',
        body: [
          'Deploys can trigger themselves: create a webhook for this service on the Sources page with a branch match and watch-path globs, then add it to your Git host. Pushes that touch watched paths start a build.',
        ],
        tip: 'Rollback is digest-pinned, so it works even if the repository has moved on or the branch was force-pushed.',
      },
    ],
    related: [
      { label: 'Git sources & webhooks', helpId: 'sources' },
      { label: 'Service · Environment', helpId: 'service.environment' },
    ],
  },

  'service.environment': {
    title: 'Service · Environment',
    summary:
      'The environment variables of this service. Secrets are write-only and encrypted, vault references resolve at deploy time, and attached databases inject their connection strings here automatically.',
    sections: [
      {
        heading: 'Adding a variable',
        steps: [
          'Enter the key and value, mark it as a secret if it is sensitive.',
          'Save, then redeploy — containers only see env vars from their release, so changes apply on the next deploy.',
        ],
      },
      {
        heading: 'Secrets',
        body: [
          'Secret values are encrypted at rest and write-only: after saving, the panel never displays them again. You can overwrite or delete a secret, but not read it back — rotate by replacing the value.',
        ],
      },
      {
        heading: 'Vault references',
        body: [
          `Instead of pasting values, reference an external vault: ${REF_INFISICAL} or ${REF_DOPPLER}. The reference is stored plainly, but the actual value is fetched from the vault provider (configured in Settings → Integrations) when the deploy runs.`,
        ],
      },
      {
        heading: 'Shared and injected values',
        bullets: [
          'Project-level env (see the Projects page) applies to every service in that project; this tab shows the merged view.',
          'Attached managed databases inject their connection string as a read-only entry — remove the attachment to remove the variable.',
        ],
        tip: 'Changed an env var but see no effect? The running container predates the change — deploy again; the config diff on the deploy will show the variable changing.',
      },
    ],
    related: [
      { label: 'Service · Deploys', helpId: 'service.deploys' },
      { label: 'Managed databases', helpId: 'databases' },
      { label: 'Settings · Integrations (vault)', helpId: 'settings.integrations' },
    ],
  },

  'service.network': {
    title: 'Service · Network & Domains',
    summary:
      'Everything edge-related for this service: hostnames, automatic TLS, redirects and per-domain middlewares (auth, allowlists, rate limits, headers). Traefik applies the rules as soon as they are saved.',
    sections: [
      {
        heading: 'Adding a domain',
        steps: [
          'Enter the hostname and save; point its DNS at this server (an A/AAAA/CNAME record, or let NineDeploy create a Cloudflare record for you).',
          'A Let\'s Encrypt certificate is issued automatically — HTTP-01 by default, or via your DNS-01 wildcard if that is configured.',
          'The domain routes immediately after the certificate is ready; the URL chips on the Overview tab open it.',
        ],
      },
      {
        heading: 'Per-domain options',
        bullets: [
          'Redirect between apex and www.',
          'Custom response headers.',
          'Basic authentication (per-domain user list).',
          'IP allowlist.',
          'Rate limiting.',
        ],
      },
      {
        heading: 'Ports & health',
        body: [
          'The service port and health check path live in the service Settings tab; Traefik forwards to the container port, and the health path decides when a release is good enough to receive traffic.',
        ],
        tip: 'Enable DNS-01 wildcard mode once (Settings → Integrations) and every domain under that zone gets instant certificates — useful for preview environments and many subdomains.',
      },
    ],
    related: [
      { label: 'Global domains list', helpId: 'domains' },
      { label: 'Traefik status page', helpId: 'traefik' },
      { label: 'Settings · Integrations (DNS-01)', helpId: 'settings.integrations' },
    ],
  },

  'service.volumes': {
    title: 'Service · Volumes & Storage',
    summary:
      'Attach named Docker volumes to this service at explicit container paths. Volumes are the only data that survives redeploys and rebuilds.',
    sections: [
      {
        heading: 'Attaching a volume',
        steps: [
          'Pick an existing volume or create a new one.',
          'Set the absolute container path to mount it at (e.g. /app/data) and optionally mark it read-only.',
          'Save and redeploy — the mount becomes part of the service definition.',
        ],
      },
      {
        heading: 'Persistence semantics',
        bullets: [
          'Both containers of a blue-green switch mount the same volume, so data written by the old release is seen by the new one.',
          'Anything outside a mounted volume (uploads written to the container layer, installed packages) disappears on the next release.',
          'Snapshots, browsing and fleet-wide inventory live on the Volumes page.',
        ],
        tip: 'Databases you manage through the Databases page wire up their volumes automatically — this tab is for your application\'s own state.',
      },
    ],
    related: [
      { label: 'Volumes page (fleet-wide)', helpId: 'volumes' },
      { label: 'Backups', helpId: 'backups' },
      { label: 'Service · File browser', helpId: 'service.files' },
    ],
  },

  'service.files': {
    title: 'Service · File Browser',
    summary:
      'A browser into the running container\'s filesystem: view, edit, upload, create, rename and delete files without opening a shell.',
    sections: [
      {
        heading: 'Using it',
        steps: [
          'Make sure the service is running — the browser walks the live container.',
          'Navigate to a path, upload files, or edit a text file inline and save.',
        ],
      },
      {
        heading: 'What changes are safe',
        body: [
          'Everything you change lives in the current container layer only. A redeploy replaces the filesystem with a fresh image — copy anything you want to keep into a volume first, or better, into the repository.',
        ],
        tip: 'Great for quick inspections (config files, temp output); for anything durable use the Volumes tab so the data survives deploys.',
      },
    ],
    related: [
      { label: 'Service · Volumes', helpId: 'service.volumes' },
      { label: 'Service · Terminal', helpId: 'service.terminal' },
    ],
  },

  'service.framework': {
    title: 'Service · Framework',
    summary:
      'The result of repository auto-detection: the language and framework NineDeploy recognised, plus suggested build pack, install/build/start commands and conventions for this repo.',
    sections: [
      {
        heading: 'Using the detection',
        steps: [
          'Review the detected stack (e.g. Next.js on Node 22, or a Python service).',
          'Apply the suggested build settings if they look right — they feed the same fields as the build configuration.',
          'Redeploy so the next release uses them; override anything in the manifest or build settings when you need custom behaviour.',
        ],
      },
      {
        heading: 'When detection is wrong',
        body: [
          'Monorepos and unusual layouts can confuse auto-detection. Set the base directory and commands explicitly (build config or .ninedeploy manifest) — the manifest always wins over heuristics.',
        ],
      },
    ],
    related: [
      { label: 'Manifest Creator', helpId: 'manifest-creator' },
      { label: 'Service · Settings', helpId: 'service.settings' },
    ],
  },

  'service.settings': {
    title: 'Service · Settings',
    summary:
      'The service-level configuration: identity, build pack and commands, port and health check, restart policy, CPU/memory limits, and export/import of the whole service as a bundle.',
    sections: [
      {
        heading: 'Key options',
        bullets: [
          'Name & description — the display identity used in filters and the audit ledger.',
          'Build pack — auto, Nixpacks or Dockerfile, with base directory and install/build/start commands.',
          'Port & health path — what Traefik forwards to and what decides a release is healthy.',
          'Restart policy — whether the engine restarts a crashed container on its own.',
          'CPU / memory limits — caps enforced by Docker; the Overview gauges show usage against them.',
        ],
      },
      {
        heading: 'Export / import',
        body: [
          'A service can be exported as a bundle (configuration, env structure, volumes metadata) and imported on another panel — handy for staging → production moves or backups of the setup itself.',
        ],
        tip: 'Limit changes and health-path changes apply with the next deploy or restart, not retroactively to the running container.',
      },
    ],
    related: [
      { label: 'Service · Deploys', helpId: 'service.deploys' },
      { label: 'Service · Danger Zone', helpId: 'service.danger' },
    ],
  },

  'service.activity': {
    title: 'Service · Activity Logs',
    summary:
      'This service\'s logs in one place: streaming runtime output of the current container plus the build logs of past deploy runs.',
    sections: [
      {
        heading: 'Reading logs here',
        bullets: [
          'Runtime view follows the live container (stdout/stderr) — what your app prints right now.',
          'Build view shows a specific deploy run\'s log, which is where compile/install failures live.',
          'Audit events about this service (deploy, rollback, env changes) are on the global Activity page.',
        ],
      },
      {
        heading: 'Shipping logs elsewhere',
        body: [
          'To forward container logs to an external sink (syslog, Datadog, Vector), configure a log drain in Settings → Log Drains instead of tailing here.',
        ],
        tip: 'Build failing at a random step? Compare with the previous successful run\'s build log — the first diverging line usually names the culprit.',
      },
    ],
    related: [
      { label: 'Service · Deploys', helpId: 'service.deploys' },
      { label: 'Settings · Log Drains', helpId: 'settings.log-drains' },
      { label: 'Audit ledger (Activity)', helpId: 'activity' },
    ],
  },

  'service.danger': {
    title: 'Service · Danger Zone',
    summary:
      'The destructive operations for this service, deliberately separated from the everyday controls: stopping, deleting, and ownership transfers.',
    sections: [
      {
        heading: 'What lives here',
        bullets: [
          'Stop / force-stop — halt the container without deleting anything; start it again from Overview.',
          'Delete — removes the service, its containers and its Traefik routes. Attached volumes are only removed if you explicitly choose so.',
          'Move — transfer the service to another workspace or project, which changes who can see and operate it.',
        ],
      },
      {
        heading: 'What deleting does NOT do',
        bullets: [
          'It does not touch your Git repository or registry images.',
          'It does not remove DNS records at your provider — delete those yourself if the hostname will be reused.',
          'It does not delete database engines that were merely attached (they are independent services).',
        ],
        tip: 'Want the config but not the runtime? Export the service from Settings first, or stop it instead of deleting — history and env survive a stop.',
      },
    ],
    related: [
      { label: 'Service · Settings (export)', helpId: 'service.settings' },
      { label: 'Workspaces & access', helpId: 'workspaces' },
    ],
  },
};
