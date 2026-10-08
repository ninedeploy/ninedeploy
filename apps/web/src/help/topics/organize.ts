import type { HelpTopic } from '../types.js';

export const ORGANIZE_TOPICS: Record<string, HelpTopic> = {
  workspaces: {
    title: 'Workspaces',
    summary:
      'Workspaces are the team and tenancy unit: they own members with roles, and services can belong to one. Authorization is derived from workspace membership — there are no global roles on the panel.',
    sections: [
      {
        heading: 'Roles inside a workspace',
        bullets: [
          'owner — full control: manage members and roles, transfer or delete the workspace.',
          'admin — day-to-day administration: manage members and the workspace\'s services.',
          'member — operate services: deploy, change env, attach domains.',
          'viewer — read-only visibility into the workspace\'s services.',
        ],
      },
      {
        heading: 'Inviting people',
        steps: [
          'Open the workspace and invite by email address with a role.',
          'The invitee accepts the link from their mailbox (invite acceptance also works without an existing account).',
          'Their effective permissions are the union of their workspace roles.',
        ],
      },
      {
        heading: 'Operators',
        body: [
          'An "operator" is a per-instance flag granted on the People page (instance operators only) — it is NOT inherited from workspace owner/admin roles. Operators unlock host-level surfaces: the Docker page, Volumes, Activity, remote Servers, Sources, Users and most of Settings; workspace owners manage their own workspace\'s members and services.',
        ],
        tip: 'Filter the whole panel to a single workspace with the workspace chip in the top bar — services outside it disappear from every list.',
      },
    ],
    related: [
      { label: 'Users (instance administration)', helpId: 'users' },
      { label: 'Projects', helpId: 'projects' },
      { label: 'Project & environment access', helpId: 'access-grants' },
    ],
  },

  projects: {
    title: 'Projects',
    summary:
      'Projects are a lightweight, optional grouping dimension: group related services (per product, per environment, per customer) and filter the panel by them with the top-bar chips.',
    sections: [
      {
        heading: 'Using projects',
        bullets: [
          'Create a project and tag services with it — a service can be in one project at a time alongside its workspace and labels.',
          'Combine filters: workspace AND project AND labels compose across groups (OR within one group).',
          'Projects can carry shared environment variables that every member service receives.',
        ],
        tip: 'A common pattern: workspace = team or tenant, project = product or stage (staging/production), labels = free-form attributes like "beta" or "customer-facing".',
      },
    ],
    related: [
      { label: 'Labels', helpId: 'labels' },
      { label: 'Workspaces', helpId: 'workspaces' },
      { label: 'Service · Environment', helpId: 'service.environment' },
      { label: 'Project & environment access', helpId: 'access-grants' },
    ],
  },

  labels: {
    title: 'Labels',
    summary:
      'Free-form, coloured cross-cutting tags. Labels are independent of workspaces and projects — ideal for attributes that cut across both, like "experimental", "customer-x" or "high-traffic".',
    sections: [
      {
        heading: 'Managing labels',
        steps: [
          'Create a label with a name and colour.',
          'Tag services with it from the service Overview tab or the lists.',
          'Use the label chip in the top bar to filter every view down to matching services.',
        ],
        tip: 'Rename or recolour a label here and every tagged service follows — no need to touch the services themselves.',
      },
    ],
    related: [
      { label: 'Projects', helpId: 'projects' },
      { label: 'Services list', helpId: 'services' },
    ],
  },
};
