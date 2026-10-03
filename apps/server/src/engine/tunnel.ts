import type { Tunnel } from '@ninedeploy/db';
import { decrypt } from '../lib/crypto.js';
import { run } from '../lib/exec.js';
import { ensureDockerImage } from '../lib/dockerPull.js';
import { writeSecretFile } from '../lib/secretFile.js';
import { NETWORK } from './proxy.js';

// Version-pinned: cloudflared holds the TUNNEL_TOKEN (origin access), so a
// floating :latest would let a registry-tag swap silently re-route traffic.
const CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:2026.8.3';

/** Run a Cloudflare Tunnel (cloudflared) connected to the shared network. */
export async function startTunnel(t: Tunnel, log: (line: string) => void): Promise<void> {
  await ensureDockerImage(CLOUDFLARED_IMAGE, log);
  const token = decrypt(t.tokenEncrypted);
  // Pass the token via a temp env-file (mode 0600) instead of a `--token` argv
  // value, so the Cloudflare token never shows up in `ps` or `docker inspect`
  // for any local user. cloudflared reads it from the TUNNEL_TOKEN env. The file
  // is removed right after `docker run` (the value is already baked into the
  // container config by then).
  const envFile = writeSecretFile('nd-tunnel', 'tunnel.env', `TUNNEL_TOKEN=${token}\n`);
  log(`Starting Cloudflare Tunnel ${t.name} (${t.containerName}) …`);
  try {
    await run(
      'docker',
      [
        'run', '-d', '--name', t.containerName, '--network', NETWORK, '--restart', 'unless-stopped',
        '--env-file', envFile.path,
        CLOUDFLARED_IMAGE, 'tunnel', '--no-autoupdate', 'run',
      ],
      {},
      log,
    );
  } finally {
    envFile.cleanup();
  }
}

/** Stop + remove a tunnel container. */
export async function stopTunnel(t: Tunnel): Promise<void> {
  await run('docker', ['rm', '-f', t.containerName], {}, () => {}).catch(() => undefined);
}
