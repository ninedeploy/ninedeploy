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
import { getSettingJson, setSettingJson } from '../lib/settings.js';
import { agentDockerRunCommand } from '@ninedeploy/schemas';

// In-memory log cache for recently run bootstraps (keyed by serverId or host).
// Bounded: each SSH bootstrap keeps its FULL log here, and re-provisioned
// hosts accumulate under fresh keys — an unbounded map grew for the process
// lifetime (r407).
const BOOTSTRAP_LOG_LIMIT = 25;
const bootstrapLogStore = new Map<string, string[]>();

export function getBootstrapLogs(key: string | number): string[] {
  return bootstrapLogStore.get(String(key)) ?? [];
}

export function setBootstrapLogs(key: string | number, logs: string[]): void {
  const k = String(key);
  // Re-insert so LRU order tracks recency, then trim the oldest overflow.
  bootstrapLogStore.delete(k);
  bootstrapLogStore.set(k, logs);
  while (bootstrapLogStore.size > BOOTSTRAP_LOG_LIMIT) {
    const oldest = bootstrapLogStore.keys().next().value;
    if (oldest === undefined) break;
    bootstrapLogStore.delete(oldest);
  }
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
  /**
   * r661: the host keys this host must present (`<type> <base64>` each). Given
   * → `StrictHostKeyChecking=yes` against exactly these; absent → the first
   * key the host presents is accepted and returned in `hostKeys`.
   */
  hostKeys?: string[];
}

/**
 * r663: one endpoint spelling per row — a pasted `host:port` loses its port.
 * The old pattern (`/:d+$/`) lacked its backslash and never matched, and a
 * bare IPv6 address ends in a GROUP, not a port, so it is left whole.
 */
export function normalizeNodeHost(raw: string): string {
  const host = raw.trim();
  return host.split(':').length === 2 ? host.replace(/:\d+$/, '') : host;
}

/**
 * r661: every ssh invocation pins host keys through this alias, so the
 * known_hosts lines do not depend on how the host or port were spelled.
 */
const HOST_KEY_ALIAS = 'ninedeploy-node';

/** r661: where the key a host presented on first contact is recorded. */
const hostKeySettingKey = (host: string, port: number) => `ssh.hostKeys:${host}:${port}`;

interface RecordedHostKeys {
  keys: string[];
  fingerprints: string[];
  recordedAt: string;
}

/** OpenSSH's `SHA256:<base64, unpadded>` fingerprint of a `<type> <base64>` key. */
export function sshKeyFingerprint(key: string): string | null {
  const blob = key.trim().split(/\s+/)[1];
  if (!blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** The `ssh_host_<type>_key.pub` file name part for a `<type> <base64>` key. */
function hostKeyFileType(key: string | undefined): string {
  const type = key?.split(' ')[0] ?? '';
  return type.startsWith('ecdsa-') ? 'ecdsa' : type === 'ssh-rsa' ? 'rsa' : 'ed25519';
}

/** Thrown when a host presents a key other than the pinned one. */
export class SshHostKeyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshHostKeyMismatchError';
  }
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
): Promise<{ exitCode: number; stdout: string; stderr: string; hostKeys: string[] }> {
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
  // r661: host keys used to be ignored outright (StrictHostKeyChecking=no,
  // UserKnownHostsFile=/dev/null), and the bootstrap's remote command carries
  // the agent token hash — the node's sealing key — so anyone able to answer
  // for the host on the network got it. Each call now gets a private
  // known_hosts: the pinned keys (strict), or empty with accept-new so the
  // key the host presents is captured for the caller to verify and record.
  const knownHostsDir = await fs.mkdtemp(join(tmpdir(), 'nd_ssh_kh_'));
  const knownHosts = join(knownHostsDir, 'known_hosts');
  const pinned = opts.hostKeys;
  await fs.writeFile(knownHosts, (pinned ?? []).map((k) => `${HOST_KEY_ALIAS} ${k}\n`).join(''), { mode: 0o600 });

  try {
    const args: string[] = [
      '-p',
      String(opts.sshPort || 22),
      '-o',
      `StrictHostKeyChecking=${pinned ? 'yes' : 'accept-new'}`,
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      `HostKeyAlias=${HOST_KEY_ALIAS}`,
      '-o',
      'HashKnownHosts=no',
      '-o',
      'UpdateHostKeys=no',
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

    try {
      await run('ssh', args, {
        timeoutMs: opts.timeoutMs ?? 60000,
      }, lineSink);
    } catch (err) {
      if (pinned && lines.some((l) => /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(l))) {
        throw new SshHostKeyMismatchError(
          `${opts.host}:${opts.sshPort || 22} presented an SSH host key that does not match the one recorded for it — ` +
            'this can be a machine-in-the-middle. If the host was reinstalled, read its new fingerprint ON the host ' +
            '(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) and enter it as the expected host key fingerprint to replace the record.',
        );
      }
      throw err;
    }

    const output = lines.join('\n');
    // The keys ssh wrote (accept-new) or was pinned to, as `<type> <base64>`.
    const hostKeys = (await fs.readFile(knownHosts, 'utf8').catch(() => ''))
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((parts) => parts.length >= 3 && parts[0] === HOST_KEY_ALIAS)
      .map((parts) => `${parts[1]} ${parts[2]}`);
    return {
      exitCode: 0,
      stdout: output,
      stderr: '',
      hostKeys,
    };
  } finally {
    if (keyPath) {
      try {
        await fs.unlink(keyPath);
      } catch {
        // ignore unlink error on temp key
      }
    }
    await fs.rm(knownHostsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * r661: decide which host keys an SSH session to `host:port` must accept,
 * run the harmless probe with that policy, and return what was verified.
 *
 *   expected fingerprint given → accept what the host presents, then refuse
 *     unless it matches (the operator's out-of-band value is the authority,
 *     and replaces an older record — that is how a reinstalled host rotates);
 *   a key recorded earlier     → strict: only that key is accepted;
 *   neither                    → trust on first use: record the key, and say
 *     so in the response so the operator can compare it.
 *
 * The probe sends nothing secret, so verifying after it is safe; everything
 * that does (the bootstrap's agent token) runs pinned to the verified key.
 */
async function probeWithHostKeyPolicy(
  input: ServerSshTest,
  db: DB | undefined,
  probeScript: string,
): Promise<{
  stdout: string;
  hostKeys: string[];
  fingerprint: string | undefined;
  trust: 'verified' | 'pinned' | 'first-use';
  warning?: string;
}> {
  const host = normalizeNodeHost(input.host);
  const port = input.sshPort || 22;
  const expected = input.hostKeyFingerprint;
  const recorded = !expected && db ? await getSettingJson<RecordedHostKeys>(db, hostKeySettingKey(host, port)) : null;
  const pinnedKeys = recorded?.keys?.length ? recorded.keys : undefined;
  const res = await runSshCommand(
    {
      host,
      sshPort: input.sshPort,
      sshUser: input.sshUser,
      authType: input.authType,
      sshKey: input.sshKey,
      sshPassword: input.sshPassword,
      timeoutMs: 10000,
      ...(pinnedKeys ? { hostKeys: pinnedKeys } : {}),
    },
    probeScript,
  );
  if (pinnedKeys) {
    return { stdout: res.stdout, hostKeys: pinnedKeys, fingerprint: recorded?.fingerprints[0], trust: 'pinned' };
  }
  const fingerprints = res.hostKeys.map(sshKeyFingerprint).filter((f): f is string => f !== null);
  if (fingerprints.length === 0) {
    throw new Error(`Could not read the SSH host key ${host}:${port} presented — refusing to continue without one.`);
  }
  if (expected && !fingerprints.includes(expected)) {
    throw new SshHostKeyMismatchError(
      `${host}:${port} presented the SSH host key ${fingerprints.join(', ')} (${res.hostKeys.map((k) => k.split(' ')[0]).join(', ')}), ` +
        `not the expected ${expected}. If the expected value is the fingerprint of a different key type, enter the ` +
        'fingerprint of this one (ssh-keygen -lf /etc/ssh/ssh_host_<type>_key.pub on the host); otherwise this can be a machine-in-the-middle.',
    );
  }
  if (db) {
    await setSettingJson<RecordedHostKeys>(db, hostKeySettingKey(host, port), {
      keys: res.hostKeys,
      fingerprints,
      recordedAt: new Date().toISOString(),
    });
  }
  return {
    stdout: res.stdout,
    hostKeys: res.hostKeys,
    fingerprint: fingerprints[0],
    trust: expected ? 'verified' : 'first-use',
    ...(expected
      ? {}
      : {
          warning:
            `First contact with ${host}:${port}: its SSH host key ${fingerprints[0]} was trusted on first use and recorded — ` +
            `compare it with "ssh-keygen -lf /etc/ssh/ssh_host_${hostKeyFileType(res.hostKeys[0])}_key.pub" on the host. Later connections must present the same key.`,
        }),
  };
}

/**
 * Probe an SSH host to verify connectivity, detect operating system,
 * and check whether Docker is already installed.
 */
export async function testSshConnection(input: ServerSshTest, db?: DB): Promise<ServerSshTestResult> {
  return (await sshPreflight(input, db)).result;
}

/** The probe behind {@link testSshConnection}, plus the host keys it verified (r661). */
async function sshPreflight(
  input: ServerSshTest,
  db?: DB,
): Promise<{ result: ServerSshTestResult; hostKeys?: string[] }> {
  const start = Date.now();
  const probeScript = 'uname -s -m && (cat /etc/os-release 2>/dev/null || true) && (docker --version 2>/dev/null || true)';

  try {
    const res = await probeWithHostKeyPolicy(input, db, probeScript);

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
      result: {
        ok: true,
        message: `Connected successfully to ${input.sshUser}@${input.host}:${input.sshPort}`,
        os,
        dockerInstalled,
        dockerVersion,
        latencyMs,
        hostKeyFingerprint: res.fingerprint,
        hostKeyTrust: res.trust,
        ...(res.warning ? { warning: res.warning } : {}),
      },
      hostKeys: res.hostKeys,
    };
  } catch (err: unknown) {
    return {
      result: {
        ok: false,
        message: err instanceof Error ? err.message : 'SSH Connection probe failed',
        latencyMs: Date.now() - start,
      },
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

  // r663: the row, the SSH session and the agent ping all use one spelling.
  const host = normalizeNodeHost(input.host);
  const sshOpts: SshExecOptions = {
    host,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    authType: input.authType,
    sshKey: input.sshKey,
    sshPassword: input.sshPassword,
  };

  try {
    // ── Step 1: Connecting ──────────────────────────────────────────────────
    emitStep('connecting', 'running', `Connecting to ${input.sshUser}@${input.host}:${input.sshPort} via SSH...`);
    const preflight = await sshPreflight(input, db);
    const connCheck = preflight.result;
    if (!connCheck.ok || !preflight.hostKeys) {
      emitStep('connecting', 'failed', connCheck.message);
      return { ok: false, steps, logs, error: connCheck.message };
    }
    // r661: every later session (Docker install, the agent start carrying the
    // token hash) accepts only the key the probe verified.
    sshOpts.hostKeys = preflight.hostKeys;
    emitStep('connecting', 'success', `Connected (${connCheck.latencyMs}ms latency) — host key ${connCheck.hostKeyFingerprint ?? 'unknown'}`);
    if (connCheck.warning) emitLog(`⚠ ${connCheck.warning}`);

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
      // The agent is THIS SAME image in agent mode, tagged with the running
      // core's release so the node matches the core's protocol (seal/nonce).
      // r175: the line used to start the image's default command — the full
      // panel — so no agent ever listened and every bootstrap failed its ping.
      agentDockerRunCommand({ hostPort: input.agentPort, imageTag: `v${VERSION}`, tokenSha256 }),
    ].join(' && ');

    await runSshCommand(sshOpts, agentStartCmd, emitLog);
    emitStep('agent_deploy', 'success', 'Agent container started successfully');

    // ── Step 5: Verify & Database Registration ──────────────────────────────
    emitStep('verify', 'running', 'Performing agent authentication handshake...');
    try {
      await agentPing(host, input.agentPort, agentToken);
    } catch {
      emitLog('Initial ping timed out. Waiting 2s for container startup and retrying...');
      await new Promise((r) => setTimeout(r, 2000));
      await agentPing(host, input.agentPort, agentToken);
    }

    // r399: (host, port) is the endpoint's identity — re-bootstrapping an
    // existing node (host reinstall, a retried bootstrap) must REBIND this
    // row to the fresh agent token, not insert a second row whose token
    // silently invalidates the first one's (the old row kept saying `online`
    // while every agentOp targeting it failed auth).
    const tokenEncrypted = encrypt(agentToken);
    const [row] = await db
      .insert(servers)
      .values({
        name: input.name,
        host,
        port: input.agentPort,
        tokenEncrypted,
        status: 'online',
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [servers.host, servers.port],
        set: {
          name: input.name,
          tokenEncrypted,
          status: 'online',
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
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
      hostKeyFingerprint: connCheck.hostKeyFingerprint,
      ...(connCheck.warning ? { warnings: [connCheck.warning] } : {}),
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
