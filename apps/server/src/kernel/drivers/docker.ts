import { capture } from '../../lib/exec.js';
import { pullDockerImage } from '../../lib/dockerPull.js';
import type { IComputeDriver } from '../types.js';

export class LocalDockerDriver implements IComputeDriver {
  readonly name = 'docker-local';

  async pullImage(image: string, onLog: (l: string) => void): Promise<void> {
    await pullDockerImage(image, onLog);
  }

  async runContainer(opts: {
    name: string;
    image: string;
    network?: string;
    envFile?: string;
    volume?: string;
    mount?: string;
    cpuShares?: string;
    /** Hard CPU cap in millicores (500 = 0.5 cores); maps to docker --cpus. */
    cpuLimitMilli?: string;
    memLimitMb?: string;
  }): Promise<void> {
    const argv = ['run', '-d', '--name', opts.name, '--restart', 'unless-stopped'];

    if (opts.network) {
      argv.push('--network', opts.network);
    }
    if (opts.envFile) {
      argv.push('--env-file', opts.envFile);
    }
    if (opts.volume && opts.mount) {
      argv.push('-v', `${opts.volume}:${opts.mount}`);
    }
    if (opts.cpuShares) {
      argv.push('--cpu-shares', opts.cpuShares);
    }
    if (opts.cpuLimitMilli && /^\d{1,6}$/.test(opts.cpuLimitMilli) && Number(opts.cpuLimitMilli) > 0) {
      argv.push('--cpus', String(Number(opts.cpuLimitMilli) / 1000));
    }
    if (opts.memLimitMb) {
      argv.push('--memory', `${opts.memLimitMb}m`, '--memory-swap', `${opts.memLimitMb}m`);
    }

    argv.push(opts.image);
    await capture('docker', argv);
  }

  async stopContainer(name: string, timeoutSec = 10): Promise<void> {
    try {
      await capture('docker', ['stop', '-t', String(timeoutSec), name]);
    } catch {
      /* already stopped or missing */
    }
  }

  async removeContainer(name: string): Promise<void> {
    try {
      await capture('docker', ['rm', '-f', name]);
    } catch {
      /* already removed */
    }
  }

  async inspectContainer(name: string): Promise<{ status: string; ipAddress?: string; image?: string }> {
    try {
      const out = await capture('docker', [
        'inspect',
        name,
        '--format',
        '{{.State.Status}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}|{{.Config.Image}}',
      ]);
      const [status = 'unknown', ipAddress, image] = out.trim().split('|');
      return { status, ipAddress: ipAddress || undefined, image: image || undefined };
    } catch {
      return { status: 'missing' };
    }
  }

  async getLogs(name: string, tail = 100): Promise<string[]> {
    try {
      const out = await capture('docker', ['logs', '--tail', String(tail), name]);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
