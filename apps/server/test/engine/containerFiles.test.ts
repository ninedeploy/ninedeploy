import { load as yamlLoad } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteContainerPath,
  getContainerComposeManifest,
  inspectContainer,
  isManagedContainer,
  listContainerDir,
  makeContainerDir,
  readContainerFile,
  safeContainerPath,
  writeContainerFile,
} from '../../src/engine/containerFiles.js';

const execMocks = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn() }));
vi.mock('../../src/lib/exec.js', () => execMocks);

describe('containerFiles helpers (pure)', () => {
  it('isManagedContainer validates container identifiers', () => {
    expect(isManagedContainer('nd-svc-web-1')).toBe(true);
    expect(isManagedContainer('nd-db-postgres-1')).toBe(true);
    expect(isManagedContainer('my_container.1')).toBe(true);
    expect(isManagedContainer('-invalid')).toBe(false);
    expect(isManagedContainer('evil/escape')).toBe(false);
    expect(isManagedContainer('')).toBe(false);
    expect(isManagedContainer('a'.repeat(200))).toBe(false);
  });

  it('safeContainerPath normalises and handles paths safely', () => {
    expect(safeContainerPath('')).toBe('/');
    expect(safeContainerPath('/')).toBe('/');
    expect(safeContainerPath('/a/..')).toBe('/');
    expect(safeContainerPath('/app/data/config.json')).toBe('/app/data/config.json');
    expect(safeContainerPath('app/./data/../config.json')).toBe('/app/config.json');
    expect(safeContainerPath('/../../../etc/passwd')).toBe('/etc/passwd');
    expect(safeContainerPath('a\0b')).toBeNull();
    expect(safeContainerPath('a\nb')).toBeNull();
    expect(safeContainerPath(`/${'a'.repeat(256)}`)).toBeNull();
    expect(safeContainerPath(`/${'a'.repeat(200)}`)).toBe(`/${'a'.repeat(200)}`);
  });
});

describe('containerFiles operations (docker exec)', () => {
  it('lists directory contents with metadata (stat format)', async () => {
    execMocks.capture.mockResolvedValueOnce(
      'directory|4096|755|1786886400|./config\nregular file|1024|644|1786886401|./app.js\nsymbolic link|12|777|1786886402|./link.js\n',
    );
    const entries = await listContainerDir('nd-svc-web-1', '/app');
    expect(execMocks.capture).toHaveBeenCalledWith('docker', [
      'exec',
      'nd-svc-web-1',
      'sh',
      '-c',
      expect.stringContaining("cd '/app'"),
    ]);
    expect(entries).toEqual([
      {
        name: 'config',
        type: 'dir',
        sizeBytes: 4096,
        mode: '0755',
        modifiedAt: new Date(1786886400 * 1000).toISOString(),
      },
      {
        name: 'app.js',
        type: 'file',
        sizeBytes: 1024,
        mode: '0644',
        modifiedAt: new Date(1786886401 * 1000).toISOString(),
      },
      {
        name: 'link.js',
        type: 'file',
        sizeBytes: 12,
        mode: '0777',
        modifiedAt: new Date(1786886402 * 1000).toISOString(),
      },
    ]);
  });

  it('skips malformed output lines in listContainerDir and handles missing modes and names', async () => {
    execMocks.capture.mockResolvedValueOnce(
      'socket|0|777|0|./sock\ndirectory||||./nodirmode\ndirectory|4096|755|0|/\nregular file||||./badsize\nregular file|500||0|./nomode\n\n',
    );
    const entries = await listContainerDir('nd-svc-web-1', '/');
    expect(entries).toEqual([
      { name: 'nodirmode', type: 'dir', sizeBytes: 0, mode: null, modifiedAt: null },
      { name: 'badsize', type: 'file', sizeBytes: 0, mode: null, modifiedAt: null },
      { name: 'nomode', type: 'file', sizeBytes: 500, mode: null, modifiedAt: null },
    ]);
  });

  it('reads container file content with base64 encoding', async () => {
    execMocks.capture.mockResolvedValueOnce('ZXhwb3J0cyA9IHt9Ow==\n');
    const result = await readContainerFile('nd-svc-web-1', '/app/index.js');
    expect(result).toEqual({ content: 'ZXhwb3J0cyA9IHt9Ow==', encoding: 'base64' });
    expect(execMocks.capture).toHaveBeenCalledWith('docker', [
      'exec',
      'nd-svc-web-1',
      'sh',
      '-c',
      expect.stringContaining("head -c 1048577 '/app/index.js'"),
    ]);
  });

  // r275: `tail -c 1048576` silently returned the LAST MiB of a larger file,
  // and the web editor then saved that tail over the whole file.
  it('r275: refuses a file over the 1 MiB cap instead of returning its tail', async () => {
    const overCap = Buffer.alloc(1024 * 1024 + 1, 0x61).toString('base64');
    // `base64` wraps its output at 76 columns.
    execMocks.capture.mockResolvedValueOnce(`${overCap.replace(/(.{76})/g, '$1\n')}\n`);
    await expect(readContainerFile('nd-svc-web-1', '/var/log/big.log')).rejects.toMatchObject({
      statusCode: 413,
      code: 'file_too_large',
    });
  });

  it('r275: still reads a file of exactly 1 MiB', async () => {
    const atCap = Buffer.alloc(1024 * 1024, 0x61).toString('base64');
    execMocks.capture.mockResolvedValueOnce(`${atCap.replace(/(.{76})/g, '$1\n')}\n`);
    const res = await readContainerFile('nd-svc-web-1', '/app/data.txt');
    expect(Buffer.from(res.content, 'base64')).toHaveLength(1024 * 1024);
  });

  it('writes container file content via stdin', async () => {
    const logs: string[] = [];
    execMocks.run.mockResolvedValueOnce(undefined);
    await writeContainerFile('nd-svc-web-1', '/app/src/index.js', 'ZXhwb3J0cyA9IHt9Ow==', (l) => logs.push(l));
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        '-i',
        'nd-svc-web-1',
        'sh',
        '-c',
        expect.stringContaining("mkdir -p '/app/src'"),
      ],
      {},
      expect.any(Function),
      Buffer.from('ZXhwb3J0cyA9IHt9Ow==', 'utf8'),
    );
  });

  it('writes root-level file with dirname fallback to /', async () => {
    execMocks.run.mockResolvedValueOnce(undefined);
    await writeContainerFile('nd-svc-web-1', '/config.json', 'e30=', () => {});
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        '-i',
        'nd-svc-web-1',
        'sh',
        '-c',
        expect.stringContaining("mkdir -p '/'"),
      ],
      {},
      expect.any(Function),
      Buffer.from('e30=', 'utf8'),
    );
  });

  it('creates directory in container with mkdir -p', async () => {
    execMocks.capture.mockResolvedValueOnce('');
    await makeContainerDir('nd-svc-web-1', '/app/cache/tmp');
    expect(execMocks.capture).toHaveBeenCalledWith('docker', [
      'exec',
      'nd-svc-web-1',
      'mkdir',
      '-p',
      '--',
      '/app/cache/tmp',
    ]);
  });

  it('deletes path in container with rm -rf', async () => {
    execMocks.run.mockResolvedValueOnce(undefined);
    await deleteContainerPath('nd-svc-web-1', '/app/old.log', () => {});
    expect(execMocks.run).toHaveBeenCalledWith(
      'docker',
      ['exec', 'nd-svc-web-1', 'rm', '-rf', '--', '/app/old.log'],
      {},
      expect.any(Function),
    );
  });

  it('guards against invalid container names or paths in all functions', async () => {
    await expect(listContainerDir('invalid/name', '/')).rejects.toThrow('invalid container');
    await expect(listContainerDir('nd-svc-1', 'a\0b')).rejects.toThrow('invalid path');

    await expect(readContainerFile('invalid/name', '/app')).rejects.toThrow('invalid container');
    await expect(readContainerFile('nd-svc-1', '/')).rejects.toThrow('invalid path');
    await expect(readContainerFile('nd-svc-1', 'a\0b')).rejects.toThrow('invalid path');

    await expect(writeContainerFile('invalid/name', '/app', 'aGk=', () => {})).rejects.toThrow('invalid container');
    await expect(writeContainerFile('nd-svc-1', '/', 'aGk=', () => {})).rejects.toThrow('invalid path');
    await expect(writeContainerFile('nd-svc-1', 'a\0b', 'aGk=', () => {})).rejects.toThrow('invalid path');

    await expect(makeContainerDir('invalid/name', '/app')).rejects.toThrow('invalid container');
    await expect(makeContainerDir('nd-svc-1', '/')).rejects.toThrow('invalid path');
    await expect(makeContainerDir('nd-svc-1', 'a\0b')).rejects.toThrow('invalid path');

    await expect(deleteContainerPath('invalid/name', '/app', () => {})).rejects.toThrow('invalid container');
    await expect(deleteContainerPath('nd-svc-1', '/', () => {})).rejects.toThrow('cannot delete root');
    await expect(deleteContainerPath('nd-svc-1', 'a\0b', () => {})).rejects.toThrow('cannot delete root');
  });

  it('inspects container metadata and extracts labels, traefik tags and resources', async () => {
    const fakeInspect = [
      {
        Id: 'cid123',
        Name: '/nd-svc-web-1',
        Config: {
          Image: 'node:20-alpine',
          Env: ['NODE_ENV=production', 'PORT=3000'],
          Labels: {
            'traefik.enable': 'true',
            'traefik.http.routers.web.rule': 'Host(`app.dev`)',
            'com.docker.compose.service': 'web',
          },
        },
        State: {
          Status: 'running',
          Running: true,
          StartedAt: '2026-08-18T10:00:00Z',
          FinishedAt: '',
          ExitCode: 0,
          Error: '',
        },
        NetworkSettings: {
          Ports: { '3000/tcp': [{ HostPort: '8080' }] },
          Networks: { ninedeploy: {} },
        },
        Mounts: [{ Source: '/var/lib/data', Destination: '/data', Mode: 'rw', RW: true }],
        HostConfig: {
          Memory: 536870912,
          CpuShares: 512,
          RestartPolicy: { Name: 'unless-stopped' },
        },
      },
    ];

    execMocks.capture.mockResolvedValueOnce(JSON.stringify(fakeInspect));
    const result = await inspectContainer('nd-svc-web-1');
    expect(result.id).toBe('cid123');
    expect(result.name).toBe('nd-svc-web-1');
    expect(result.image).toBe('node:20-alpine');
    expect(result.state.running).toBe(true);
    expect(result.traefikTags['traefik.enable']).toBe('true');
    expect(result.traefikTags['traefik.http.routers.web.rule']).toBe('Host(`app.dev`)');
    expect(result.resources.memoryLimitBytes).toBe(536870912);
  });

  it('generates runtime Docker Compose YAML manifest with Traefik tags', async () => {
    const fakeInspect = [
      {
        Id: 'cid123',
        Name: '/nd-svc-web-1',
        Config: {
          Image: 'node:20-alpine',
          Env: ['PORT=3000'],
          Labels: {
            'traefik.enable': 'true',
            'traefik.http.routers.web.rule': 'Host(`app.dev`)',
          },
        },
        State: { Status: 'running', Running: true },
        NetworkSettings: { Networks: { ninedeploy: {} } },
        Mounts: [{ Source: '/data', Destination: '/app/data', Mode: 'ro', RW: false }],
        HostConfig: {
          Memory: 268435456,
          CpuShares: 1024,
          RestartPolicy: { Name: 'unless-stopped' },
        },
      },
    ];

    execMocks.capture.mockResolvedValueOnce(JSON.stringify(fakeInspect));
    const { yaml, inspect } = await getContainerComposeManifest('nd-svc-web-1');
    expect(inspect.name).toBe('nd-svc-web-1');
    expect(yaml).toContain('services:');
    expect(yaml).toContain('nd-svc-web-1:');
    expect(yaml).toContain('image: node:20-alpine');
    expect(yaml).toContain('traefik.http.routers.web.rule=Host(`app.dev`)');
    expect(yaml).toContain('networks:');
    expect(yaml).toContain('ninedeploy:');
  });

  it('emits env/label scalars so the manifest round-trips through a YAML parser', async () => {
    // Env values come from `docker inspect` verbatim: an app configured via
    // JSON (`CONFIG={"a":1}`) or any `: `-bearing value is a YAML syntax
    // error / re-typing hazard when emitted as a plain scalar, and a label
    // value containing `"` breaks the hand-written double-quoting.
    const fakeInspect = [
      {
        Id: 'cid555',
        Name: '/nd-svc-app-1',
        Config: {
          Image: 'alpine',
          Env: ['CONFIG={"a":1}', 'TOKEN=abc: def', 'PLAIN=yes'],
          Labels: { note: 'say "hi"' },
        },
        State: { Status: 'running', Running: true },
        NetworkSettings: { Networks: { ninedeploy: {} } },
        Mounts: [],
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      },
    ];

    execMocks.capture.mockResolvedValueOnce(JSON.stringify(fakeInspect));
    const { yaml } = await getContainerComposeManifest('nd-svc-app-1');
    const parsed = yamlLoad(yaml) as {
      services: { 'nd-svc-app-1': { environment: string[]; labels: string[] } };
    };
    const svc = parsed.services['nd-svc-app-1'];
    expect(svc.environment).toEqual(['CONFIG={"a":1}', 'TOKEN=abc: def', 'PLAIN=yes']);
    expect(svc.labels).toEqual(['note=say "hi"']);
  });

  it('handles empty inspect output with error', async () => {
    execMocks.capture.mockResolvedValueOnce('[]');
    await expect(inspectContainer('nd-svc-web-1')).rejects.toThrow('container inspect empty');
  });

  it('handles minimal/sparse inspect objects with default fallback values', async () => {
    const sparseInspect = [{
      Mounts: [{}],
    }];
    execMocks.capture.mockResolvedValueOnce(JSON.stringify(sparseInspect));
    const result = await inspectContainer('nd-svc-web-1');
    expect(result.id).toBe('');
    expect(result.name).toBe('');
    expect(result.image).toBe('');
    expect(result.state.status).toBe('unknown');
    expect(result.state.running).toBe(false);
    expect(result.state.exitCode).toBe(0);
    expect(result.resources.restartPolicy).toBe('no');
    expect(result.mounts).toEqual([{ source: '', destination: '', mode: '', rw: false }]);
    expect(result.networks).toEqual([]);
  });

  it('generates compose manifest with minimal/empty resources and no optional blocks', async () => {
    const minimalInspect = [
      {
        Id: 'cid999',
        Name: 'simple-app',
        Config: { Image: 'alpine' },
        State: { Status: 'created' },
        HostConfig: { RestartPolicy: { Name: '' } },
      },
    ];
    execMocks.capture.mockResolvedValueOnce(JSON.stringify(minimalInspect));
    const { yaml, inspect } = await getContainerComposeManifest('simple-app');
    expect(inspect.name).toBe('simple-app');
    expect(yaml).toContain('services:');
    expect(yaml).toContain('simple-app:');
    expect(yaml).toContain('image: alpine');
    expect(yaml).toContain('restart: unless-stopped');
    expect(yaml).not.toContain('volumes:');
    expect(yaml).not.toContain('networks:');
    expect(yaml).not.toContain('deploy:');
  });

  it('generates compose manifest with read-write mounts and memory-only or cpu-only limits', async () => {
    const customInspect = [
      {
        Id: 'cid888',
        Name: 'custom-app',
        Config: { Image: 'node:20', Env: [] },
        State: { Status: 'running', Running: true },
        Mounts: [{ Source: '/vol', Destination: '/app/vol', Mode: 'rw', RW: true }],
        HostConfig: {
          Memory: 104857600,
          CpuShares: 0,
          RestartPolicy: { Name: 'always' },
        },
      },
    ];
    execMocks.capture.mockResolvedValueOnce(JSON.stringify(customInspect));
    const { yaml } = await getContainerComposeManifest('custom-app');
    expect(yaml).toContain('/vol:/app/vol');
    expect(yaml).not.toContain('/vol:/app/vol:ro');
    expect(yaml).toContain('memory: 100M');
    expect(yaml).not.toContain('cpus:');

    // CPU-only: a hard cap comes from NanoCpus; cpu-shares is a scheduling
    // weight and must render as `cpu_shares`, never as `cpus:` (which would
    // impose a cap the container does not have).
    const cpuOnlyInspect = [
      {
        Id: 'cid777',
        Name: 'cpu-app',
        Config: { Image: 'node:20' },
        HostConfig: { Memory: 0, CpuShares: 512 },
      },
    ];
    execMocks.capture.mockResolvedValueOnce(JSON.stringify(cpuOnlyInspect));
    const { yaml: cpuYaml } = await getContainerComposeManifest('cpu-app');
    expect(cpuYaml).toContain('cpu_shares: 512');
    expect(cpuYaml).not.toContain('cpus:');
    expect(cpuYaml).not.toContain('memory:');

    // Hard CPU cap renders from NanoCpus only.
    const cappedInspect = [
      {
        Id: 'cid999',
        Name: 'capped-app',
        Config: { Image: 'node:20' },
        HostConfig: { Memory: 0, CpuShares: 1024, NanoCpus: 500000000 },
      },
    ];
    execMocks.capture.mockResolvedValueOnce(JSON.stringify(cappedInspect));
    const { yaml: cappedYaml } = await getContainerComposeManifest('capped-app');
    expect(cappedYaml).toContain("cpus: '0.5'");
    expect(cappedYaml).toContain('cpu_shares: 1024');
  });
});
