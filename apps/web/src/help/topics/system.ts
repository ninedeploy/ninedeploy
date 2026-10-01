import type { HelpTopic } from '../types.js';

export const SYSTEM_TOPICS: Record<string, HelpTopic> = {
  activity: {
    title: 'Activity (Audit Ledger)',
    summary:
      'The full audit trail of the panel: who did what to which entity and when — service changes, deploys, rollbacks, env edits, exec sessions, user and token events.',
    sections: [
      {
        heading: 'Reading the ledger',
        bullets: [
          'Every row names the action, the entity and the actor, newest first.',
          'Exec terminal sessions appear here too — privileged access is always recorded.',
          'The top-right pulse icon opens a live, streaming mini version of this feed.',
        ],
      },
      {
        heading: 'Investigating an incident',
        steps: [
          'Find the time window and scan the actions around it.',
          'Follow the entity links to the affected service or database.',
          'Correlate deploys with config diffs on the service\'s Deploys tab to see exactly what changed.',
        ],
        tip: 'The ledger is append-only — it is your source of truth for "what changed", especially before reaching for backups.',
      },
    ],
    related: [
      { label: 'Service · Activity logs', helpId: 'service.activity' },
      { label: 'Users', helpId: 'users' },
    ],
  },

  monitoring: {
    title: 'Monitoring',
    summary:
      'Live host metrics with history — CPU, memory, disk and network — plus per-container usage and the Docker event stream for this node.',
    sections: [
      {
        heading: 'What to watch',
        bullets: [
          'Disk: the most common silent failure. Docker images and build cache grow over time — prune from the Docker page if it climbs.',
          'Memory: containers near their limits get OOM-killed; raise limits in the service Settings.',
          'CPU spikes right after a deploy are usually the health check and app warm-up, not a problem.',
        ],
      },
      {
        heading: 'Alerts',
        body: [
          'Threshold alerts (CPU, memory, certificate expiry) are configured in Settings → Notifications (operators only), together with the channels that receive them (Telegram, Discord, Slack, webhook, ntfy, email). Alerts fire and recover on their own.',
        ],
        tip: 'This page is per-node. A busy remote agent has its own view once registered on the Servers page.',
      },
    ],
    related: [
      { label: 'Dashboard', helpId: 'dashboard' },
      { label: 'Docker page', helpId: 'docker' },
      { label: 'Settings · Notifications', helpId: 'settings.notifications' },
    ],
  },

  docker: {
    title: 'Docker',
    summary:
      'Raw Docker management for this host: images, containers and safe prune actions. Operator-only — everything here is one level below the panel\'s abstractions.',
    sections: [
      {
        heading: 'What lives here',
        bullets: [
          'Images — including the dangling layers previous builds left behind.',
          'Containers — including stopped ones and the inactive side of a blue-green pair.',
          'Prune — reclaims space from dangling images and build cache. Containers in use are never removed.',
        ],
      },
      {
        heading: 'Pruning safely',
        body: [
          'Pruning images is safe for running services; the cost is re-pulling/re-building on the next deploy. Prune deliberately on low-disk hosts, not routinely "for cleanliness" — the build cache is what makes deploys fast.',
        ],
        tip: 'Debugging a container the panel does not recognise? It may belong to a compose-type service or be a leftover — check the service lists before removing anything by hand.',
      },
    ],
    related: [
      { label: 'Monitoring', helpId: 'monitoring' },
      { label: 'Networks', helpId: 'networks' },
    ],
  },

  sources: {
    title: 'Sources (Git credentials & webhooks)',
    summary:
      'Credentials for private repositories — personal access tokens and SSH deploy keys — plus the push webhooks that make services rebuild themselves.',
    sections: [
      {
        heading: 'Adding a Git credential',
        steps: [
          'Create a read-scoped token (or deploy key) at your Git host.',
          'Add it on this page and let the panel verify it.',
          'Select it when creating a Git service — the repository browser then lists your private repos too.',
        ],
      },
      {
        heading: 'Auto-deploy webhooks',
        steps: [
          'Create a webhook for a service: pick the branch to match and the watch-path globs (e.g. apps/api/**).',
          'Copy the signed webhook URL shown by the panel.',
          'Add it as a push webhook in GitHub/GitLab. Pushes that match branch and paths trigger a deploy automatically.',
        ],
      },
      {
        heading: 'PR previews',
        body: [
          'Webhooks can also create ephemeral preview environments for pull requests — each PR gets its own deployment, destroyed when the PR closes. Watch paths keep unrelated pushes from starting builds.',
        ],
        tip: 'Deploy keys are per-repository and least-privilege; a fine-grained PAT is more convenient when one credential must see many repos.',
      },
    ],
    related: [
      { label: 'Services list', helpId: 'services' },
      { label: 'Service · Deploys', helpId: 'service.deploys' },
    ],
  },

  servers: {
    title: 'Servers (remote agents)',
    summary:
      'Remote worker nodes: hosts running NineDeploy in agent mode that this panel manages over the network — deploy targets beyond the primary machine.',
    sections: [
      {
        heading: 'Registering an agent',
        steps: [
          'Install NineDeploy on the other host with NINEDEPLOY_AGENT=1.',
          'Create a one-time registration token here and use it on the agent host.',
          'The node appears with its resources and becomes manageable from this panel.',
        ],
      },
      {
        heading: 'Constraints today',
        bullets: [
          'Agent traffic travels in sealed (authenticated-encrypted) envelopes by default; plaintext is refused unless an operator explicitly opts in for an old agent. Still prefer a LAN or VPN for node agents.',
          'Agents run the same binary, so the panel and agents should stay on compatible versions.',
        ],
        tip: 'Check each agent\'s connectivity from this page after registration — most setup problems are firewall rules between panel and agent.',
      },
    ],
    related: [
      { label: 'Monitoring', helpId: 'monitoring' },
      { label: 'Settings · System (self-update)', helpId: 'settings.system' },
    ],
  },

  users: {
    title: 'Users',
    summary:
      'Instance-level user administration: every account on this panel, with password-reset links, deletion and invitations. Day-to-day team permissions are managed per workspace, not here.',
    sections: [
      {
        heading: 'What operators can do here',
        bullets: [
          'See all accounts and their status.',
          'Force a password reset — the user receives a reset link.',
          'Delete an account; its workspace memberships go with it.',
          'Send invitations that create new accounts on acceptance.',
        ],
      },
      {
        heading: 'How permissions actually work',
        body: [
          'There is no global "admin" checkbox: what a user may do follows from their roles in workspaces (owner / admin / member / viewer). This page is for account lifecycle only — join the user to workspaces on the Workspaces page.',
        ],
        tip: 'Locking someone out quickly? Remove them from their workspaces (kills all access) rather than deleting the account outright.',
      },
    ],
    related: [
      { label: 'Workspaces & roles', helpId: 'workspaces' },
      { label: 'Settings · Security (your account)', helpId: 'settings.security' },
    ],
  },

  about: {
    title: 'About',
    summary:
      'Version information for this panel: current release, the "What\'s New" changelog, the tech stack, and links to documentation and the project on GitHub.',
    sections: [
      {
        heading: 'Using this page',
        bullets: [
          'Compare your version against the latest release before reporting issues.',
          'The changelog explains what recent updates changed — the panel can update itself from Settings → System.',
          'The docs link opens the full documentation that ships with NineDeploy.',
        ],
      },
    ],
    related: [
      { label: 'Settings · System (self-update)', helpId: 'settings.system' },
      { label: 'NineDeploy Help', helpId: 'general' },
    ],
  },
};
