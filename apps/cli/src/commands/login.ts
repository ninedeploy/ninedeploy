import { createClient, NineDeployError } from '@ninedeploy/sdk';
import { loadConfig, saveConfig } from '../config.js';
import { prompt, promptHidden } from '../prompts.js';
import { normalizeServerUrl } from '../lib/serverRunner.js';

/** `ninedeploy login` — authenticate and persist the access token locally. */
export async function loginAction(): Promise<void> {
  const existing = loadConfig();
  const rawUrl = await prompt('Server URL', existing.baseUrl);
  const baseUrl = normalizeServerUrl(rawUrl);
  const email = await prompt('Email');
  if (!email) {
    console.error('Email is required.');
    process.exitCode = 1;
    return;
  }
  const password = await promptHidden('Password');
  if (!password) {
    console.error('Password is required.');
    process.exitCode = 1;
    return;
  }

  const client = createClient({ baseUrl });
  try {
    // r197: a 2FA account answers `totp_required`; the CLI used to print
    // "Login failed (401)" with no way to supply the code, so any operator who
    // enabled 2FA could not use the CLI at all.
    let session: Awaited<ReturnType<typeof client.auth.login>>;
    try {
      session = await client.auth.login({ email, password });
    } catch (err) {
      if (!(err instanceof NineDeployError) || err.code !== 'totp_required') throw err;
      const totpCode = (await prompt('Two-factor code')).trim();
      if (!totpCode) {
        console.error('Two-factor code is required.');
        process.exitCode = 1;
        return;
      }
      session = await client.auth.login({ email, password, totpCode });
    }
    // Both tokens: the access token alone dies with the 15-minute TTL and
    // every scripted session used to die with it (client.ts now refreshes).
    saveConfig({ baseUrl, token: session.tokens.accessToken, refreshToken: session.tokens.refreshToken });
    console.log(`✓ Logged in as ${session.user.email} (${session.user.isOperator ? 'operator' : 'member'})`);
  } catch (err) {
    if (err instanceof NineDeployError) {
      console.error(`✗ Login failed (${err.status}): ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('✗ Login failed:', msg);
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
        console.error(`  Could not reach NineDeploy server at ${baseUrl}. Check your URL or ensure the server is running.`);
      }
    }
    process.exitCode = 1;
  }
}
