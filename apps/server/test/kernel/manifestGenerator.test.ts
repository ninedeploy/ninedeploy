import { describe, expect, it, vi } from 'vitest';
import { buildManifestFromTemplate } from '@ninedeploy/sdk';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { loadTemplateEntry, ManifestGeneratorPlugin } from '../../src/kernel/plugins/manifestGenerator.js';

/**
 * Sprint 1, Gap G-04, PR #2.
 *
 * The plugin's contract has two halves:
 *   1. The pure mapping `buildManifestFromTemplate` — exercised directly so
 *      the test does not depend on the kernel boot path.
 *   2. The subscription side — exercised through a real `NineDeployKernel`
 *      with a mocked DB, the same shape used by the existing plugin tests.
 *
 * Note: the plugin reads the bundled template registry from disk. We
 * deliberately do NOT mock that read here — `vi.mock` does not play well
 * with ESM live bindings, and the registry is a small static file checked
 * into the repo, so reading the real one is simpler and more representative
 * than introducing a mock seam that future refactors would have to keep in
 * sync.
 */
describe('buildManifestFromTemplate (pure)', () => {
  it('sets the canonical defaults and copies the registry port', () => {
    const manifest = buildManifestFromTemplate({
      id: 'n8n',
      name: 'n8n',
      image: 'n8nio/n8n',
      port: 5678,
    });

    expect(manifest.version).toBe('1');
    expect(manifest.runtime).toEqual({ type: 'auto' });
    expect(manifest.run.port).toBe(5678);
    expect(manifest.run.healthcheck).toBe('/');
    expect(manifest.run.restart).toBe('unless-stopped');
    expect(manifest.env).toBeUndefined();
    expect(manifest.routes).toEqual([{ host: '', path: '/', ssl: true }]);
  });

  it('copies volumeMount into volume.mount when present', () => {
    const manifest = buildManifestFromTemplate({
      id: 'n8n',
      name: 'n8n',
      image: 'n8nio/n8n',
      port: 5678,
      volumeMount: '/home/node/.n8n',
    });
    expect(manifest.volume).toEqual({ mount: '/home/node/.n8n' });
  });

  it('collects env keys but never their values', () => {
    const manifest = buildManifestFromTemplate({
      id: 'activepieces',
      name: 'Activepieces',
      image: 'activepieces/activepieces:latest',
      port: 80,
      volumeMount: '/root/.activepieces',
      env: [
        { key: 'AP_ENCRYPTION_KEY', value: 'should-never-appear', secret: true },
        { key: 'AP_JWT_SECRET', value: 'should-never-appear', secret: true },
      ],
    });

    expect(manifest.env.required).toEqual(['AP_ENCRYPTION_KEY', 'AP_JWT_SECRET']);
    // Belt-and-braces: the serialised YAML must not contain the secret value.
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain('should-never-appear');
  });

  it('omits volume when the registry entry has no volumeMount', () => {
    const manifest = buildManifestFromTemplate({
      id: 'plausible',
      name: 'plausible',
      image: 'plausible/plausible:latest',
    });
    expect(manifest.volume).toBeUndefined();
  });

  it('uses the supplied default_host for the starter route', () => {
    const manifest = buildManifestFromTemplate(
      { id: 'n8n', name: 'n8n', image: 'n8nio/n8n', port: 5678 },
      'automation.example.com',
    );
    expect(manifest.routes[0]).toEqual({
      host: 'automation.example.com',
      path: '/',
      ssl: true,
    });
  });
});

describe('loadTemplateEntry', () => {
  const registry = {
    templates: [
      { id: 'n8n', name: 'n8n', image: 'n8nio/n8n', port: 5678 },
      { id: 'plausible', name: 'Plausible', image: 'plausible/plausible:latest' },
    ],
  };

  it('returns the matching entry', async () => {
    const entry = await loadTemplateEntry('n8n', async () => registry);
    expect(entry?.port).toBe(5678);
  });

  it('returns null when the id is unknown', async () => {
    const entry = await loadTemplateEntry('does-not-exist', async () => registry);
    expect(entry).toBeNull();
  });
});

describe('ManifestGeneratorPlugin', () => {
  const makeDb = () => ({
    query: {
      configEntries: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      }),
    }),
  });

  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  it('republishes a typed manifest.generated event for a known template', async () => {
    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new ManifestGeneratorPlugin();
    await kernel.registerPlugin(plugin);

    const generated: unknown[] = [];
    const errors: unknown[] = [];
    kernel.events.onCustom('manifest.generated', (payload) => generated.push(payload));
    kernel.events.onCustom('manifest.generator_error', (payload) => errors.push(payload));

    kernel.events.emitCustom('template.bundle.observed', {
      action: 'template.install',
      entity: 'template:n8n',
      actorUserId: 1,
      ts: '2026-08-28T12:00:00.000Z',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toEqual([]);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      templateId: 'n8n',
      manifest: {
        version: '1',
        run: { port: 5678, healthcheck: '/', restart: 'unless-stopped' },
        volume: { mount: '/home/node/.n8n' },
      },
    });
  });

  it('reports unknown templates as manifest.generator_error', async () => {
    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new ManifestGeneratorPlugin();
    await kernel.registerPlugin(plugin);

    const errors: unknown[] = [];
    kernel.events.onCustom('manifest.generator_error', (payload) => errors.push(payload));

    kernel.events.emitCustom('template.bundle.observed', {
      action: 'template.install',
      entity: 'template:not-in-registry',
      actorUserId: 1,
      ts: '2026-08-28T12:00:00.000Z',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ templateId: 'not-in-registry' });
  });

  it('ignores events whose entity is not a template reference', async () => {
    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new ManifestGeneratorPlugin();
    await kernel.registerPlugin(plugin);

    const generated: unknown[] = [];
    kernel.events.onCustom('manifest.generated', (payload) => generated.push(payload));

    kernel.events.emitCustom('template.bundle.observed', {
      action: 'template.install',
      entity: 'service:42',
      actorUserId: 1,
      ts: '2026-08-28T12:00:00.000Z',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(generated).toEqual([]);
  });
});

