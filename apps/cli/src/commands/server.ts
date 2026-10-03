import { c, error, header, info, kv, spinner, success } from '../lib/format.js';
import {
  getContainerState,
  getServerLogs,
  isDockerAvailable,
  isServerReachable,
  startServerContainer,
  stopServerContainer,
  waitForServerReady,
} from '../lib/serverRunner.js';

export async function serverStartAction(opts: {
  port?: string;
  image?: string;
  name?: string;
}): Promise<void> {
  header('Start Local Server');

  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    return error('Docker is not installed or the Docker daemon is not running.');
  }

  const port = Number(opts.port ?? 3000);
  // `--port abc` used to mint `http://localhost:NaN` and a baffling docker
  // error two steps later — validate where it is typed.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return error(`Invalid port: ${opts.port ?? 3000} (expected 1–65535)`);
  }
  const containerName = opts.name ?? 'ninedeploy';
  const baseUrl = `http://localhost:${port}`;

  const reachable = await isServerReachable(baseUrl, 500);
  if (reachable) {
    info(`NineDeploy server is already running and reachable at ${baseUrl}`);
    return;
  }

  try {
    await spinner(`Starting NineDeploy server container (${containerName})`, async () => {
      await startServerContainer({
        port,
        image: opts.image,
        containerName,
      });
      const ready = await waitForServerReady(baseUrl, 30, 1000);
      if (!ready) {
        throw new Error('Server container started but failed to respond within 30s.');
      }
    });

    success(`NineDeploy server is now running at ${baseUrl}`);
    console.log(`\n  Next steps:`);
    console.log(`    1. Run ${c.cyan('ninedeploy setup')} to create your admin account.`);
    console.log(`    2. Open ${c.cyan(baseUrl)} to view the web dashboard.\n`);
  } catch (err) {
    error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function serverStopAction(opts: { name?: string } = {}): Promise<void> {
  header('Stop Local Server');

  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    return error('Docker is not installed or the Docker daemon is not running.');
  }

  const containerName = opts.name ?? 'ninedeploy';
  const state = await getContainerState(containerName);
  if (!state.exists || !state.running) {
    info(`Server container (${containerName}) is not running.`);
    return;
  }

  try {
    await spinner(`Stopping container ${containerName}`, () => stopServerContainer(containerName));
    success(`NineDeploy server stopped.`);
  } catch (err) {
    error(`Failed to stop server: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function serverStatusAction(opts: { name?: string; port?: string } = {}): Promise<void> {
  header('Local Server Status');

  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    kv('Docker', c.red('not available'));
    return;
  }

  const containerName = opts.name ?? 'ninedeploy';
  const port = Number(opts.port ?? 3000);
  const baseUrl = `http://localhost:${port}`;

  const state = await getContainerState(containerName);
  const reachable = await isServerReachable(baseUrl, 800);

  kv('Container', containerName);
  kv('Container ID', state.id ?? c.gray('—'));
  kv('Docker Status', state.running ? c.green(state.status) : c.yellow(state.status));
  kv('HTTP API', reachable ? c.green(`reachable @ ${baseUrl}`) : c.red(`unreachable @ ${baseUrl}`));
  console.log();
}

export async function serverLogsAction(opts: { name?: string; lines?: string } = {}): Promise<void> {
  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    return error('Docker is not installed or the Docker daemon is not running.');
  }

  const containerName = opts.name ?? 'ninedeploy';
  const lines = Number(opts.lines ?? 50);

  try {
    const logs = await getServerLogs(containerName, lines);
    if (!logs.trim()) {
      console.log(c.gray('  (no logs recorded)'));
      return;
    }
    console.log(logs);
  } catch (err) {
    error(`Failed to get server logs: ${err instanceof Error ? err.message : String(err)}`);
  }
}
