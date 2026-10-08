import {
  alertRuleCreate,
  alertRulePatch,
  jobCreate,
  jobPatch,
  notificationChannelCreate,
  notificationChannelPatch,
  webhookCreate,
} from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment: automation (routes that predate 0.15). Owner: task T4.
 * Floors mirror the authorization matrix (`test/authzMatrix.test.ts`, which
 * cross-checks every entry); bodies name the zod schema the handler parses.
 */
export const automationSpecs: RouteSpecMap = {
  'GET /v1/services/:id/webhooks': {
    summary: "List a service's deploy webhooks",
    tag: 'webhooks',
    floor: 'viewer',
    responseType: 'Webhook[]',
    sensitive: true,
  },
  'POST /v1/services/:id/webhooks': {
    summary: 'Create a deploy webhook',
    tag: 'webhooks',
    floor: 'admin',
    body: webhookCreate,
    responseType: 'CreatedWebhook',
    validation: 'zod',
    sensitive: true,
  },
  'DELETE /v1/services/:id/webhooks/:hookId': {
    summary: 'Delete a deploy webhook',
    tag: 'webhooks',
    floor: 'admin',
  },
  'POST /v1/hooks/:id': {
    summary: 'Receive a signed push (auto-deploy)',
    tag: 'webhooks',
    floor: 'token',
  },
  'POST /v1/hooks/github-app/:hookKey': {
    summary: 'Receive a GitHub App delivery',
    tag: 'webhooks',
    floor: 'token',
  },
  'GET /v1/services/:id/jobs': {
    summary: "List a service's scheduled jobs",
    tag: 'jobs',
    floor: 'viewer',
    mcp: { name: 'list_jobs', description: 'Scheduled (cron) jobs of a service: name, schedule, kind, enabled state and last run.', readOnly: true },
  },
  'POST /v1/services/:id/jobs': {
    summary: 'Create a scheduled job',
    tag: 'jobs',
    floor: 'member',
    body: jobCreate,
    responseType: 'ScheduledJob',
    validation: 'zod',
  },
  'PATCH /v1/services/:id/jobs/:jobId': {
    summary: 'Update a scheduled job',
    tag: 'jobs',
    floor: 'member',
    body: jobPatch,
    responseType: 'ScheduledJob',
    validation: 'zod',
  },
  'DELETE /v1/services/:id/jobs/:jobId': {
    summary: 'Delete a scheduled job',
    tag: 'jobs',
    floor: 'member',
    responseType: '{ ok: boolean }',
  },
  'POST /v1/services/:id/jobs/:jobId/run': {
    summary: 'Run a scheduled job now',
    tag: 'jobs',
    floor: 'member',
    responseType: '{ ok: boolean }',
  },
  'GET /v1/services/:id/jobs/:jobId/runs': {
    summary: "A scheduled job's recent runs",
    tag: 'jobs',
    floor: 'viewer',
  },
  'GET /v1/alerts': {
    summary: 'List alert rules',
    tag: 'alerts',
    floor: 'authed',
  },
  'POST /v1/alerts': {
    summary: 'Create an alert rule',
    tag: 'alerts',
    floor: 'operator',
    body: alertRuleCreate,
    validation: 'zod',
  },
  'PATCH /v1/alerts/:id': {
    summary: 'Update an alert rule',
    tag: 'alerts',
    floor: 'operator',
    body: alertRulePatch,
    validation: 'zod',
  },
  'DELETE /v1/alerts/:id': {
    summary: 'Delete an alert rule',
    tag: 'alerts',
    floor: 'operator',
  },
  'GET /v1/notifications/channels': {
    summary: 'List notification channels',
    tag: 'notifications',
    floor: 'operator',
  },
  'POST /v1/notifications/channels': {
    summary: 'Create a notification channel',
    tag: 'notifications',
    floor: 'operator',
    body: notificationChannelCreate,
    validation: 'zod',
  },
  'PATCH /v1/notifications/channels/:id': {
    summary: 'Update a notification channel',
    tag: 'notifications',
    floor: 'operator',
    body: notificationChannelPatch,
    validation: 'zod',
  },
  'DELETE /v1/notifications/channels/:id': {
    summary: 'Delete a notification channel',
    tag: 'notifications',
    floor: 'operator',
  },
  'POST /v1/notifications/channels/:id/test': {
    summary: 'Send a test notification',
    tag: 'notifications',
    floor: 'operator',
  },
  'GET /v1/notifications/log': {
    summary: 'Recent notification deliveries',
    tag: 'notifications',
    floor: 'operator',
  },
};
