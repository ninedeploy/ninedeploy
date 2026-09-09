import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servers, type DB } from '@ninedeploy/db';
import type {
  ServerBootstrapResult,
  ServerBootstrapStep,
  ServerSshBootstrap,
  ServerSshTest,
  ServerSshTestResult,
} from '@ninedeploy/schemas';
import { run } from '../lib/exec.js';
import { encrypt } from '../lib/crypto.js';
import { agentPing, generateAgentToken } from '../lib/agentClient.js';
import { VERSION } from '../version.js';

// In-memory log cache for recently run bootstraps (keyed by serverId or host)
const bootstrapLogStore = new Map<string, string[]>();

export function getBootstrapLogs(key: string | number): string[] {
  return bootstrapLogStore.get(String(key)) ?? [];
}

export function setBootstrapLogs(key: string | number, logs: string[]): void {
  bootstrapLogStore.set(String(key), logs);
}

export function clearBootstrapLogs(key: string | number): void {
  bootstrapLogStore.delete(String(key));
}

interface SshExecOptions {
  host: string;
  sshPort: number;
  sshUser: string;
  authType: 'key' | 'password';
  sshKey?: string;
  sshPassword?: string;
  timeoutMs?: number;
}

/**
 * Execute a remote command via SSH using OpenSSH client.
 * Key authentication writes a temporary file with restricted permissions.
 *
 * Password authentication is deliberately REFUSED: password prompting is only
 * possible through sshpass/expect (an extra host dependency we do not ship),
 * and the `BatchMode=yes` below disables it anyway — so the schema-accepted
 * `sshPassword` field was a silent always-fail. Fail loudly instead.
 */
export async function runSshCommand(
  opts: SshExecOptions,
  command: string,
  onLine?: (line: string) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (opts.authType === 'password') {
    throw new Error(
      'Password authentication is not supported for zero-touch bootstrap: install an SSH public key on the target host and use key auth (the stored sshPassword field is never transmitted).',
    );
  }
  let keyPath: string | null = null;
  const lines: string[] = [];
  const lineSink = (l: string) => {
    lines.push(l);
    if (onLine) onLine(l);
  };

  try {
    const args: string[] = [
      '-p',
      String(opts.sshPort || 22),
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-o',
      `ConnectTimeout=${Math.max(1, Math.floor((opts.timeoutMs ?? 15000) / 1000))}`,
      '-o',
      'BatchMode=yes',
    ];

    if (opts.authType === 'key' && opts.sshKey) {
      const id = randomBytes(8).toString('hex');
      keyPath = join(tmpdir(), `nd_ssh_${id}.key`);
      await fs.writeFile(keyPath, opts.sshKey, { mode: 0o600 });
      args.push('-i', keyPath);
    }

    const target = `${opts.sshUser || 'root'}@${opts.host}`;
    args.push(target, command);

    await run('ssh', args, {
      timeoutMs: opts.timeoutMs ?? 60000,
    }, lineSink);

    const output = lines.join('\n');
    return {
      exitCode: 0,
      stdout: output,
      stderr: '',
    };
  } finally {
    if (keyPath) {
      try {
        await fs.unlink(keyPath);
      } catch {
        // ignore unlink error on temp key
      }
    }
  }
}

/**
 * Probe an SSH host to verify connectivity, detect operating system,
 * and check whether Docker is already installed.
 */
export async function testSshConnection(input: ServerSshTest): Promise<ServerSshTestResult> {
  const start = Date.now();
  const probeScript = 'uname -s -m && (cat /etc/os-release 2>/dev/null || true) && (docker --version 2>/dev/null || true)';

  try {
    const res = await runSshCommand(
      {
        host: input.host,
        sshPort: input.sshPort,
        sshUser: input.sshUser,
        authType: input.authType,
        sshKey: input.sshKey,
        sshPassword: input.sshPassword,
        timeoutMs: 10000,
      },
      probeScript,
    );

    const latencyMs = Date.now() - start;
    const stdout = res.stdout;
    let os = 'Linux';
    const osMatch = stdout.match(/PRETTY_NAME="?([^"\n]+)"?/);
    if (osMatch?.[1]) {
      os = osMatch[1];
    } else {
      const unameMatch = stdout.match(/(Linux [^\n]+)/);
      if (unameMatch?.[1]) {
        os = unameMatch[1];
      }
    }

    const dockerMatch = stdout.match(/Docker version ([0-9.]+)/i);
    const dockerInstalled = !!dockerMatch;
    const dockerVersion = dockerMatch ? dockerMatch[1] : undefined;

    return {
      ok: true,
      message: `Connected successfully to ${input.sshUser}@${input.host}:${input.sshPort}`,
      os,
      dockerInstalled,
      dockerVersion,
      latencyMs,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'SSH Connection probe failed',
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Zero-Touch Remote Server Bootstrapper:
 * Connects via SSH, verifies/installs Docker, starts NineDeploy Agent,
 * registers in DB, and verifies connectivity handshake.
 */
export async function bootstrapServer(
  db: DB,
  input: ServerSshBootstrap,
  onStep?: (step: ServerBootstrapStep) => void,
  onLog?: (line: string) => void,
): Promise<ServerBootstrapResult> {
  const logs: string[] = [];
  const steps: ServerBootstrapStep[] = [];

  const emitLog = (l: string) => {
    logs.push(l);
    if (onLog) onLog(l);
  };

  const emitStep = (
    step: ServerBootstrapStep['step'],
    status: ServerBootstrapStep['status'],
    message: string,
  ) => {
    const s: ServerBootstrapStep = {
      step,
      status,
      message,
      timestamp: new Date().toISOString(),
    };
    steps.push(s);
    emitLog(`[${step.toUpperCase()}] ${status.toUpperCase()}: ${message}`);
    if (onStep) onStep(s);
  };

  const sshOpts: SshExecOptions = {
    host: input.host,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    authType: input.authType,
    sshKey: input.sshKey,
    sshPassword: input.sshPassword,
  };

  try {
    // ── Step 1: Connecting ──────────────────────────────────────────────────
    emitStep('connecting', 'running', `Connecting to ${input.sshUser}@${input.host}:${input.sshPort} via SSH...`);
    const connCheck = await testSshConnection(input);
    if (!connCheck.ok) {
      emitStep('connecting', 'failed', connCheck.message);
      return { ok: false, steps, logs, error: connCheck.message };
    }
    emitStep('connecting', 'success', `Connected (${connCheck.latencyMs}ms latency)`);

    // ── Step 2: OS Detection ────────────────────────────────────────────────
    emitStep('os_detect', 'running', 'Detecting remote OS and architecture...');
    emitStep('os_detect', 'success', `Target operating system: ${connCheck.os}`);

    // ── Step 3: Docker Check & Install ──────────────────────────────────────
    emitStep('docker_check', 'running', 'Checking Docker daemon status...');
    if (connCheck.dockerInstalled) {
      emitStep('docker_check', 'success', `Docker ${connCheck.dockerVersion} is installed and active.`);
    } else {
      if (!input.installDocker) {
        emitStep('docker_check', 'failed', 'Docker is not installed on the remote host and auto-install was disabled.');
        return { ok: false, steps, logs, error: 'Docker is missing on remote host.' };
      }
      emitStep('docker_install', 'running', 'Installing Docker via get.docker.com automated bootstrap script...');
      await runSshCommand(
        sshOpts,
        'curl -fsSL https://get.docker.com | sh && (systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true)',
        emitLog,
      );
      emitStep('docker_install', 'success', 'Docker successfully installed and started');
    }

    // ── Step 4: Deploy Agent ────────────────────────────────────────────────
    emitStep('agent_deploy', 'running', `Deploying NineDeploy Node Agent on port ${input.agentPort}...`);
    const agentToken = generateAgentToken();
    const tokenSha256 = createHash('sha256').update(agentToken).digest('hex');

    const agentStartCmd = [
      'docker stop ninedeploy-agent 2>/dev/null || true',
      'docker rm -f ninedeploy-agent 2>/dev/null || true',
      // The agent is THIS SAME binary in agent mode, published under the
      // panel's own repository — `ghcr.io/ninedeploy/server` does not exist,
      // so provisioning silently failed at pull time. Tagged with the running
      // core's release version so the node agent matches the core's protocol
      // (seal/nonce) instead of floating on :latest.
      `docker run -d --name ninedeploy-agent --restart unless-stopped -p ${input.agentPort}:4600 -v /var/run/docker.sock:/var/run/docker.sock -e NINEDEPLOY_AGENT=1 -e NINEDEPLOY_AGENT_TOKEN=${tokenSha256} -e NINEDEPLOY_AGENT_PORT=4600 ghcr.io/ninedeploy/ninedeploy:v${VERSION}`,
    ].join(' && ');

    await runSshCommand(sshOpts, agentStartCmd, emitLog);
    emitStep('agent_deploy', 'success', 'Agent container started successfully');

    // ── Step 5: Verify & Database Registration ──────────────────────────────
    emitStep('verify', 'running', 'Performing agent authentication handshake...');
    try {
      await agentPing(input.host, input.agentPort, agentToken);
    } catch {
      emitLog('Initial ping timed out. Waiting 2s for container startup and retrying...');
      await new Promise((r) => setTimeout(r, 2000));
      await agentPing(input.host, input.agentPort, agentToken);
    }

    const [row] = await db
      .insert(servers)
      .values({
        name: input.name,
        host: input.host,
        port: input.agentPort,
        tokenEncrypted: encrypt(agentToken),
        status: 'online',
        lastSeenAt: new Date(),
      })
      .returning();

    if (!row) {
      emitStep('verify', 'failed', 'Could not record server in local database');
      return { ok: false, steps, logs, error: 'Database save failed' };
    }

    emitStep('verify', 'success', `Server #${row.id} authenticated and online`);
    emitStep('done', 'success', `Node "${input.name}" successfully onboarded!`);

    setBootstrapLogs(row.id, logs);

    return {
      ok: true,
      serverId: row.id,
      serverName: input.name,
      steps,
      logs,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unexpected bootstrap error';
    emitStep('error', 'failed', errorMsg);
    return {
      ok: false,
      steps,
      logs,
      error: errorMsg,
    };
  }
}
