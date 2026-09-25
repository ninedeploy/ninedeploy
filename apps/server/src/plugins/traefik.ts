import fp from 'fastify-plugin';
import { ensureNetwork, ensureTraefik, getAcmeEmail, getDnsConfig, writeDynamicConfig } from '../engine/proxy.js';

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
      return ensureTraefik(
        log,
        await getAcmeEmail(fastify.db).catch(() => null),
        await getDnsConfig(fastify.db).catch(() => null),
      );
    };

    fastify.addHook('onReady', async () => {
      // A transient docker outage at boot must not crash-exit the panel: the
      // infra heal stays failed-open and the 5-minute watchdog below is the
      // recovery path (matching how every other background subsystem treats a
      // daemon-down moment).
      try {
        await healTraefik('infra');
      } catch (err) {
        fastify.log.error({ err }, 'traefik bootstrap failed (docker unreachable?) — deferring to the watchdog');
      }
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
        // domain change happened to rewrite it.
        if (await healTraefik('traefik-watchdog')) {
          await writeDynamicConfig(fastify.db);
        }
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
