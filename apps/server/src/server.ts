import { buildApp } from './app.js';
import { config } from './config.js';

async function main(): Promise<void> {
  // r175: the image's default command is this file. A node started with
  // NINEDEPLOY_AGENT=1 must run the agent, never boot a second panel with an
  // empty database on the node.
  if (process.env['NINEDEPLOY_AGENT'] === '1') {
    await import('./agent.js'); // self-boots on the same flag
    return;
  }
  const app = await buildApp();

  app.addHook('onClose', async () => {
    app.log.info('NineDeploy shutting down');
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`NineDeploy API listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'received signal, closing');
    void app.close().finally(() => process.exit(0));
  };
  // r168: a stray rejected promise in a fire-and-forget path (plugin
  // listeners, notifiers) must be logged, not take the panel — and every
  // in-flight deploy — down with it.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
