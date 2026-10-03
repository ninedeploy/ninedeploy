import type { HelpTopic } from '../types.js';

export const DATA_TOPICS: Record<string, HelpTopic> = {
  databases: {
    title: 'Databases',
    summary:
      'One-click managed database engines running as first-class workloads on this host: PostgreSQL (with pgvector), MySQL/MariaDB, Redis/Valkey, MongoDB, ClickHouse, Meilisearch and RabbitMQ.',
    sections: [
      {
        heading: 'Creating a database',
        steps: [
          'Click New Database and pick the engine, version and size.',
          'Set the instance name and credentials (or let NineDeploy generate them — the password is shown once, store it).',
          'Create; the engine starts as a managed workload with its own volume and health checks.',
        ],
      },
      {
        heading: 'Attaching a database to a service',
        steps: [
          'Open the target service (or the database) and choose attach.',
          'Give the attachment an env alias, e.g. DATABASE_URL.',
          'On the next deploy the service receives the connection string as an environment variable — no manual copying of credentials.',
        ],
      },
      {
        heading: 'Admin UIs',
        body: [
          'For supported engines NineDeploy can launch a companion admin container (e.g. a web studio for Postgres/MySQL) with one click — useful for quick data inspection without installing a client.',
        ],
        tip: 'Databases are services under the hood: their logs, topology and files are reachable from the database\'s own detail page.',
      },
    ],
    related: [
      { label: 'Database detail page', helpId: 'database.overview' },
      { label: 'Backups', helpId: 'backups' },
      { label: 'Service · Environment', helpId: 'service.environment' },
    ],
  },

  volumes: {
    title: 'Volumes',
    summary:
      'The fleet-wide inventory of named Docker volumes: who uses them, how big they are, and the snapshot / restore / browse actions for the data inside.',
    sections: [
      {
        heading: 'Browsing and attaching',
        bullets: [
          'Each row shows the volume, its size and the services or databases mounting it.',
          'The built-in browser walks the volume\'s files; attachments per service are managed on the service\'s Volumes tab.',
        ],
      },
      {
        heading: 'Snapshots',
        steps: [
          'Create a snapshot of a volume — it is labelled and listed under Backups.',
          'Restore a snapshot to roll the volume back (this overwrites the current contents).',
          'Download a snapshot to keep an off-box copy.',
        ],
        tip: 'A restore overwrites live data — stop the consuming service first if the app cannot tolerate a mid-write rollback.',
      },
    ],
    related: [
      { label: 'Service · Volumes tab', helpId: 'service.volumes' },
      { label: 'Backups', helpId: 'backups' },
    ],
  },

  backups: {
    title: 'Backups',
    summary:
      'The backup centre: snapshot history across all managed databases, the scheduled daily jobs with retention, and the S3-compatible offsite destinations snapshots sync to.',
    sections: [
      {
        heading: 'Destinations',
        steps: [
          'Add an S3-compatible destination (Cloudflare R2, AWS S3, MinIO, Wasabi, …) with bucket and keys.',
          'Run the connectivity test — it must pass before sync is enabled.',
          'Enable sync; new database snapshots are uploaded automatically.',
        ],
      },
      {
        heading: 'Restoring',
        steps: [
          'Find the snapshot (per database, or in the global list here).',
          'Restore to roll the database back to that point — this overwrites live data.',
          'Or download the sealed file and keep it elsewhere.',
        ],
      },
      {
        heading: 'Scheduling & retention',
        bullets: [
          'Managed databases get a daily scheduled backup by default, with a retention window that prunes the oldest snapshots.',
          'Schedules and retention are adjusted per database on its Backups tab.',
        ],
        tip: 'Snapshots are sealed with AES-256-GCM before they leave the host — destinations only ever store ciphertext, so an untrusted bucket is acceptable.',
      },
    ],
    related: [
      { label: 'Database · Backups tab', helpId: 'database.backups' },
      { label: 'Volumes', helpId: 'volumes' },
      { label: 'Databases', helpId: 'databases' },
    ],
  },
};
