import { beforeEach, describe, expect, it, vi } from 'vitest';
import { containerRoutes } from '../src/modules/containers.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const engineMocks = vi.hoisted(() => ({
  listContainerDir: vi.fn(),
  readContainerFile: vi.fn(),
  writeContainerFile: vi.fn(),
  makeContainerDir: vi.fn(),
  deleteContainerPath: vi.fn(),
  inspectContainer: vi.fn(),
  getContainerComposeManifest: vi.fn(),
}));

vi.mock('../src/engine/containerFiles.js', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/containerFiles.js')>(
    '../src/engine/containerFiles.js',
  );
  return {
    ...actual,
    ...engineMocks,
  };
});

describe('containerRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists files inside a container with default or specified path', async () => {
    engineMocks.listContainerDir.mockResolvedValueOnce([
      { name: 'app', type: 'dir', sizeBytes: 4096, mode: '0755', modifiedAt: null },
      { name: 'package.json', type: 'file', sizeBytes: 120, mode: '0644', modifiedAt: null },
    ]);
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/files?path=/app',
      headers: asUser({ isOperator: true }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      path: '/app',
      entries: [
        { name: 'app', type: 'dir', sizeBytes: 4096, mode: '0755', modifiedAt: null },
        { name: 'package.json', type: 'file', sizeBytes: 120, mode: '0644', modifiedAt: null },
      ],
    });
    expect(engineMocks.listContainerDir).toHaveBeenCalledWith('nd-svc-web-1', '/app');

    // Default path fallback to '/'
    engineMocks.listContainerDir.mockResolvedValueOnce([]);
    const resDefault = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/files',
      headers: asUser({ isOperator: true }),
    });
    expect(resDefault.statusCode).toBe(200);
    expect(resDefault.json()).toEqual({ path: '/', entries: [] });
    expect(engineMocks.listContainerDir).toHaveBeenCalledWith('nd-svc-web-1', '/');
  });

  it('reads file content as base64', async () => {
    engineMocks.readContainerFile.mockResolvedValueOnce({
      content: 'ZXhwb3J0cyA9IHt9Ow==',
      encoding: 'base64',
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/files/content?path=/app/index.js',
      headers: asUser({ isOperator: true }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      content: 'ZXhwb3J0cyA9IHt9Ow==',
      encoding: 'base64',
    });
    expect(engineMocks.readContainerFile).toHaveBeenCalledWith('nd-svc-web-1', '/app/index.js');
  });

  it('writes file with base64 payload', async () => {
    engineMocks.writeContainerFile.mockImplementationOnce(
      async (_c: string, _p: string, _b: string, sink: (l: string) => void) => {
        sink('written');
      },
    );
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'PUT',
      url: '/nd-svc-web-1/files',
      headers: asUser({ isOperator: true }),
      payload: { path: '/app/config.json', contentBase64: 'e30=' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.writeContainerFile).toHaveBeenCalledWith(
      'nd-svc-web-1',
      '/app/config.json',
      'e30=',
      expect.any(Function),
    );
  });

  it('creates directory via mkdir endpoint', async () => {
    engineMocks.makeContainerDir.mockResolvedValueOnce(undefined);
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/nd-svc-web-1/files/dir',
      headers: asUser({ isOperator: true }),
      payload: { path: '/app/logs' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.makeContainerDir).toHaveBeenCalledWith('nd-svc-web-1', '/app/logs');
  });

  it('deletes file or directory via delete endpoint', async () => {
    engineMocks.deleteContainerPath.mockImplementationOnce(
      async (_c: string, _p: string, sink: (l: string) => void) => {
        sink('deleted');
      },
    );
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'DELETE',
      url: '/nd-svc-web-1/files?path=/app/temp.log',
      headers: asUser({ isOperator: true }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(engineMocks.deleteContainerPath).toHaveBeenCalledWith(
      'nd-svc-web-1',
      '/app/temp.log',
      expect.any(Function),
    );
  });

  it('validates container name and rejects invalid identifiers', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/-invalid-name/files',
      headers: asUser({ isOperator: true }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('invalid container');
  });

  it('validates paths and rejects malicious / invalid inputs', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    // NUL byte path
    const resNul = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/files?path=a%00b',
      headers: asUser({ isOperator: true }),
    });
    expect(resNul.statusCode).toBe(400);
    expect(resNul.json().error.message).toContain('invalid path');

    // Read root as file
    const resReadRoot = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/files/content?path=/',
      headers: asUser({ isOperator: true }),
    });
    expect(resReadRoot.statusCode).toBe(400);
    expect(resReadRoot.json().error.message).toContain('invalid file path');

    // Write root as file
    const resWriteRoot = await app.inject({
      method: 'PUT',
      url: '/nd-svc-web-1/files',
      headers: asUser({ isOperator: true }),
      payload: { path: '/', contentBase64: 'e30=' },
    });
    expect(resWriteRoot.statusCode).toBe(400);
    expect(resWriteRoot.json().error.message).toContain('invalid file path');

    // Mkdir root
    const resMkdirRoot = await app.inject({
      method: 'POST',
      url: '/nd-svc-web-1/files/dir',
      headers: asUser({ isOperator: true }),
      payload: { path: '/' },
    });
    expect(resMkdirRoot.statusCode).toBe(400);
    expect(resMkdirRoot.json().error.message).toContain('invalid directory path');

    // Delete root
    const resDeleteRoot = await app.inject({
      method: 'DELETE',
      url: '/nd-svc-web-1/files?path=/',
      headers: asUser({ isOperator: true }),
    });
    expect(resDeleteRoot.statusCode).toBe(400);
    expect(resDeleteRoot.json().error.message).toContain('cannot delete root directory');
  });

  it('requires admin role for file operations', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/files',
      headers: asUser({ isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('serves container inspect metadata and traefik tags', async () => {
    engineMocks.inspectContainer.mockResolvedValueOnce({
      id: 'cid1',
      name: 'nd-svc-web-1',
      image: 'node:20',
      state: { status: 'running', running: true },
      traefikTags: { 'traefik.enable': 'true' },
    });

    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/inspect',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('nd-svc-web-1');
    expect(res.json().traefikTags['traefik.enable']).toBe('true');
  });

  it('serves runtime generated Docker Compose YAML manifest', async () => {
    engineMocks.getContainerComposeManifest.mockResolvedValueOnce({
      yaml: 'services:\n  nd-svc-web-1:\n    image: node:20',
      inspect: { name: 'nd-svc-web-1' },
    });

    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/nd-svc-web-1/compose',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().yaml).toContain('services:');
  });
});

/**
 * r665: these routes run the PANEL host's docker CLI. A container of a
 * service pinned to a remote node lives on that node, so it answered "No such
 * container" — or could reach a same-named local one. Refused up front.
 */
describe('r665: containers of node-pinned services', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses inspect, compose and file access with the node named', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: { id: 1, runtimeId: 'web-1-17', serverId: 4 } } }),
    });
    await app.register(containerRoutes);
    for (const url of ['/web-1-17/inspect', '/web-1-17/compose', '/web-1-17/files?path=/', '/web-1-17-r2/files/content?path=/a']) {
      const res = await app.inject({ method: 'GET', url, headers: asUser() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'remote_container' });
      expect(res.json().error.message).toContain('remote node #4');
    }
    expect(engineMocks.inspectContainer).not.toHaveBeenCalled();
    expect(engineMocks.getContainerComposeManifest).not.toHaveBeenCalled();
    expect(engineMocks.listContainerDir).not.toHaveBeenCalled();
    expect(engineMocks.readContainerFile).not.toHaveBeenCalled();
  });

  it('refuses a fan-out target generation too', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { serviceTargets: { serverId: 6, runtimeId: 'web-t6-17' } } }),
    });
    await app.register(containerRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/web-t6-17/files?path=/tmp/x', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('remote node #6');
    expect(engineMocks.deleteContainerPath).not.toHaveBeenCalled();
  });

  it('keeps serving containers on the panel host', async () => {
    engineMocks.inspectContainer.mockResolvedValueOnce({ id: 'x' });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(containerRoutes);
    const res = await app.inject({ method: 'GET', url: '/web-1-17/inspect', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(engineMocks.inspectContainer).toHaveBeenCalledWith('web-1-17');
  });
});
