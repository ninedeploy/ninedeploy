import type { HelpTopic } from '../types.js';

// Unicode escapes per repo convention (see EnvCard.tsx) for the literal `${{…}}` syntax.
const REF_INFISICAL = '\u0024\u007B\u007Binfisical:KEY\u007D\u007D';
const REF_DOPPLER = '\u0024\u007B\u007Bdoppler:KEY\u007D\u007D';
const REF_VAULT = '\u0024\u007B\u007Bvault:path/to/secret#field\u007D\u007D';
const REF_AWS = '\u0024\u007B\u007Baws:secret-id\u007D\u007D';
const REF_AWS_KEY = '\u0024\u007B\u007Baws:secret-id#jsonKey\u007D\u007D';

/** Help topics for the 14 sections of the Settings page (/settings?section=…). */
export const SETTINGS_TAB_TOPICS: Record<string, HelpTopic> = {
  'settings.account': {
    title: 'Settings · Account',
    summary:
      'Your own profile and credentials: name and email, password change, and passkeys registered to your user.',
    sections: [
      {
        heading: 'What lives here',
        bullets: [
          'Profile details shown in the panel.',
          'Password change — other sessions stay valid until you revoke them (see Security).',
          'Passkeys — device-bound WebAuthn credentials for passwordless sign-in; register more than one so a lost device does not lock you out.',
        ],
        tip: 'Account-wide things (2FA, sessions, API tokens) are on the Security section; this one is identity only.',
      },
    ],
    related: [
      { label: 'Settings · Security', helpId: 'settings.security' },
      { label: 'Users (instance accounts)', helpId: 'users' },
    ],
  },

  'settings.appearance': {
    title: 'Settings · Appearance',
    summary:
      'How the panel looks for you: dark/light theme, accent colour, and interface density. Purely local — nothing here affects other users.',
    sections: [
      {
        heading: 'Options',
        bullets: [
          'Theme — dark or light, with a quick toggle in the top-right header.',
          'Accent — recolours the active states across the whole interface.',
          'Density — compact vs comfortable lists and tables.',
        ],
      },
    ],
    related: [{ label: 'Settings · Account', helpId: 'settings.account' }],
  },

  'settings.security': {
    title: 'Settings · Security',
    summary:
      'Hardening for your own account: two-factor authentication, active sessions, and the API tokens that let scripts and the CLI act as you.',
    sections: [
      {
        heading: 'Two-factor authentication',
        steps: [
          'Enable TOTP and scan the shown secret with your authenticator app.',
          'Confirm with a current code; store the recovery codes somewhere safe.',
          'From then on, sign-in asks for a TOTP code after the password.',
        ],
      },
      {
        heading: 'Sessions & tokens',
        bullets: [
          'Sessions lists every signed-in device; revoke the ones you do not recognise or no longer use.',
          'API tokens authenticate the CLI, SDK and CI against the panel API — create one per integration and revoke it when done.',
          'Passkeys are managed on the Account section.',
        ],
        tip: 'See a session you cannot place? Revoke it and change your password — then check the Activity ledger for what that session did.',
      },
      {
        heading: 'Terminals (operators)',
        bullets: [
          'Host shells are off by default. Turning them on asks for your password, and so does every host shell session.',
          'NINEDEPLOY_HOST_TERMINAL=off in the panel environment forbids host shells whatever the switch says.',
          'The idle timeout, maximum session length, the panel-wide cap and the history retention apply to every terminal.',
        ],
      },
    ],
    related: [
      { label: 'Terminal sessions', helpId: 'terminals' },
      { label: 'Settings · SSO', helpId: 'settings.sso' },
      { label: 'Activity (audit ledger)', helpId: 'activity' },
    ],
  },

  'settings.sso': {
    title: 'Settings · SSO & OIDC',
    summary:
      'Sign-in through an external identity provider using OpenID Connect, with optional automatic enrolment of users from the provider.',
    sections: [
      {
        heading: 'Connecting a provider',
        steps: [
          'Create an OIDC application at your provider (Authentik, Keycloak, Auth0, Google, …).',
          'Register the issuer URL, client id and secret here; the panel shows the redirect URI to paste back into the provider.',
          'Enable the provider — the login page gains SSO sign-in.',
        ],
      },
      {
        heading: 'Behaviour',
        bullets: [
          'Auto-enrol lets anyone at the provider create their panel account on first SSO sign-in; keep it off for private instances.',
          'SSSO users still need workspace membership (or an invitation) to see any services.',
        ],
        tip: 'Keep at least one local admin with a working password and TOTP — if the provider is down, SSO alone would lock everyone out.',
      },
    ],
    related: [
      { label: 'Settings · Security', helpId: 'settings.security' },
      { label: 'Workspaces', helpId: 'workspaces' },
    ],
  },

  'settings.integrations': {
    title: 'Settings · Integrations',
    summary:
      'The external services NineDeploy talks to: secret vaults (Infisical/Doppler) and secret managers (Vault/OpenBao, AWS Secrets Manager), Cloudflare DNS for automatic records and wildcard certificates, and template registry overrides.',
    sections: [
      {
        heading: 'Vault providers',
        body: [
          `Configure Infisical or Doppler here, then reference secrets from any service env as ${REF_INFISICAL} or ${REF_DOPPLER}. Values are fetched at deploy time, so the panel never stores the plaintext.`,
        ],
      },
      {
        heading: 'Cloudflare & DNS-01',
        bullets: [
          'With a Cloudflare API token the panel can create DNS records automatically when you attach a domain.',
          'Enabling DNS-01 lets the panel issue wildcard certificates (*.example.com) — one cert covers unlimited subdomains.',
        ],
      },
      {
        heading: 'Template source',
        body: [
          'Point the Hub at a custom template registry JSON to extend or replace the built-in gallery; the fetched registry is cached for a few hours.',
        ],
        tip: 'Vault resolution failures surface as deploy failures with a clear message — test the credentials here right after entering them.',
      },
    ],
    related: [
      { label: 'Service · Environment (vault refs)', helpId: 'service.environment' },
      { label: 'Service · Network & domains', helpId: 'service.network' },
      { label: 'Hub (templates)', helpId: 'hub' },
      { label: 'Secret managers (Vault, AWS)', helpId: 'settings.secret-managers' },
    ],
  },

  'settings.secret-managers': {
    title: 'Settings · Secret managers',
    summary:
      'HashiCorp Vault / OpenBao (KV v2) and AWS Secrets Manager, configured by an operator under Integrations. They run beside the Infisical / Doppler provider and resolve references at deploy time.',
    sections: [
      {
        heading: 'Reference syntax',
        bullets: [
          `${REF_VAULT}: a field of a KV v2 secret; the path is relative to the configured mount.`,
          `${REF_AWS}: the whole SecretString of a secret (a name or a full ARN).`,
          `${REF_AWS_KEY}: one key of a JSON SecretString.`,
        ],
        tip: 'While a provider is not configured or is disabled, its references stay literal and the deploy log warns, so the container receives the reference text rather than a secret.',
      },
      {
        heading: 'Credentials',
        bullets: [
          'Vault: a token (use a periodic token; it is not renewed) or an AppRole role id and secret id. Enterprise / OpenBao namespaces are supported.',
          'AWS: an access key id and secret access key, optionally assuming a role (with an external id). Instance and ECS roles are not supported.',
          'Credentials are write-only: leave a field blank to keep the stored value. Test connection proves them, optionally reading a probe path or secret.',
          'Addresses must be https; an internal Vault needs NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1.',
        ],
      },
      {
        heading: 'Who may use references',
        body: [
          'The "Allowed workspaces" list on the same page governs every provider: only services owned by an operator, or tagged into an allowed workspace, may resolve references.',
        ],
      },
    ],
    related: [
      { label: 'Settings · Integrations', helpId: 'settings.integrations' },
      { label: 'Service · Environment (vault refs)', helpId: 'service.environment' },
    ],
  },

  'settings.ai': {
    title: 'Settings · AI Diagnosis',
    summary:
      'Bring-your-own-key failure diagnosis: one OpenAI-compatible endpoint, model and API key for the whole instance, used to explain failed build logs.',
    sections: [
      {
        heading: 'Setting it up',
        bullets: [
          'Base URL — any OpenAI-compatible chat-completions endpoint (OpenAI, a gateway, or a local model server).',
          'Model — the model name that endpoint expects.',
          'API key — sent once and sealed server-side; the form never shows it again. Leave it empty to keep the stored key.',
        ],
        tip: 'The sanitized tail of a failed build log is sent to the provider — pick one you trust with your build output.',
      },
    ],
    related: [{ label: 'Service · Deploys', helpId: 'service.deploys' }],
  },

  'settings.notifications': {
    title: 'Settings · Notifications',
    summary:
      'Where the panel talks to you: delivery channels (Telegram, Discord, Slack, generic webhooks, ntfy, email) and alert rules that watch host and certificate health.',
    sections: [
      {
        heading: 'Adding a channel',
        steps: [
          'Create the channel and paste the token/webhook URL from the target service.',
          'Send a test notification — it must arrive before alerts will be useful.',
        ],
      },
      {
        heading: 'Alert rules',
        bullets: [
          'Rules watch thresholds like CPU, memory or certificate expiry.',
          'Each rule fires a notification when crossing the threshold and a recovery when it returns to normal.',
          'Pick which channels receive each rule.',
        ],
        tip: 'One quiet channel is worth ten noisy ones: start with cert-expiry and memory alerts, and add more only when you actually act on them.',
      },
    ],
    related: [
      { label: 'Monitoring', helpId: 'monitoring' },
      { label: 'Settings · Integrations', helpId: 'settings.integrations' },
    ],
  },

  'settings.log-drains': {
    title: 'Settings · Log Drains',
    summary:
      'Forward container logs off the panel to an external sink — syslog, Datadog or a Vector endpoint — instead of (or besides) reading them in the UI.',
    sections: [
      {
        heading: 'Adding a drain',
        steps: [
          'Choose the sink type and endpoint (and credentials, if required).',
          'Test the connection, then enable the drain.',
          'Container output starts shipping; verify it lands in your sink within a minute.',
        ],
      },
      {
        heading: 'What gets shipped',
        body: [
          'stdout/stderr of running containers. Build logs of deploy runs stay in the panel — drains are for runtime observability.',
        ],
        tip: 'Drains ship what the container prints — if a service logs nothing, a silent drain is not a broken drain.',
      },
    ],
    related: [
      { label: 'Service · Activity logs', helpId: 'service.activity' },
      { label: 'Database · Logs', helpId: 'database.logs' },
    ],
  },

  'settings.storage': {
    title: 'Settings · Storage & Prune',
    summary:
      'Disk health for this host: usage gauges, Docker prune policy, and container log rotation — the controls that stop a busy panel from filling its disk.',
    sections: [
      {
        heading: 'What to configure',
        bullets: [
          'Prune policy — how aggressively dangling images and build cache are reclaimed.',
          'Log rotation — caps per-container log size so a chatty app cannot eat the disk.',
          'Retention for housekeeping jobs (old deploy artefacts, pruneable volumes).',
        ],
      },
      {
        heading: 'When disk is already full',
        steps: [
          'Run a prune from the Docker page to reclaim image/build-cache space now.',
          'Check the Monitoring history to find what grew.',
          'Set the policy here so it does not happen again.',
        ],
        tip: 'The build cache is what makes repeated deploys fast — prune to recover an emergency, but do not schedule it away entirely.',
      },
    ],
    related: [
      { label: 'Docker page', helpId: 'docker' },
      { label: 'Monitoring', helpId: 'monitoring' },
    ],
  },

  'settings.firewall': {
    title: 'Settings · Firewall (UFW)',
    summary:
      'The host-level packet filter: toggle UFW and manage inbound port rules. This is real host security — a wrong rule here can lock you out of the server.',
    sections: [
      {
        heading: 'Using it safely',
        steps: [
          'Before enabling UFW, make sure SSH (port 22 or your custom port) is explicitly allowed.',
          'Allow what must be public: typically 80 and 443 for Traefik — everything else stays internal.',
          'Add or remove rules as needed; the panel applies them to the host immediately.',
        ],
      },
      {
        heading: 'What needs no rule',
        body: [
          'Service-to-service traffic rides the internal Docker network and never touches the host firewall. Only host-published ports need rules here.',
        ],
        tip: 'Enable UFW only with a working console/SSH fallback at hand — a firewall you cannot reach is a server you cannot reach.',
      },
    ],
    related: [
      { label: 'Traefik (public entrypoint)', helpId: 'traefik' },
      { label: 'Tunnels (no open ports)', helpId: 'tunnels' },
    ],
  },

  'settings.config': {
    title: 'Settings · Config Center',
    summary:
      'The typed global key-value store: instance-wide configuration entries that features and plugins read, in one auditable place.',
    sections: [
      {
        heading: 'Using it',
        bullets: [
          'Entries are typed (string/number/bool) and validated on save.',
          'Values here act as global defaults; pages that consume a key show it inline in their own settings.',
          'Changes take effect as the consuming feature reads them — some require a service or panel action to pick up.',
        ],
        tip: 'If a key is documented for a feature, prefer changing it there — the Config Center is the fallback for global tuning.',
      },
    ],
    related: [
      { label: 'Settings · System', helpId: 'settings.system' },
      { label: 'Settings · Plugins', helpId: 'settings.plugins' },
    ],
  },

  'settings.plugins': {
    title: 'Settings · Plugins',
    summary:
      'The extension surface: browse and install community plugins that add pages, menu entries or integrations to the panel.',
    sections: [
      {
        heading: 'Managing plugins',
        bullets: [
          'Installed plugins appear in the sidebar under Extensions when they register menu entries.',
          'Remove a plugin to take its contributions back out — services and data it did not own are untouched.',
          'The ecosystem is young: treat third-party plugins with the same care as any code you run on your server.',
        ],
      },
    ],
    related: [
      { label: 'Settings · Config Center', helpId: 'settings.config' },
      { label: 'About', helpId: 'about' },
    ],
  },

  'settings.system': {
    title: 'Settings · System',
    summary:
      'The lifecycle of the panel itself: host resource summary, current version, one-click self-update, and export/import of the whole instance configuration.',
    sections: [
      {
        heading: 'Self-update',
        steps: [
          'Check the current version against the latest release shown here.',
          'Start the update — the panel downloads, installs and restarts itself; you are notified when it is back.',
          'Verify the version bump on the About page afterwards.',
        ],
      },
      {
        heading: 'Export / import',
        body: [
          'Export captures the instance configuration (services, settings structure) as a bundle; import restores it — the backbone of server migrations, together with database backups taken separately.',
        ],
        tip: 'Update during a quiet window: while the panel restarts, the API and dashboard are briefly unavailable — running containers keep serving the whole time.',
      },
    ],
    related: [
      { label: 'About (version & changelog)', helpId: 'about' },
      { label: 'Backups', helpId: 'backups' },
      { label: 'Settings · Migration', helpId: 'settings.migration' },
    ],
  },

  'settings.panel-backup': {
    title: 'Settings · Panel backup',
    summary:
      'Scheduled backups of the panel itself — its database, master key, .env and Traefik config — encrypted with a recovery passphrase and kept in an S3 backup destination.',
    sections: [
      {
        heading: 'Turning it on',
        steps: [
          'Add an S3-compatible bucket under Backups → Destinations.',
          'Pick it here, set a schedule (5-field cron) and how many backups to keep.',
          'Set a recovery passphrase and store it in a password manager — NOT on this server.',
          'Use "Back up now" once and check the run succeeds.',
        ],
        tip: 'Without the recovery passphrase no panel backup can be opened, by anyone. Changing it later only affects new backups.',
      },
      {
        heading: 'Restoring on a new server',
        steps: [
          'Install the same (or a newer) NineDeploy version and sign in.',
          'Add the same bucket under Backups → Destinations.',
          'Open this section, list that destination, choose a backup and Restore with the passphrase.',
          'Restart NineDeploy. Offline alternative: `ninedeploy system panel-backup decrypt` then `ninedeploy system import`.',
        ],
      },
      {
        heading: 'What is not included',
        body: [
          'App volumes and managed database data are covered by their own backups (Backups page). Docker images are rebuilt or pulled on redeploy.',
        ],
      },
    ],
    related: [
      { label: 'Settings · Migration', helpId: 'settings.migration' },
      { label: 'Backups', helpId: 'backups' },
    ],
  },

  'settings.migration': {
    title: 'Settings · Migration',
    summary:
      'Full-instance export and import: move a NineDeploy setup to a new server or restore one from a bundle, configuration included.',
    sections: [
      {
        heading: 'Exporting an instance',
        steps: [
          'Run the export — it produces a migration bundle with the instance configuration.',
          'Store the bundle off-box, together with database/volume backups if you need data too.',
        ],
      },
      {
        heading: 'Importing on a new host',
        steps: [
          'Install the same (or newer) NineDeploy version on the target host.',
          'Run the import with the bundle; configuration is restored.',
          'Bring data over with your backups (database snapshots, volume snapshots) and verify services start.',
        ],
        tip: 'Configuration and data travel separately by design: migration bundles carry the setup, the Backups page carries the bytes.',
      },
    ],
    related: [
      { label: 'Settings · System (export)', helpId: 'settings.system' },
      { label: 'Settings · Panel backup', helpId: 'settings.panel-backup' },
      { label: 'Backups', helpId: 'backups' },
    ],
  },
};
