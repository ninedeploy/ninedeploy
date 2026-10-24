import { randomUUID } from 'node:crypto';
import { spawnValidated } from './spawnValidated.js';
import { intOperand, RE_NAME, str, validated, type Params } from '../agentOps/operands.js';

// Same small helper image as the panel's existing sibling prober. No host
// ports, credentials or filesystem mounts; only the workload's network is shared.
const PROBE_IMAGE = 'busybox:1.36';
const HTTP_PROBE = 'printf "GET %s HTTP/1.0\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n" "$1" | nc -w 3 127.0.0.1 "$2" | head -n 1';

/** A fixed, bounded probe inside a workload network namespace. */
export async function probeContainer(params: Params, onLine: (line: string) => void, options: { timeoutMs?: number } = {}): Promise<number> {
  const name = validated(str(params, 'name'), RE_NAME, 'container name');
  if (name.length > 128) throw new Error('Invalid container name');
  const port = intOperand(params['port'], 1, 65535, 'probe port');
  const protocol = validated(str(params, 'protocol'), /^(http|tcp)$/, 'probe protocol');
  const path = str(params, 'path') ?? '/';
  if (path.length > 2048 || !path.startsWith('/') || path.includes('\\') || [...path].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)) throw new Error('Invalid probe path');
  const helper = `nd-probe-${randomUUID()}`;
  let status: number | undefined;
  let exit = 1;
  try {
    exit = await spawnValidated('docker', [
      'run', '--rm', '--name', helper, '--network', `container:${name}`,
      '--label', `ninedeploy.probe.target=${name}`,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '16', '--memory', '32m', '--cpus', '0.1', '--user', '65534:65534',
      PROBE_IMAGE,
      ...(protocol === 'http'
        ? ['sh', '-c', HTTP_PROBE, 'probe', path, String(port)]
        : ['sh', '-c', 'nc -w 3 127.0.0.1 "$1" </dev/null', 'probe', String(port)]),
    ], (line) => {
      const match = /^HTTP\/1\.[01] (\d{3})(?:\s|$)/.exec(line);
      if (match && status === undefined) status = Number(match[1]);
    }, { timeoutMs: Math.max(1, Math.min(10_000, options.timeoutMs ?? 10_000)) });
  } finally {
    // A killed docker CLI can leave its helper alive on the daemon.
    await spawnValidated('docker', ['rm', '-f', helper], () => undefined, { timeoutMs: 2000 }).catch(() => undefined);
  }
  onLine(`ND-PROBE ${JSON.stringify({ ready: exit === 0 && (protocol === 'tcp' || (status !== undefined && status >= 200 && status < 400)), protocol, ...(status === undefined ? {} : { status }) })}`);
  return 0;
}
