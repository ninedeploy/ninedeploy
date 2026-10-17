import { count, eq, inArray } from 'drizzle-orm';
import { backupDestinations, deployments, domains, githubApps, notificationChannels, services, sources } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { getAutoUrlConfig } from '../lib/autoUrl.js';
import { isOwnZone } from '../lib/domainVerification.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { getAcmeEmail } from '../engine/proxy.js';

/**
 * 0.16.1 Getting started: the instance operator's setup checklist on the
 * Dashboard — the Coolify-style "what is left before this panel is ready".
 * Every step is derived from state the panel already has; nothing is stored
 * except the operator's choice to hide the card.
 */

export const ONBOARDING_DISMISSED_KEY = 'onboarding_dismissed';

export type OnboardingStepId =
  | 'auto_url'
  | 'git_source'
  | 'first_service'
  | 'first_deploy'
  | 'custom_domain'
  | 'https'
  | 'notifications'
  | 'backups';

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
  /** Optional steps never block "complete". */
  optional: boolean;
}

const dismissBody = z.object({ dismissed: z.boolean() }).strict();

async function hasRow(promise: Promise<{ n: number }[]>): Promise<boolean> {
  const [row] = await promise;
  return (row?.n ?? 0) > 0;
}

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => {
    const db = app.db;
    const autoUrl = await getAutoUrlConfig(db);
    const [gitSource, githubApp, anyService, deployed, notifications, backups, acme, dismissed, liveDomains] = await Promise.all([
      hasRow(db.select({ n: count() }).from(sources).where(inArray(sources.type, ['github', 'gitlab', 'gitea', 'bitbucket', 'custom', 'github_app']))),
      hasRow(db.select({ n: count() }).from(githubApps)),
      hasRow(db.select({ n: count() }).from(services).where(eq(services.isEphemeralPreview, false))),
      // A deploy that went live at least once: still live, or replaced by a newer one.
      hasRow(db.select({ n: count() }).from(deployments).where(inArray(deployments.status, ['running', 'superseded']))),
      hasRow(db.select({ n: count() }).from(notificationChannels)),
      hasRow(db.select({ n: count() }).from(backupDestinations)),
      getAcmeEmail(db).catch(() => null),
      getSetting(db, ONBOARDING_DISMISSED_KEY, false),
      db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.status, 'active')),
    ]);
    // A domain of the operator's own, not one the panel minted (automatic
    // URLs, the env wildcard, the panel's own host).
    const customDomain = liveDomains.some((d) => !isOwnZone(d.hostname));
    const steps: OnboardingStep[] = [
      // Services need SOME way to be reached: automatic URLs, or a domain of the operator's own.
      { id: 'auto_url', done: autoUrl.mode !== 'off' || customDomain, optional: false },
      { id: 'git_source', done: gitSource || githubApp, optional: true },
      { id: 'first_service', done: anyService, optional: false },
      { id: 'first_deploy', done: deployed, optional: false },
      { id: 'custom_domain', done: customDomain, optional: true },
      { id: 'https', done: !!acme, optional: true },
      { id: 'notifications', done: notifications, optional: true },
      { id: 'backups', done: backups, optional: true },
    ];
    return {
      steps,
      completed: steps.filter((s) => s.done).length,
      total: steps.length,
      // Every required step done — the Dashboard stops nagging.
      ready: steps.every((s) => s.optional || s.done),
      dismissed,
      autoUrl,
    };
  });

  app.put('/dismissed', async (req) => {
    const { dismissed } = dismissBody.parse(req.body);
    await setSetting(app.db, ONBOARDING_DISMISSED_KEY, dismissed);
    void audit(app.db, req.user!.id, 'onboarding.dismiss', dismissed ? 'hidden' : 'shown');
    return { ok: true, dismissed };
  });
};
