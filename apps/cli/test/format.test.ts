import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  banner,
  c,
  error,
  fmtBytes,
  fmtTime,
  header,
  info,
  kv,
  spinner,
  statusColor,
  success,
  table,
} from '../src/lib/format.js';

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let stdoutWrite: ReturnType<typeof vi.fn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  stdoutWrite = vi.fn();
  vi.spyOn(process, 'stdout', 'get').mockReturnValue({
    write: stdoutWrite,
  } as unknown as NodeJS.WriteStream);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('color helpers', () => {
  it('wraps strings in ANSI codes for every color', () => {
    expect(c.red('x')).toBe('\x1b[31mx\x1b[0m');
    expect(c.green('x')).toBe('\x1b[32mx\x1b[0m');
    expect(c.yellow('x')).toBe('\x1b[33mx\x1b[0m');
    expect(c.blue('x')).toBe('\x1b[34mx\x1b[0m');
    expect(c.magenta('x')).toBe('\x1b[35mx\x1b[0m');
    expect(c.cyan('x')).toBe('\x1b[36mx\x1b[0m');
    expect(c.gray('x')).toBe('\x1b[90mx\x1b[0m');
    expect(c.bold('x')).toBe('\x1b[1mx\x1b[0m');
    expect(c.dim('x')).toBe('\x1b[2mx\x1b[0m');
    expect(c.reset('x')).toBe('\x1b[0mx\x1b[0m');
  });
});

describe('statusColor', () => {
  it('colors known statuses and passes unknown ones through', () => {
    expect(statusColor('running')).toBe('\x1b[32mrunning\x1b[0m');
    expect(statusColor('deploying')).toBe('\x1b[33mdeploying\x1b[0m');
    expect(statusColor('failed')).toBe('\x1b[31mfailed\x1b[0m');
    expect(statusColor('stopped')).toBe('\x1b[90mstopped\x1b[0m');
    expect(statusColor('mystery')).toBe('mystery');
  });
});

describe('banner', () => {
  it('prints the gradient banner and a blank line', () => {
    banner();
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0]![0]).toContain('NineDeploy');
  });
});

describe('spinner', () => {
  it('animates while the promise resolves, then prints a checkmark', async () => {
    vi.useFakeTimers();
    let resolveFn!: (v: string) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolveFn = resolve; }),
    );

    const result = spinner('Working', fn);
    await vi.advanceTimersByTimeAsync(80); // let one interval tick fire (frames/i++)
    resolveFn('done');
    await expect(result).resolves.toBe('done');

    expect(fn).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Working'));
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('✓'));
  });

  it('prints a cross and rethrows when the promise rejects', async () => {
    vi.useFakeTimers();
    let rejectFn!: (e: Error) => void;
    const fn = vi.fn().mockImplementation(
      () => new Promise<string>((_, reject) => { rejectFn = reject; }),
    );

    const result = spinner('Working', fn);
    const assertion = expect(result).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(80); // let one interval tick fire
    rejectFn(new Error('boom'));
    await assertion;

    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('✗'));
  });
});

describe('table', () => {
  it('prints a placeholder for an empty table', () => {
    table([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('(empty)'));
  });

  it('uses explicit columns and colors status/health cells', () => {
    table(
      [
        { id: 1, name: 'api', status: 'running', health: 'healthy' },
        { id: 2, name: 'web' },
      ],
      ['id', 'name', 'status', 'health'],
    );
    const text = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('api');
    expect(text).toContain('\x1b[32mrunning\x1b[0m');
    expect(text).toContain('web');
  });

  it('keeps colored status cells aligned when a value is shorter than the column', () => {
    // Regression: cells were padded AFTER coloring, so the 9 invisible ANSI
    // bytes consumed the pad budget and short colored values ('ok' vs
    // 'running') shifted every later column in the row.
    table([
      { name: 'web', status: 'running', region: 'eu' },
      { name: 'api', status: 'ok', region: 'us' },
    ]);
    const ESC = String.fromCharCode(0x1b);
    const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    // No-arg console.log() calls (table's trailing blank line) become '' so
    // the trim filter drops them, matching real console output.
    const lines = logSpy.mock.calls
      .map((call) => (call.length > 0 ? String(call[0]) : ''))
      .map(stripAnsi)
      .filter((l) => l.trim().length > 0);
    // Header + ruler + two data rows, every line visibly identical in width.
    expect(lines).toHaveLength(4);
    const headerWidth = lines[0]!.length;
    for (const line of lines) expect(line.length).toBe(headerWidth);
    // And the region column starts at the same visible offset everywhere.
    const regionStart = lines[0]!.indexOf('region');
    expect(lines[2]!.indexOf('eu')).toBe(regionStart);
    expect(lines[3]!.indexOf('us')).toBe(regionStart);
  });

  it('keeps colored health cells aligned when a value is shorter than the column', () => {
    table([
      { name: 'web', health: 'healthy', region: 'eu' },
      { name: 'api', health: 'ok', region: 'us' },
    ]);
    const ESC = String.fromCharCode(0x1b);
    const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    const lines = logSpy.mock.calls
      .map((call) => (call.length > 0 ? String(call[0]) : ''))
      .map(stripAnsi)
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(4);
    const headerWidth = lines[0]!.length;
    for (const line of lines) expect(line.length).toBe(headerWidth);
  });

  it('aligns columns when a caller passes pre-colored cell values', () => {
    // Call sites pass values like c.dim('—') / c.gray('never') straight into
    // table(); the width budget must count VISIBLE characters, so raw ANSI
    // bytes can neither inflate the column nor consume the padding.
    table([
      { name: 'web', days: '30', note: 'plain' },
      { name: 'api', days: c.dim('—'), note: 'plain2' },
    ]);
    const ESC = String.fromCharCode(0x1b);
    const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
    const lines = logSpy.mock.calls
      .map((call) => (call.length > 0 ? String(call[0]) : ''))
      .map(stripAnsi)
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(4);
    const headerWidth = lines[0]!.length;
    for (const line of lines) expect(line.length).toBe(headerWidth);
    const noteStart = lines[0]!.indexOf('note');
    expect(lines[2]!.indexOf('plain')).toBe(noteStart);
    expect(lines[3]!.indexOf('plain2')).toBe(noteStart);
  });

  it('infers columns from the first row when none are given', () => {
    table([{ a: 1, b: 'x' }]);
    expect(logSpy.mock.calls[0]![0]).toContain('a');
    expect(logSpy.mock.calls[0]![0]).toContain('b');
  });

  it('throws on a sparse first row', () => {
    // rows[0] undefined takes the `?? {}` fallback, then the empty width
    // table cannot render.
    expect(() => table(new Array(1))).toThrow(RangeError);
  });
});

describe('kv', () => {
  it('prints key and value pairs with alignment', () => {
    kv('Name', 'api');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Name'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('api'));
  });

  it('prints a dash for null and undefined values', () => {
    kv('Null', null);
    kv('Undef', undefined);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('—'));
  });

  it('honors a custom indent', () => {
    kv('K', 'v', 4);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('    \x1b[90mK'));
  });
});

describe('header / success / info', () => {
  it('prints a section header with a rule', () => {
    header('Title');
    const text = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('Title');
    expect(text).toContain('─');
  });

  it('prints a success message', () => {
    success('All good');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✓'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('All good'));
  });

  it('prints an info message', () => {
    info('Heads up');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Heads up'));
  });
});

describe('error', () => {
  it('prints the message and sets exit code 1 by default', () => {
    process.exitCode = 0;
    error('Something broke');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Something broke'));
    expect(process.exitCode).toBe(1);
  });

  it('sets an explicit exit code', () => {
    process.exitCode = 0;
    error('Nope', 3);
    expect(process.exitCode).toBe(3);
  });
});

describe('fmtBytes', () => {
  it('formats zero, KB, MB, and GB sizes', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(500)).toBe('0 KB');
    expect(fmtBytes(5 * 1048576)).toBe('5.0 MB');
    expect(fmtBytes(2 * 1024 * 1048576)).toBe('2.00 GB');
  });
});

describe('fmtTime', () => {
  it('prints never for missing timestamps', () => {
    expect(fmtTime(null)).toContain('never');
    expect(fmtTime('')).toContain('never');
  });

  it('prints relative time buckets', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(fmtTime(new Date(now - 30_000).toISOString())).toBe('just now');
    expect(fmtTime(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(fmtTime(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(fmtTime(new Date(now - 2 * 86_400_000).toISOString())).toBe(
      new Date(now - 2 * 86_400_000).toLocaleDateString(),
    );
  });
});
