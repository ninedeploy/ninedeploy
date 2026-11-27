import fp from 'fastify-plugin';
import {
  ensureNetwork,
  ensureTraefik,
  materialiseCertificatesFile,
  traefikInputs,
  writeDynamicConfig,
} from '../engine/proxy.js';
import { materialiseCustomConfig } from '../lib/traefikCustomConfig.js';
import { detectPanelOnNetwork, joinPanelNetwork, panelRunsInContainer } from '../lib/panelUpstream.js';
import { configuredPanelDomain } from '../lib/panelDomain.js';
import { recoverProxySettings } from '../lib/proxySettingApply.js';

/**
 * Ensures the shared Docker network, the Traefik reverse proxy, and the dynamic
 * routing config are ready when the server starts.
 */
export default fp(
  async (fastify) => {
    /** True when Traefik was (re)started or its route file was re-seeded empty. */
    const healTraefik = async (component: string): Promise<boolean> => {
      const log = (line: string) => fastify.log.info({ component }, line);
      await ensureNetwork(log);
      // 0.15: every static input, the traffic-analytics switch included
      // (traefikInputs keeps the ACME/DNS read fallbacks this used to inline).
      const t = await traefikInputs(fastify.db);
      return ensureTraefik(log, t.acmeEmail, t.dns, t);
    };

    /**
     * 0.16.11: whether an earlier join put the panel container on the proxy's
     * network, so a sleeping service's routes stay right. With a panel domain
     * the panel joins now, before routes are written: Traefik reaches it under
     * its alias, so the domain answers whatever address the panel port is
     * published on. True when it joined in this call.
     */
    const joinForPanelDomain = async (): Promise<boolean> => {
      if (!panelRunsInContainer() || (await detectPanelOnNetwork())) return false;
      if (!(await configuredPanelDomain(fastify.db).catch(() => null))) return false;
      const joined = await joinPanelNetwork();
      if (joined) fastify.log.info({ component: 'infra' }, `panel container joined the proxy network: its domain does not depend on the published port`);
      return joined;
    };

    fastify.addHook('onReady', async () => {
      // 0.14 (M12): the database is the source of truth for the operator's
      // custom config and uploaded certificates. Re-create both files BEFORE
      // the heal below may (re)start Traefik, so it starts with them. Neither
      // step throws.
      await materialiseCustomConfig(fastify.db, (line) => fastify.log.warn({ component: 'infra' }, line));
      await materialiseCertificatesFile(fastify.db);
      // A transient docker outage at boot must not crash-exit the panel: the
      // infra heal stays failed-open and the 5-minute watchdog below is the
      // recovery path (matching how every other background subsystem treats a
      // daemon-down moment).
      try {
        await healTraefik('infra');
      } catch (err) {
        fastify.log.error({ err }, 'traefik bootstrap failed (docker unreachable?) — deferring to the watchdog');
      }
      await joinForPanelDomain();
      await recoverProxySettings(fastify.db).catch((err: unknown) => fastify.log.error({ err }, 'proxy setting restoration remains unconfirmed'));
      await writeDynamicConfig(fastify.db).catch((err) =>
        fastify.log.error({ err }, 'failed to write traefik dynamic config'),
      );
    });

    // Periodic self-healing watchdog: checks every 5 minutes and revives Traefik if stopped
    const watchdogTimer = setInterval(async () => {
      try {
        // r363: a Traefik the watchdog had to (re)start — the boot heal failed
        // because Docker was down, or the container died — gets the current
        // routes rendered again. The heal only ever seeds an EMPTY route file,
        // so without this every domain answered 404 until the next deploy or
        // domain change happened to rewrite it. A panel that joined the network
        // now, after a boot that could not, gets them again for the same reason.
        const healed = await healTraefik('traefik-watchdog');
        const joined = await joinForPanelDomain();
        if (healed || joined) {
          await writeDynamicConfig(fastify.db);
        }
        await recoverProxySettings(fastify.db);
      } catch (err) {
        fastify.log.warn({ err }, 'traefik watchdog check failed');
      }
    }, 5 * 60 * 1000);
    watchdogTimer.unref();

    fastify.addHook('onClose', async () => {
      clearInterval(watchdogTimer);
    });
  },
  { name: 'ninedeploy-traefik' },
);
