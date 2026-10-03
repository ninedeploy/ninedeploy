import type { HelpTopic } from '../types.js';

/** Help topics for the 7 tabs of a single database (/databases/:id?tab=…). */
export const DATABASE_TAB_TOPICS: Record<string, HelpTopic> = {
  'database.overview': {
    title: 'Database · Overview',
    summary:
      'The landing tab of one managed database: engine and version, running state, resource usage, credentials (masked) and the services attached to it.',
    sections: [
      {
        heading: 'Reading this tab',
        bullets: [
          'Engine/version and current state (running, deploying, error) mirror the underlying managed workload.',
          'Credentials are shown masked; the password is only fully revealed at creation time or on rotation.',
          'The attachments list shows which services receive the connection string as an env var.',
        ],
      },
      {
        heading: 'Common actions',
        bullets: [
          'Launch the admin studio container for a quick web UI into the data (supported engines).',
          'Rotate credentials — attached services pick up the new connection string on their next deploy.',
          'Jump to Backups for snapshots, restore points and offsite sync state.',
        ],
        tip: 'Deleting a database from its Settings tab is permanent for the data volume — export or snapshot first.',
      },
    ],
    related: [
      { label: 'Database · Backups', helpId: 'database.backups' },
      { label: 'Backups centre', helpId: 'backups' },
      { label: 'Databases list', helpId: 'databases' },
    ],
  },

  'database.topology': {
    title: 'Database · Topology',
    summary:
      'A graph of this database\'s runtime wiring: the engine container, its volumes and networks, and every service attached to it.',
    sections: [
      {
        heading: 'Using the graph',
        bullets: [
          'Attached services draw a direct edge to the engine — useful to audit blast radius before a maintenance or restore.',
          'Volume nodes show where the data physically lives; snapshots of them are listed under Backups.',
        ],
      },
    ],
    related: [
      { label: 'Instance topology', helpId: 'topology' },
      { label: 'Volumes', helpId: 'volumes' },
    ],
  },

  'database.manifest': {
    title: 'Database · Manifest',
    summary:
      'The effective workload definition for this database engine: image, environment, volume mounts, health check and resource limits — the same declarative view services expose.',
    sections: [
      {
        heading: 'When to look here',
        bullets: [
          'To confirm which image/version tag is actually running after an upgrade.',
          'To inspect the env scaffolding (auth credentials, data dir, ports) the panel generated.',
          'To verify limits before increasing concurrency on busy engines.',
        ],
        tip: 'Version upgrades create a new release of this workload — snapshot a backup first so the old data can be restored if an engine upgrade is not backwards compatible.',
      },
    ],
    related: [
      { label: 'Database · Overview', helpId: 'database.overview' },
      { label: 'Database · Backups', helpId: 'database.backups' },
    ],
  },

  'database.files': {
    title: 'Database · Files',
    summary:
      'A file browser into the database container\'s filesystem — for inspecting config files and directory layout. Treat the data directory as read-only.',
    sections: [
      {
        heading: 'Safe usage',
        bullets: [
          'Reading configuration (my.cnf, postgresql.conf, mongod.conf, …) is the main use case.',
          'Do not edit or delete files inside the engine\'s data directory while it is running — corruption is the likely result.',
          'For durable app-side files use volumes, not this browser.',
        ],
        tip: 'Need query-level access instead? Launch the admin studio from the database Overview tab.',
      },
    ],
    related: [
      { label: 'Database · Overview', helpId: 'database.overview' },
      { label: 'Volumes browser', helpId: 'volumes' },
    ],
  },

  'database.backups': {
    title: 'Database · Backups',
    summary:
      'This database\'s snapshot schedule and history: manual snapshots, the daily scheduled job, retention, restore and download.',
    sections: [
      {
        heading: 'Taking a snapshot',
        steps: [
          'Press Snapshot for an immediate, on-demand backup.',
          'The run appears in the history with size, duration and seal status.',
          'Enable offsite sync from the Backups centre to copy snapshots to an S3 destination.',
        ],
      },
      {
        heading: 'Restoring',
        steps: [
          'Pick a snapshot from the history.',
          'Restore — the engine\'s data volume is rolled back to that point (live connections are interrupted).',
          'Or download the AES-256-GCM sealed file for safekeeping outside the panel.',
        ],
      },
      {
        heading: 'Schedule & retention',
        bullets: [
          'A daily schedule with a retention window (oldest pruned first) is the default.',
          'Tighten the interval for busy production databases; keep retention long enough to reach a pre-incident point.',
        ],
        tip: 'A restore is the fastest rollback for data mistakes — deploys roll back code, snapshots roll back data.',
      },
    ],
    related: [
      { label: 'Backups centre (destinations)', helpId: 'backups' },
      { label: 'Database · Overview', helpId: 'database.overview' },
    ],
  },

  'database.logs': {
    title: 'Database · Logs',
    summary:
      'The engine container\'s runtime log: connections, slow queries, errors and startup/shutdown events, streamed live.',
    sections: [
      {
        heading: 'Reading engine logs',
        bullets: [
          'Connection refused / too many connections errors point at limits or readiness, not at your app code.',
          'Startup lines show recovery and migration steps after a version upgrade or restore.',
          'Ship logs externally via Settings → Log Drains if you need them beyond the local retention.',
        ],
      },
    ],
    related: [
      { label: 'Settings · Log Drains', helpId: 'settings.log-drains' },
      { label: 'Database · Overview', helpId: 'database.overview' },
    ],
  },

  'database.settings': {
    title: 'Database · Settings',
    summary:
      'Lifecycle configuration for this database: identity, size and resource limits, credential rotation, attachments and deletion.',
    sections: [
      {
        heading: 'Key operations',
        bullets: [
          'Rename or resize — resource changes apply with the next restart of the engine.',
          'Rotate credentials — updates the stored connection string; attached services receive it on their next deploy.',
          'Manage attachments — add or remove services that receive the connection string.',
          'Delete — permanently removes the engine and, if chosen, its data volume. Snapshots already taken are kept.',
        ],
        tip: 'Before deleting: take a final snapshot and note which services are attached — they will lose their DATABASE_URL-style env values on the next deploy.',
      },
    ],
    related: [
      { label: 'Database · Backups', helpId: 'database.backups' },
      { label: 'Database · Overview', helpId: 'database.overview' },
    ],
  },
};
