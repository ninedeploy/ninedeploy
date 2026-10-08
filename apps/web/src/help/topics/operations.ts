import type { HelpTopic } from '../types.js';

/** 0.15 operations topics: terminals, traffic analytics and access grants. */
export const OPERATIONS_TOPICS: Record<string, HelpTopic> = {
  terminals: {
    title: 'Terminal sessions',
    summary:
      'Every shell opened through the panel, live or finished: who opened it, on what, when, for how long and how many bytes moved. No transcript is ever recorded. Operators only.',
    sections: [
      {
        heading: 'Where shells open',
        bullets: [
          'Service page → Terminal & Exec: a real TTY in the service container, resized with the window.',
          'Database page → Shell, or Client (psql, mysql, redis-cli…) with the stored credentials passed in the environment, never on a command line.',
          'Servers page → Panel host shell / host shell per node, only while host shells are enabled.',
          'Shells into a node need the node agent v0.15.0 or later; the Servers page says when an agent is older.',
        ],
      },
      {
        heading: 'Limits and endings',
        bullets: [
          'A session closes after the idle timeout (no typing) or the maximum session length; both are set in Settings → Security → Terminals.',
          'Each user can hold 3 open terminals; the panel as a whole has its own cap.',
          'Terminate ends a live session immediately: the user sees "An operator terminated this session".',
          'Every start and end is in the Activity ledger; host shells also send a security notification.',
        ],
      },
    ],
    related: [
      { label: 'Settings · Security (Terminals)', helpId: 'settings.security' },
      { label: 'Service · Terminal & Exec', helpId: 'service.terminal' },
      { label: 'Servers', helpId: 'servers' },
    ],
  },

  'traffic-analytics': {
    title: 'Traffic analytics',
    summary:
      'Opt-in request counts per domain, read from Traefik\'s access log: status classes, latency percentiles and bytes sent. No client IP, path, query string or header is ever stored.',
    sections: [
      {
        heading: 'Turning it on',
        steps: [
          'Open Traefik → Traffic (operators) and switch analytics on.',
          'Traefik is recreated once: about 1–2 seconds of refused connections on every domain, this panel included when it is served through Traefik.',
          'Counters appear within a minute; if the page lost the answer during the restart it reads the settings again.',
        ],
      },
      {
        heading: 'Reading the numbers',
        bullets: [
          '1h and 24h use minute buckets, 7d and 30d hour buckets. Minute rows are kept for 48 hours, hour rows for the retention you set.',
          'Bars split each bucket by status class; the line is the average latency. p50/p95/p99 are estimated from a latency histogram.',
          'Each service shows its own domains on its Overview tab; anyone with a seat on the service can see it.',
          'Traffic through node proxies is not counted yet.',
        ],
      },
    ],
    related: [
      { label: 'Traefik', helpId: 'traefik' },
      { label: 'Service · Overview', helpId: 'service.overview' },
    ],
  },

  'access-grants': {
    title: 'Project & environment access',
    summary:
      'Grants raise one person\'s role on a project, an environment, or a project\'s services in one environment, without touching their workspace seat. A grant never lowers a role.',
    sections: [
      {
        heading: 'How access is worked out',
        bullets: [
          'Effective role = the higher of the workspace seat and every matching grant. Owner is never grantable; admins grant up to admin.',
          'A project grant covers the project, its databases and the services linked to it.',
          'An environment grant covers the services in that environment (databases have no environment).',
          'Project + environment covers only the project\'s services in that environment.',
        ],
      },
      {
        heading: 'Guests',
        bullets: [
          'Someone with grants and no seat is a guest: they see only what their grants cover.',
          'Guests cannot create services or databases, see member lists, labels or workspace settings.',
          'Removing a member removes their grants; SCIM suspension suspends them until the identity provider reinstates the user.',
        ],
        tip: 'To make someone read-only on production but able to deploy elsewhere, give them a viewer seat and member grants on the other environments.',
      },
    ],
    related: [
      { label: 'Workspaces', helpId: 'workspaces' },
      { label: 'Projects', helpId: 'projects' },
    ],
  },
};
