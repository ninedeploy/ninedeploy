import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capture, run, sleep } from './exec.js';

const SNAPSHOT_FAILURE = /extraction snapshot|target snapshot .*already exists|parent snapshot .*does not exist/i;
const STALE_EXISTING_SNAPSHOT = /target snapshot .*already exists/i;
const STALE_SNAPSHOT_KEY = /target snapshot\s+"?(sha256:[a-f0-9]{64})"?\s+already exists/i;
const CONTAINERD_TRANSFER_PLATFORM_BUG = /no unpack platforms defined/i;
const CONTAINERD_SOCKETS = ['/run/containerd/containerd.sock', '/var/run/docker/containerd/containerd.sock'] as const;
const DEPLOY_HEARTBEAT_MS = 20_000;
const CRANE_VERSION = 'v0.21.7';
const CRANE_RELEASES = {
  amd64: {
    asset: 'go-containerregistry_Linux_x86_64.tar.gz',
    sha256: '1a57bc98207fa1c0d04bf760699099e26f8383499bfd55b99c1b919a928a7230',
  },
  arm64: {
    asset: 'go-containerregistry_Linux_arm64.tar.gz',
    sha256: 'b6ee979d9411dfb05ce35ab9e156fe5de7def11a230764a7856ffa2eb971fa88',
  },
} as const;
const imagePreparations = new Map<string, Promise<void>>();
let cranePreparation: Promise<string> | undefined;

/** Docker/containerd snapshot errors known to be transient on Docker 29+. */
export function isTransientSnapshotFailure(lines: readonly string[]): boolean {
  return SNAPSHOT_FAILURE.test(lines.join('\n'));
}

type Descriptor = {
  digest?: string;
  Digest?: string;
  platform?: { architecture?: string; os?: string };
  Platform?: { Architecture?: string; OS?: string };
};

type ImageConfig = {
  config?: {
    Env?: string[];
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    WorkingDir?: string;
    User?: string;
    StopSignal?: string;
    ExposedPorts?: Record<string, unknown>;
    Volumes?: Record<string, unknown>;
    Labels?: Record<string, string>;
    OnBuild?: string[] | null;
    Healthcheck?: {
      Test?: string[];
      Interval?: number;
      Timeout?: number;
      StartPeriod?: number;
      StartInterval?: number;
      Retries?: number;
    };
  };
};

function descriptorDigest(value: Descriptor | undefined): string | undefined {
  return value?.digest ?? value?.Digest;
}

/** ctr requires a fully-qualified Docker Hub reference. */
export function normalizeContainerdImageRef(image: string): string {
  const name = image.split('@')[0]!;
  if (!name.includes('/')) return `docker.io/library/${image}`;
  const first = name.split('/')[0]!;
  if (first.includes('.') || first.includes(':') || first === 'localhost') return image;
  return `docker.io/${image}`;
}

/** Point ctr at the same containerd daemon used by Docker when its socket is discoverable. */
export function containerdCliArgs(args: string[], pathExists: (path: string) => boolean = existsSync): string[] {
  const socket = CONTAINERD_SOCKETS.find(pathExists);
  return socket ? ['--address', socket, '--namespace', 'moby', ...args] : ['--namespace', 'moby', ...args];
}

function hostArchitecture(): string {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

async function readContainerdImageConfig(ref: string): Promise<ImageConfig> {
  const info = JSON.parse(await capture('ctr', containerdCliArgs(['images', 'info', ref]))) as {
    target?: Descriptor;
    Target?: Descriptor;
  };
  let digest = descriptorDigest(info.target ?? info.Target);
  if (!digest) throw new Error('containerd image has no target digest');

  let manifest = JSON.parse(await capture('ctr', containerdCliArgs(['content', 'get', digest]))) as {
    manifests?: Descriptor[];
    config?: Descriptor;
  };
  if (manifest.manifests) {
    const arch = hostArchitecture();
    const selected = manifest.manifests.find((entry) => {
      const platform = entry.platform ?? (entry.Platform ? { architecture: entry.Platform.Architecture, os: entry.Platform.OS } : undefined);
      return platform?.os === 'linux' && platform.architecture === arch;
    });
    digest = descriptorDigest(selected);
    if (!digest) throw new Error(`containerd image has no linux/${arch} manifest`);
    manifest = JSON.parse(await capture('ctr', containerdCliArgs(['content', 'get', digest]))) as {
      manifests?: Descriptor[];
      config?: Descriptor;
    };
  }

  const configDigest = descriptorDigest(manifest.config);
  if (!configDigest) throw new Error('containerd image manifest has no config digest');
  return JSON.parse(await capture('ctr', containerdCliArgs(['content', 'get', configDigest]))) as ImageConfig;
}

async function repairUnusedStaleSnapshot(image: string, lines: readonly string[], log: (line: string) => void): Promise<boolean> {
  const key = STALE_SNAPSHOT_KEY.exec(lines.join('\n'))?.[1];
  if (!key) return false;

  try {
    const rawInfo = await capture('ctr', containerdCliArgs(['snapshots', '--snapshotter', 'overlayfs', 'info', key]));
    const info = JSON.parse(rawInfo) as { kind?: string | number; Kind?: string | number };
    const kind = info.kind ?? info.Kind;
    if (!(kind === 3 || String(kind).toLowerCase() === 'committed')) {
      log(`Refusing to remove stale snapshot ${key}: containerd reports non-committed kind ${String(kind)}`);
      return false;
    }

    log(`Removing unused stale overlayfs snapshot ${key}; containerd will refuse if it has active dependants …`);
    await run('ctr', containerdCliArgs(['snapshots', '--snapshotter', 'overlayfs', 'remove', key]), {}, log);
    log(`Retrying ${image} after targeted snapshot metadata repair …`);
    await run(
      'docker',
      ['pull', image],
      { heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Pulling ${image} after snapshot repair` },
      log,
    );
    return true;
  } catch (error) {
    log(`Targeted stale snapshot repair was not applicable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function importChanges(imageConfig: ImageConfig): string[] {
  const cfg = imageConfig.config ?? {};
  const changes: string[] = [];
  for (const entry of cfg.Env ?? []) {
    const separator = entry.indexOf('=');
    changes.push(separator < 0 ? `ENV ${entry}` : `ENV ${entry.slice(0, separator)}=${JSON.stringify(entry.slice(separator + 1))}`);
  }
  if (cfg.Entrypoint) changes.push(`ENTRYPOINT ${JSON.stringify(cfg.Entrypoint)}`);
  if (cfg.Cmd) changes.push(`CMD ${JSON.stringify(cfg.Cmd)}`);
  if (cfg.WorkingDir) changes.push(`WORKDIR ${cfg.WorkingDir}`);
  if (cfg.User) changes.push(`USER ${cfg.User}`);
  if (cfg.StopSignal) changes.push(`STOPSIGNAL ${cfg.StopSignal}`);
  for (const port of Object.keys(cfg.ExposedPorts ?? {})) changes.push(`EXPOSE ${port}`);
  for (const volume of Object.keys(cfg.Volumes ?? {})) changes.push(`VOLUME ${JSON.stringify([volume])}`);
  for (const [key, value] of Object.entries(cfg.Labels ?? {})) changes.push(`LABEL ${key}=${JSON.stringify(value)}`);
  for (const command of cfg.OnBuild ?? []) changes.push(`ONBUILD ${command}`);
  const healthcheck = cfg.Healthcheck;
  if (healthcheck?.Test?.[0] === 'NONE') {
    changes.push('HEALTHCHECK NONE');
  } else if (healthcheck?.Test?.length) {
    const options = [
      healthcheck.Interval && healthcheck.Interval > 0 ? `--interval=${healthcheck.Interval}ns` : undefined,
      healthcheck.Timeout && healthcheck.Timeout > 0 ? `--timeout=${healthcheck.Timeout}ns` : undefined,
      healthcheck.StartPeriod && healthcheck.StartPeriod > 0 ? `--start-period=${healthcheck.StartPeriod}ns` : undefined,
      healthcheck.StartInterval && healthcheck.StartInterval > 0 ? `--start-interval=${healthcheck.StartInterval}ns` : undefined,
      healthcheck.Retries && healthcheck.Retries > 0 ? `--retries=${healthcheck.Retries}` : undefined,
    ].filter(Boolean).join(' ');
    const [kind, ...command] = healthcheck.Test;
    const body = kind === 'CMD' ? `CMD ${JSON.stringify(command)}` : `CMD ${command.join(' ')}`;
    changes.push(`HEALTHCHECK${options ? ` ${options}` : ''} ${body}`);
  }
  return changes.flatMap((change) => ['--change', change]);
}

async function verifySha256(file: string, expected: string, log: (line: string) => void): Promise<void> {
  await run('sha256sum', ['--check', '--strict', '-'], {}, log, Buffer.from(`${expected}  ${file}\n`));
}

async function prepareCrane(log: (line: string) => void): Promise<string> {
  if (cranePreparation) return cranePreparation;
  const preparation = (async () => {
    const arch = hostArchitecture();
    const release = CRANE_RELEASES[arch as keyof typeof CRANE_RELEASES];
    if (!release) throw new Error(`direct registry recovery does not support linux/${arch}`);

    const staging = mkdtempSync(path.join(tmpdir(), 'ninedeploy-crane-'));
    const releaseArchive = path.join(staging, release.asset);
    const crane = path.join(staging, 'crane');
    const releaseUrl = `https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/${release.asset}`;
    try {
      await run(
        'curl',
        ['--proto', '=https', '--tlsv1.2', '--fail', '--location', '--retry', '3', '--output', releaseArchive, releaseUrl],
        { timeoutMs: 10 * 60 * 1000 },
        log,
      );
      await verifySha256(releaseArchive, release.sha256, log);
      await run('tar', ['-xzf', releaseArchive, '-C', staging, 'crane'], {}, log);
      await run('chmod', ['0755', crane], {}, log);
      rmSync(releaseArchive, { force: true });
      return crane;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  })();
  cranePreparation = preparation;
  preparation.catch(() => {
    if (cranePreparation === preparation) cranePreparation = undefined;
  });
  return preparation;
}

/**
 * Last-resort recovery that does not ask any host containerd snapshotter to
 * unpack the source image. A pinned, checksum-verified crane binary flattens
 * the registry image directly; Docker then sees a new single-layer chain ID
 * instead of the stale layer chain that blocked the original pull.
 */
export async function recoverImageDirectlyFromRegistry(
  image: string,
  log: (line: string) => void,
  targetImage = image,
): Promise<void> {
  const arch = hostArchitecture();
  const staging = mkdtempSync(path.join(tmpdir(), 'ninedeploy-registry-recovery-'));
  const rootfsArchive = path.join(staging, 'rootfs.tar');
  try {
    log(`Both Docker snapshotters are unusable; exporting ${image} directly from its registry …`);
    const crane = await prepareCrane(log);
    const platform = `linux/${arch}`;
    const config = JSON.parse(await capture(crane, ['config', image, '--platform', platform], { timeoutMs: 30 * 60 * 1000 })) as ImageConfig;
    await run(
      crane,
      ['export', image, rootfsArchive, '--platform', platform],
      {
        timeoutMs: 60 * 60 * 1000,
        heartbeatMs: 15 * 1000,
        heartbeatLabel: `Exporting ${image} directly from its registry`,
      },
      log,
    );
    await run(
      'docker',
      ['image', 'import', `--platform=${platform}`, ...importChanges(config), rootfsArchive, targetImage],
      {
        timeoutMs: 60 * 60 * 1000,
        heartbeatMs: 15 * 1000,
        heartbeatLabel: `Importing recovered ${targetImage} into Docker`,
      },
      log,
    );
    await capture('docker', ['image', 'inspect', targetImage, '--format', '{{.Id}}']);
    log(`Recovered ${image} directly from its registry as ${targetImage}; containerd extraction was bypassed`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Recover an image without touching the corrupt overlayfs snapshot. containerd
 * verifies and unpacks the original image in its independent `native` store;
 * the resulting rootfs is imported as one new Docker layer while preserving
 * the OCI runtime configuration. Existing images, containers and volumes are
 * never removed or hidden.
 */
export async function recoverImageWithNativeSnapshotter(image: string, log: (line: string) => void): Promise<void> {
  const ref = normalizeContainerdImageRef(image);
  const platform = `linux/${hostArchitecture()}`;
  const staging = mkdtempSync(path.join(tmpdir(), 'ninedeploy-image-recovery-'));
  const rootfs = path.join(staging, 'rootfs');
  const archive = path.join(staging, 'rootfs.tar');
  let mounted = false;
  try {
    mkdirSync(rootfs);
    log(`Docker overlayfs snapshot is stale; recovering ${image} through containerd's isolated native snapshotter …`);
    const pullLines: string[] = [];
    const pullLog = (line: string) => {
      pullLines.push(line);
      log(line);
    };
    try {
      await run(
        'ctr',
        containerdCliArgs(['images', 'pull', '--snapshotter', 'native', '--platform', platform, ref]),
        {
          timeoutMs: 30 * 60 * 1000,
          heartbeatMs: DEPLOY_HEARTBEAT_MS,
          heartbeatLabel: `Recovering ${image} with containerd native snapshotter`,
        },
        pullLog,
      );
    } catch (error) {
      if (!CONTAINERD_TRANSFER_PLATFORM_BUG.test(pullLines.join('\n'))) throw error;
      log(`containerd transfer API cannot unpack ${platform}; retrying through ctr local mode …`);
      await run(
        'ctr',
        containerdCliArgs(['images', 'pull', '--local', '--snapshotter', 'native', '--platform', platform, ref]),
        {
          timeoutMs: 30 * 60 * 1000,
          heartbeatMs: DEPLOY_HEARTBEAT_MS,
          heartbeatLabel: `Recovering ${image} through ctr local mode`,
        },
        log,
      );
    }
    const config = await readContainerdImageConfig(ref);
    await run(
      'ctr',
      containerdCliArgs(['images', 'mount', '--snapshotter', 'native', '--platform', platform, ref, rootfs]),
      {},
      log,
    );
    mounted = true;
    await run(
      'tar',
      ['--acls', '--xattrs', '--numeric-owner', '-C', rootfs, '-cf', archive, '.'],
      {
        timeoutMs: 30 * 60 * 1000,
        heartbeatMs: 15 * 1000,
        heartbeatLabel: `Packaging recovered ${image} filesystem`,
      },
      log,
    );
    await run(
      'docker',
      ['image', 'import', `--platform=linux/${hostArchitecture()}`, ...importChanges(config), archive, image],
      {
        timeoutMs: 30 * 60 * 1000,
        heartbeatMs: 15 * 1000,
        heartbeatLabel: `Importing recovered ${image} into Docker`,
      },
      log,
    );
    await capture('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    log(`Recovered ${image} as a verified single-layer image; existing Docker state was preserved`);
  } finally {
    if (mounted) {
      try {
        await run('ctr', containerdCliArgs(['images', 'unmount', rootfs]), {}, () => {});
        mounted = false;
      } catch (error) {
        // Never recurse into a path that might still be a mounted image rootfs.
        log(`Could not unmount recovery rootfs ${rootfs}; leaving it intact for safe manual cleanup: ${String(error)}`);
      }
    }
    if (!mounted) rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Pull an image with bounded recovery for containerd snapshot extraction
 * races. Other failures (auth, missing image, disk full, network policy) fail
 * immediately so retries never hide an actionable root cause.
 */
export async function pullDockerImage(
  image: string,
  log: (line: string) => void,
  maxAttempts = 3,
): Promise<void> {
  let snapshotError: unknown;
  let snapshotLines: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const lines: string[] = [];
    const sink = (line: string) => {
      lines.push(line);
      log(line);
    };
    try {
      await run(
        'docker',
        ['pull', image],
        { heartbeatMs: DEPLOY_HEARTBEAT_MS, heartbeatLabel: `Pulling application image ${image}` },
        sink,
      );
      return;
    } catch (err) {
      if (!isTransientSnapshotFailure(lines)) throw err;
      snapshotError = err;
      snapshotLines = lines;
      // An existing target with the same immutable chain ID is persistent
      // metadata corruption, not a timing race. Repeating the identical pull
      // cannot repair it, so switch to the isolated snapshotter immediately.
      if (STALE_EXISTING_SNAPSHOT.test(lines.join('\n')) || attempt === maxAttempts) break;
      log(`Docker snapshot extraction race while pulling ${image}; retrying (${attempt + 1}/${maxAttempts})…`);
      await sleep(attempt * 2000);
    }
  }
  if (await repairUnusedStaleSnapshot(image, snapshotLines, log)) return;
  try {
    await recoverImageWithNativeSnapshotter(image, log);
  } catch (recoveryError) {
    const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
    log(`Native snapshot recovery failed: ${recoveryMessage}`);
    try {
      await recoverImageDirectlyFromRegistry(image, log);
    } catch (registryError) {
      const registryMessage = registryError instanceof Error ? registryError.message : String(registryError);
      log(`Direct registry recovery failed: ${registryMessage}`);
      const pullMessage = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
      throw new Error(
        `${pullMessage}; native snapshot recovery failed: ${recoveryMessage}; direct registry recovery failed: ${registryMessage}`,
      );
    }
  }
}

/**
 * Ensure a runtime/helper image exists without ever delegating an implicit pull
 * to `docker run`. Concurrent callers share one preparation, while failures are
 * evicted immediately so a later request can retry after the host is repaired.
 */
export async function ensureDockerImage(image: string, log: (line: string) => void): Promise<void> {
  try {
    await capture('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
    return;
  } catch {
    // Missing locally: use the same bounded containerd recovery as deployments.
  }

  const existing = imagePreparations.get(image);
  if (existing) return existing;

  const preparation = pullDockerImage(image, log).finally(() => {
    if (imagePreparations.get(image) === preparation) imagePreparations.delete(image);
  });
  imagePreparations.set(image, preparation);
  return preparation;
}
