import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTemplateManifest, templatesInit } from '../src/commands/templates.js';

const h = vi.hoisted(() => ({
  // No-op placeholder for `format` helpers we do not assert against. The
  // test relies on stdout/stderr writes going to the terminal, not on the
  // shared format helpers.
  logSpy: vi.fn(),
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  headerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', () => ({
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

function makeClient(template: unknown | Error) {
  return {
    templates: {
      get: vi.fn(async () => {
        if (template instanceof Error) throw template;
        return template;
      }),
    },
  } as never;
}

const TEMPLATE = {
  id: 'n8n',
  name: 'n8n',
  image: 'n8nio/n8n',
  tagline: 'Fair-code workflow automation',
  description: 'n8n is an extendable workflow automation tool.',
  category: 'Automation',
  emoji: 'ðŸ”—',
  port: 5678,
  volumeMount: '/home/node/.n8n',
  env: [
    { key: 'DB_TYPE', value: 'sqlite', secret: false },
  ],
};

let tmpDir: string;
let savedExitCode: number | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'ninedeploy-templates-'));
  savedExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

describe('renderTemplateManifest (pure)', () => {
  it('fetches the template from the panel and renders a YAML manifest', async () => {
    const client = makeClient(TEMPLATE);
    const { yaml, entry } = await renderTemplateManifest(client, 'n8n');

    expect(entry.id).toBe('n8n');
    expect(yaml).toMatch(/^# \.ninedeploy/);
    expect(yaml).toMatch(/port: 5678/);
    expect(yaml).toMatch(/mount: \/home\/node\/\.n8n/);
    expect(yaml).toMatch(/env:/);
    // Secret values are never copied into the manifest.
    expect(yaml).not.toMatch(/sqlite/);
  });

  it('surfaces a missing template as an error (not a crash)', async () => {
    const client = makeClient(new Error('HTTP 404 from panel'));
    await expect(renderTemplateManifest(client, 'missing')).rejects.toThrow(/HTTP 404/);
  });
});

describe('templatesInit (filesystem side-effects)', () => {
  it('writes the rendered YAML to a .ninedeploy file when --write is set', async () => {
    const client = makeClient(TEMPLATE);
    const out = join(tmpDir, '.ninedeploy');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await templatesInit(client, 'n8n', tmpDir, { write: true });

    const written = readFileSync(out, 'utf8');
    expect(written).toMatch(/port: 5678/);
    expect(written).toMatch(/mount: \/home\/node\/\.n8n/);
    // Stdout must stay quiet in --write mode so the operator's terminal
    // is not double-printed.
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(h.successSpy).toHaveBeenCalled();
    // The metadata lines that orient the operator after the file lands.
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringContaining('Image: n8nio/n8n'));
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringContaining('Port:  5678'));
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringContaining('Mount: /home/node/.n8n'));
  });

  it('refuses to overwrite an existing manifest when --write is set', async () => {
    const client = makeClient(TEMPLATE);
    const out = join(tmpDir, '.ninedeploy');
    // Pre-create the file the operator is trying to scaffold onto.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, 'version: "1"\n# already here\n', 'utf8');

    await templatesInit(client, 'n8n', tmpDir, { write: true });

    const after = readFileSync(out, 'utf8');
    expect(after).toBe('version: "1"\n# already here\n');
    expect(process.exitCode).toBe(1);
    expect(h.errorSpy).toHaveBeenCalled();
  });

  it('prints to stdout (and never touches disk) when --write is not set', async () => {
    const client = makeClient(TEMPLATE);
    // Make sure we are in the non-TTY branch so the banner line is hit.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { existsSync } = await import('node:fs');

    try {
      await templatesInit(client, 'n8n', tmpDir, { write: false });

      expect(stdoutSpy).toHaveBeenCalled();
      expect(existsSync(join(tmpDir, '.ninedeploy'))).toBe(false);
      // The non-TTY banner only fires when stdout is not a terminal.
      expect(h.infoSpy).toHaveBeenCalledWith(expect.stringContaining('rendered from template'));
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });

  it('sets a non-zero exit code when the panel returns no template', async () => {
    const client = makeClient(new Error('panel: no such template id'));
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await templatesInit(client, 'missing', tmpDir, { write: false });

    expect(process.exitCode).toBe(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(h.errorSpy).toHaveBeenCalled();
  });

  it('refuses to run when no template id is provided', async () => {
    const client = makeClient(TEMPLATE);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await templatesInit(client, '', tmpDir, { write: false });

    expect(process.exitCode).toBe(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('passes the supplied host into the starter route', async () => {
    const client = makeClient(TEMPLATE);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await templatesInit(client, 'n8n', tmpDir, { write: false, host: 'automation.example.com' });

    const writes = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(writes).toMatch(/host: automation\.example\.com/);
  });
});

describe('fetchTemplateEntry null path', () => {
  it('throws when the panel returns no template for the id', async () => {
    const client = {
      templates: { get: vi.fn().mockResolvedValue(null) },
    } as never;
    await expect(renderTemplateManifest(client, 'n8n')).rejects.toThrow(/no template/);
  });
});

describe('templatesInit metadata branches', () => {
  it('omits the Port/Mount banners when the template has neither', async () => {
    const client = makeClient({ ...TEMPLATE, port: undefined, volumeMount: undefined });
    const out = join(tmpDir, '.ninedeploy');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await templatesInit(client, 'n8n', tmpDir, { write: true });

    // The Image banner is still printed, the Port/Mount ones are not.
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringContaining('Image:'));
    expect(h.infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('Port:'));
    expect(h.infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('Mount:'));
    // Port-less template → no `port:` line in the rendered YAML.
    const written = readFileSync(out, 'utf8');
    expect(written).not.toMatch(/port:/);
  });

  it('prints the TTY banner when stdout is a terminal', async () => {
    const client = makeClient(TEMPLATE);
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await templatesInit(client, 'n8n', tmpDir, { write: false });
      // The non-TTY banner is suppressed under TTY — the operator just
      // sees the YAML, the prompts are for piped use.
      expect(h.infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('rendered from template'));
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });
});
