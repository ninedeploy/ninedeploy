import type { FastifyPluginAsync } from 'fastify';
import { register } from '@ninedeploy/schemas';
import { createFirstAdmin } from './auth.js';
import { authRoutes } from './auth.js';
import { aboutRoutes } from './about.js';
import { activityRoutes } from './activity.js';
import { alertRoutes } from './alerts.js';
import { dashboardRoutes } from './dashboard.js';
import { attachmentRoutes, databasesRoutes } from './databases.js';
import { environmentRoutes } from './environments.js';
import { aiRoutes } from './ai.js';
import { studioProxyRoutes } from './studioProxy.js';
import { backupRoutes, databaseBackupRoutes } from './backups.js';
import { pgbouncerRoutes } from './pgbouncer.js';
import { logSearchRoutes } from './logSearch.js';
import { backupDestinationRoutes } from './backupDestinations.js';
import { buildCacheRoutes } from './buildCache.js';
import { brandingRoutes } from './branding.js';
import { configPresetsRoutes } from './configPresets.js';
import { deploysRoutes } from './deploys.js';
import { domainIndexRoutes } from './domainIndex.js';
import { domainPresetsRoutes } from './domainPresets.js';
import { domainsRoutes } from './domains.js';
import { domainTransferStartRoutes, domainTransferTokenRoutes } from './domainTransfers.js';
import { envRoutes, envSearchRoutes, projectEnvRoutes } from './env.js';
import { hookReceiveRoutes, webhookMgmtRoutes } from './hooks.js';
import { insightsRoutes, serviceInsightsRoutes } from './insights.js';
import { jobRoutes } from './jobs.js';
import { serverRoutes } from './servers.js';
import { projectRoutes } from './projects.js';
import { notificationRoutes } from './notifications.js';
import { networkRoutes } from './networks.js';
import { orchestratorsRoutes } from './orchestrators.js';
import { egressRoutes } from './egress.js';
import { ssoRoutes } from './sso.js';
import { metricRoutes, statsRoutes } from './stats.js';
import { metricHistoryRoutes } from './metricHistory.js';
import { servicesRoutes } from './services.js';
import { manifestRoutes } from './manifest.js';
import { serviceMigrationRoutes } from './serviceMigration.js';
import { serviceVolumesRoutes } from './serviceVolumes.js';
import { settingsRoutes } from './settings.js';
import { configCenterRoutes } from './configCenter.js';
import { pluginRoutes } from './plugins.js';
import { menuRoutes } from './menus.js';
import { sourcesRoutes } from './sources.js';
import { systemRoutes } from './resources.js';
import { templateRoutes } from './templates.js';
import { topologyRoutes } from './topology.js';
import { tunnelRoutes } from './tunnels.js';
import { traefikRoutes } from './traefik.js';
import { demoRoutes } from './demo.js';
import { userRoutes } from './users.js';
import { volumeRoutes } from './volumes.js';
import { volumeBackupRoutes } from './volumeBackups.js';
import { containerRoutes } from './containers.js';
import { logDrainRoutes } from './logDrains.js';
import { housekeepingRoutes } from './housekeeping.js';
import { housekeepingImageRoutes } from './images.js';
import { doctorRoutes } from './doctor.js';
import { workspaceRoutes } from './workspaces.js';
import { emailTemplateRoutes } from './emailTemplates.js';
import { firewallRoutes } from './firewall.js';
import { acceptInvitationRoutes, invitationRoutes, publicInvitationRoutes } from './invitations.js';
import { labelRoutes } from './labels.js';
import { serviceTagRoutes } from './serviceTags.js';

/** All versioned API routes, mounted under /v1. */
export const apiRoutes: FastifyPluginAsync = async (app) => {
  // Bootstrap: create the first admin user. Only succeeds when no users exist.
  // Rate-limited tighter than the global default to deter setup-race attacks.
  app.post('/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) =>
    createFirstAdmin(app.db, register.parse(req.body)),
  );

  // Public webhook receiver (auto-deploy on verified push).
  await app.register(hookReceiveRoutes, { prefix: '/hooks' });

  await app.register(authRoutes, { prefix: '/auth' });
  // Public invitation routes (token-only access) MUST be registered before the
  // authenticated workspace routes so that the unmatched :token path resolves
  // here, not as a /workspaces/:id sub-route.
  await app.register(publicInvitationRoutes);
  // Authenticated accept route — public path, but requires a valid session.
  await app.register(acceptInvitationRoutes);
  await app.register(workspaceRoutes, { prefix: '/workspaces' });
  // Email template overrides (G-30) — workspace-scoped.
  // The /:wid path is owned by workspaceRoutes; the new
  // module re-uses it as the prefix and the routes add
  // the /:wid/email-templates suffix.
  await app.register(emailTemplateRoutes, { prefix: '/workspaces' });
  // Workspace-scoped invitation management (auth required) piggy-backs on the
  // workspaces prefix so callers see a single /v1/workspaces/:id/invitations.
  await app.register(invitationRoutes, { prefix: '/workspaces' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(demoRoutes, { prefix: '/demo' });
  await app.register(projectRoutes, { prefix: '/projects' });
  await app.register(projectEnvRoutes, { prefix: '/projects' });
  await app.register(activityRoutes, { prefix: '/activity' });
  await app.register(alertRoutes, { prefix: '/alerts' });
  await app.register(aboutRoutes, { prefix: '/about' });
  await app.register(notificationRoutes, { prefix: '/notifications' });
  await app.register(databasesRoutes, { prefix: '/databases' });
  await app.register(databaseBackupRoutes, { prefix: '/databases' });
  // Deployment lanes (production / staging / development) per workspace.
  await app.register(environmentRoutes, { prefix: '/environments' });
  await app.register(aiRoutes, { prefix: '/ai' });
  // Same-origin reverse proxy for the database Web Studio — serves the
  // loopback-bound studio container through the panel origin so the
  // embedded iframe works under HTTPS and CSP, and rides the panel auth.
  await app.register(studioProxyRoutes, { prefix: '/databases' });
  // PgBouncer sidecar (G-32) — per-database enable /
  // disable / status. Mounted under the same /databases
  // prefix as the rest of the per-DB routes.
  await app.register(pgbouncerRoutes, { prefix: '/databases' });
  await app.register(backupRoutes, { prefix: '/backups' });
  await app.register(backupDestinationRoutes, { prefix: '/backup-destinations' });
  await app.register(domainIndexRoutes, { prefix: '/domains' });
  // Domain transfer (G-29): the start route lives next to
  // the other /v1/domains/* routes, the token-based
  // preview / accept / cancel live under /domain-transfers.
  await app.register(domainTransferStartRoutes, { prefix: '/domains' });
  await app.register(domainTransferTokenRoutes, { prefix: '/domain-transfers' });
  await app.register(domainPresetsRoutes, { prefix: '/domain-presets' });
  await app.register(configPresetsRoutes, { prefix: '/config-presets' });
  await app.register(networkRoutes, { prefix: '/networks' });
  await app.register(volumeRoutes, { prefix: '/volumes' });
  await app.register(volumeBackupRoutes, { prefix: '/volumes' });
  await app.register(containerRoutes, { prefix: '/containers' });
  await app.register(statsRoutes, { prefix: '/stats' });
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.register(systemRoutes, { prefix: '/system' });
  await app.register(sourcesRoutes, { prefix: '/sources' });
  await app.register(insightsRoutes, { prefix: '/insights' });
  await app.register(settingsRoutes, { prefix: '/settings' });
  await app.register(firewallRoutes, { prefix: '/firewall' });
  await app.register(configCenterRoutes, { prefix: '/config' });
  await app.register(buildCacheRoutes, { prefix: '/build-cache' });
  await app.register(orchestratorsRoutes, { prefix: '/orchestrators' });
  await app.register(brandingRoutes, { prefix: '/branding' });
  await app.register(egressRoutes, { prefix: '/egress' });
  await app.register(ssoRoutes, { prefix: '/sso' });
  await app.register(pluginRoutes, { prefix: '/plugins' });
  await app.register(menuRoutes, { prefix: '/menus' });
  await app.register(topologyRoutes, { prefix: '/topology' });
  await app.register(tunnelRoutes, { prefix: '/tunnels' });
  await app.register(templateRoutes, { prefix: '/templates' });
  await app.register(servicesRoutes, { prefix: '/services' });
  await app.register(manifestRoutes, { prefix: '/services' });
  await app.register(serviceVolumesRoutes, { prefix: '/services' });
  await app.register(deploysRoutes, { prefix: '/services' });
  await app.register(domainsRoutes, { prefix: '/services' });
  await app.register(webhookMgmtRoutes, { prefix: '/services' });
  await app.register(attachmentRoutes, { prefix: '/services' });
  await app.register(envRoutes, { prefix: '/services' });
  await app.register(serviceInsightsRoutes, { prefix: '/services' });
  // Historical CPU/memory series for one service. `metricRoutes` is a separate
  // export from stats.ts and was never registered: `GET /v1/services/:id/metrics`
  // 404'd, so the charts on Monitoring and the service Overview tab had nothing
  // to read while the collector kept writing a row every 30 seconds.
  await app.register(metricRoutes, { prefix: '/services' });
  await app.register(metricHistoryRoutes, { prefix: '/metric-history' });
  await app.register(envSearchRoutes, { prefix: '/env' });
  await app.register(jobRoutes, { prefix: '/services' });
  await app.register(serverRoutes, { prefix: '/servers' });
  await app.register(logDrainRoutes, { prefix: '/log-drains' });
  // Cluster log search (G-16) — round-trips to the
  // configured Loki drain. Sits next to the log-drain
  // admin routes because it shares the URL prefix; the
  // route itself is member-only.
  await app.register(logSearchRoutes, { prefix: '/log-drains' });
  await app.register(housekeepingRoutes, { prefix: '/housekeeping' });
  // Doctor — system-wide analysis + guarded repairs. Sits next to
  // housekeeping as the other admin "clean up my host" surface.
  await app.register(doctorRoutes, { prefix: '/doctor' });
  // Image inventory + retention — sibling routes to auto-prune
  // (both live under /housekeeping). Mounted after
  // housekeepingRoutes so the existing `/prune` literal path
  // resolves first and is not shadowed by the new `/images`
  // namespace.
  await app.register(housekeepingImageRoutes, { prefix: '/housekeeping' });
  await app.register(serviceMigrationRoutes, { prefix: '/services' });
  // /services/:id/tags is mounted before /services to keep the literal path
  // ahead of any wildcard :id handler. The serviceTags module also registers
  // under /labels so the new endpoints share a router.
  await app.register(serviceTagRoutes, { prefix: '/services' });
  await app.register(labelRoutes, { prefix: '/labels' });
  await app.register(traefikRoutes, { prefix: '' });
};
