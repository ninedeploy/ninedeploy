import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  communityTemplatesImport,
  communityTemplatesList,
  communityTemplatesRemove,
} from '../src/commands/communityTemplates.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  headerSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  tableSpy: vi.fn(),
  spinnerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/format.js')>(
    '../src/lib/format.js',
  );
  return {
    ...actual,
    error: h.errorSpy,
    header: h.headerSpy,
    info: h.infoSpy,
    success: h.successSpy,
    table: h.tableSpy,
    spinner: h.spinnerSpy,
  };
});

interface FakeClient {
  templates: {
    community: {
      list: ReturnType<typeof vi.fn>;
      import: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
}

function makeClient(): FakeClient {
  return {
    templates: {
      community: {
        list: vi.fn(),
        import: vi.fn(),
        remove: vi.fn(),
      },
    },
  };
}

let tmpDir: string;
let savedStdinDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), 'ninedeploy-cli-community-'));
  savedStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedStdinDescriptor) {
    Object.defineProperty(process, 'stdin', savedStdinDescriptor);
  }
  vi.restoreAllMocks();
});

describe('communityTemplatesList', () => {
  it('prints the catalog header + table for non-empty entries', async () => {
    const client = makeClient();
    client.templates.community.list.mockResolvedValue({
      entries: [
        {
          id: 'c1',
          template: { name: 'n8n', category: 'Automation' },
          bytes: 1234,
        },
        {
          id: 'c2',
          template: { name: 'ghost', category: 'CMS' },
          bytes: 5678,
        },
      ],
      totalBytes: 6912,
      errors: [],
    });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesList(client as never);
    expect(h.headerSpy).toHaveBeenCalledWith('Community templates');
    expect(h.infoSpy).toHaveBeenCalledWith('Entries:    2');
    expect(h.infoSpy).toHaveBeenCalledWith('Total size: 6912 bytes');
    expect(h.tableSpy).toHaveBeenCalled();
    const tableArg = h.tableSpy.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(tableArg).toHaveLength(2);
    expect(tableArg[0]).toMatchObject({ id: 'c1', name: 'n8n', category: 'Automation' });
  });

  it('prints a "no community templates" line when the catalog is empty', async () => {
    const client = makeClient();
    client.templates.community.list.mockResolvedValue({
      entries: [],
      totalBytes: 0,
      errors: [],
    });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesList(client as never);
    expect(h.infoSpy).toHaveBeenCalledWith('(no community templates)');
    expect(h.tableSpy).not.toHaveBeenCalled();
  });

  it('surfaces parse errors when present', async () => {
    const client = makeClient();
    client.templates.community.list.mockResolvedValue({
      entries: [],
      totalBytes: 0,
      errors: [
        { file: 'broken.json', error: 'invalid JSON' },
      ],
    });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesList(client as never);
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/Parse errors: 1/));
  });
});

describe('communityTemplatesImport', () => {
  it('prints usage and returns when the path is empty', async () => {
    const client = makeClient();
    await communityTemplatesImport(client as never, '');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(client.templates.community.import).not.toHaveBeenCalled();
  });

  it('reads the file and calls client.templates.community.import', async () => {
    const path = join(tmpDir, 'template.json');
    writeFileSync(path, '{"name":"x"}', 'utf8');
    const client = makeClient();
    client.templates.community.import.mockResolvedValue({
      id: 'c1',
      bytes: 11,
      file: 'c1.json',
    });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesImport(client as never, path);
    expect(client.templates.community.import).toHaveBeenCalledWith('{"name":"x"}', { replace: undefined });
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/Imported c1/));
  });

  it('forwards replace=true when passed', async () => {
    const path = join(tmpDir, 'template.json');
    writeFileSync(path, '{}', 'utf8');
    const client = makeClient();
    client.templates.community.import.mockResolvedValue({ id: 'c1', bytes: 2, file: 'c1.json' });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesImport(client as never, path, { replace: true });
    expect(client.templates.community.import).toHaveBeenCalledWith('{}', { replace: true });
  });

  it('reads from stdin when the path is "-"', async () => {
    const client = makeClient();
    client.templates.community.import.mockResolvedValue({ id: 'c1', bytes: 7, file: 'c1.json' });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    // Replace process.stdin with a Readable that emits Buffer chunks
    // (the lib concatenates Buffers, not strings). ESM marks
    // process.stdin as a read-only getter, so we override the
    // property rather than assigning to it.
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([Buffer.from('{"a":', 'utf8'), Buffer.from('1}', 'utf8')]),
      configurable: true,
    });
    await communityTemplatesImport(client as never, '-');
    expect(client.templates.community.import).toHaveBeenCalledWith('{"a":1}', { replace: undefined });
    expect(h.successSpy).toHaveBeenCalled();
  });

  it('prints an error when the file cannot be read', async () => {
    const client = makeClient();
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesImport(client as never, join(tmpDir, 'nope.json'));
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Failed to read/));
    expect(client.templates.community.import).not.toHaveBeenCalled();
  });

  it('prints the lib error message when the import rejects', async () => {
    const path = join(tmpDir, 'template.json');
    writeFileSync(path, '{}', 'utf8');
    const client = makeClient();
    client.templates.community.import.mockRejectedValue(new Error('Schema mismatch'));
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesImport(client as never, path);
    expect(h.errorSpy).toHaveBeenCalledWith('Schema mismatch');
  });
});

describe('communityTemplatesRemove', () => {
  it('prints usage when the id is empty', async () => {
    const client = makeClient();
    await communityTemplatesRemove(client as never, '');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(client.templates.community.remove).not.toHaveBeenCalled();
  });

  it('calls client.templates.community.remove and reports success', async () => {
    const client = makeClient();
    client.templates.community.remove.mockResolvedValue({ removed: true });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesRemove(client as never, 'c1');
    expect(client.templates.community.remove).toHaveBeenCalledWith('c1');
    expect(h.successSpy).toHaveBeenCalledWith('Removed c1.');
  });

  it('prints "not found" when the lib returns removed=false', async () => {
    const client = makeClient();
    client.templates.community.remove.mockResolvedValue({ removed: false });
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesRemove(client as never, 'c1');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/not found/));
  });

  it('prints the lib error message when the call rejects', async () => {
    const client = makeClient();
    client.templates.community.remove.mockRejectedValue(new Error('disk full'));
    h.spinnerSpy.mockImplementation(async (_msg: string, fn: () => Promise<unknown>) => fn());
    await communityTemplatesRemove(client as never, 'c1');
    expect(h.errorSpy).toHaveBeenCalledWith('disk full');
  });
});
