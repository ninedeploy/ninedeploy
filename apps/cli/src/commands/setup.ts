import { createClient, NineDeployError } from '@ninedeploy/sdk';
import { loadConfig, saveConfig } from '../config.js';
import { prompt, promptHidden } from '../prompts.js';
import {
  isDockerAvailable,
  isServerReachable,
  normalizeServerUrl,
  startServerContainer,
  waitForServerReady,
} from '../lib/serverRunner.js';
import { spinner, success } from '../lib/format.js';

/** `ninedeploy setup` — create the first admin user on a fresh instance. */
export async function setupAction(): Promise<void> {
  const existing = loadConfig();
  const rawUrl = await prompt('Server URL', existing.baseUrl);
  const baseUrl = normalizeServerUrl(rawUrl);

  // If local host and not currently reachable, check if user wants to bootstrap it via Docker
  const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  if (isLocal) {
    const reachable = await isServerReachable(baseUrl, 600);
    if (!reachable) {
      const dockerOk = await isDockerAvailable();
      if (dockerOk) {
        console.log(`\n  ℹ No NineDeploy server detected at ${baseUrl}`);
        const startDocker = (await prompt('  Start a local NineDeploy server with Docker now? (Y/n)', 'Y')).toLowerCase().startsWith('y');
        if (startDocker) {
          try {
            await spinner('Starting local NineDeploy server container', async () => {
              const url = new URL(baseUrl);
              const port = url.port ? Number(url.port) : 3000;
              await startServerContainer({ port });
              const ready = await waitForServerReady(baseUrl, 30, 1000);
              if (!ready) throw new Error('Server container did not become ready in 30s');
            });
            success(`Server is ready at ${baseUrl}\n`);
          } catch (err) {
            console.error(`  ✗ Failed to start Docker container: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  const email = await prompt('Admin email');
  if (!email) {
    console.error('Email is required.');
    process.exitCode = 1;
    return;
  }
  const name = (await prompt('Display name (optional)')) || undefined;
  const password = await promptHidden('Password (min 8 chars)');
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }

  const client = createClient({ baseUrl });
  try {
    const session = await client.auth.setup({ email, password, name });
    // Both tokens: the access token alone dies with the 15-minute TTL.
    saveConfig({ baseUrl, token: session.tokens.accessToken, refreshToken: session.tokens.refreshToken });
    console.log(`✓ Admin account created: ${session.user.email}`);
    console.log('  Credentials saved — you are logged in.');
  } catch (err) {
    if (err instanceof NineDeployError) {
      console.error(`✗ Setup failed (${err.status}): ${err.message}`);
      if (err.status === 409) console.error('  The instance already has an admin user.');
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('✗ Setup failed:', msg);
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
        console.error(`  Could not connect to NineDeploy server at ${baseUrl}. Ensure the server is running.`);
      }
    }
    process.exitCode = 1;
  }
}
