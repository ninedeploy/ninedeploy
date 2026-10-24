import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ run: vi.fn(), capture: vi.fn(), config: vi.fn() }));
vi.mock('../src/lib/exec.js', () => ({ run: h.run, capture: h.capture }));
vi.mock('../src/lib/swarm.js', () => ({ withDeployDockerConfig: h.config }));
const { pinSwarmImage } = await import('../src/engine/swarmImage.js');
const digest = 'a'.repeat(64);
beforeEach(() => {
  h.run.mockReset().mockResolvedValue(undefined);
  h.capture.mockReset().mockResolvedValue(JSON.stringify([`docker.io/library/node@sha256:${digest}`]));
  h.config.mockReset().mockImplementation(async (_auth, _log, callback) => callback('/private/config'));
});
describe('immutable Swarm image release references', () => {
  it('keeps an already pinned reference without a mutable pull', async () => {
    const ref = `registry.example.test/team/app@sha256:${digest}`;
    expect(await pinSwarmImage(ref, undefined, () => {})).toBe(ref);
    expect(h.run).not.toHaveBeenCalled(); expect(h.config).not.toHaveBeenCalled();
  });
  it.each(['node:26', 'docker.io/node:26', 'index.docker.io/library/node:26', 'registry-1.docker.io/library/node:26'])('pins the matching Docker Hub repository: %s', async ref => {
    expect(await pinSwarmImage(ref, undefined, () => {})).toBe(`docker.io/library/node@sha256:${digest}`);
    expect(h.run).toHaveBeenCalledWith('docker', ['--config', '/private/config', 'pull', ref], expect.anything(), expect.any(Function));
  });
  it('uses only the requested private repository and keeps credentials in the private config boundary', async () => {
    const auth = { username: 'fixture-user', password: 'fixture-password', server: 'registry.example.test:5443' };
    h.capture.mockResolvedValue(JSON.stringify([`other.test/app@sha256:${digest}`, `registry.example.test:5443/team/app@sha256:${digest}`]));
    expect(await pinSwarmImage('registry.example.test:5443/team/app:next', auth, () => {})).toBe(`registry.example.test:5443/team/app@sha256:${digest}`);
    expect(h.config).toHaveBeenCalledWith(auth, expect.any(Function), expect.any(Function));
    expect(JSON.stringify(h.run.mock.calls)).not.toContain(auth.password);
  });
  it.each(['broken json', 'null', '{}', '[]', JSON.stringify([`other.test/app@sha256:${digest}`]), JSON.stringify(['docker.io/library/node:26'])])('never falls back to a mutable tag when digest inspection is invalid: %s', async raw => {
    h.capture.mockResolvedValue(raw);
    await expect(pinSwarmImage('node:26', undefined, () => {})).rejects.toThrow(/digest/);
  });
  it('propagates pull failure without trusting a cached tag', async () => {
    h.run.mockRejectedValue(Error('pull refused'));
    await expect(pinSwarmImage('node:26', undefined, () => {})).rejects.toThrow('pull refused');
    expect(h.capture).not.toHaveBeenCalled();
  });
});
