import { afterEach, describe, expect, it, vi } from 'vitest';
import { bestEffort, consoleSink, createLogger, pinoSink, setLogSink, type LogLevel, type LogSink } from '../../src/lib/log.js';

type Entry = [LogLevel, string, string, unknown[]];

function capture(): { entries: Entry[]; restore: () => void } {
  const entries: Entry[] = [];
  const previous = setLogSink((level, scope, message, args) => entries.push([level, scope, message, args]));
  return { entries, restore: () => setLogSink(previous) };
}

afterEach(() => {
  setLogSink(consoleSink);
  vi.restoreAllMocks();
});

describe('createLogger / setLogSink', () => {
  it('routes every level with its scope and extra args to the current sink', () => {
    const { entries, restore } = capture();
    const log = createLogger('EventBus');
    const err = new Error('boom');
    log.debug('d');
    log.info('i', 1);
    log.warn('w');
    log.error('e', err);
    restore();
    expect(entries).toEqual([
      ['debug', 'EventBus', 'd', []],
      ['info', 'EventBus', 'i', [1]],
      ['warn', 'EventBus', 'w', []],
      ['error', 'EventBus', 'e', [err]],
    ]);
  });

  it('resolves the sink per call: a logger created before the swap follows it', () => {
    const early = createLogger('early');
    const { entries, restore } = capture();
    early.warn('after swap');
    restore();
    expect(entries).toEqual([['warn', 'early', 'after swap', []]]);
  });

  it('setLogSink returns the previous sink so a caller can restore it', () => {
    const a: LogSink = () => undefined;
    const before = setLogSink(a);
    expect(setLogSink(before)).toBe(a);
  });
});

describe('consoleSink', () => {
  it('writes `[scope] message` plus the args to the matching console method', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = new Error('x');
    const logger = createLogger('Kernel');
    logger.error('failed:', err);
    logger.warn('careful');
    logger.debug('detail');
    logger.info('hello', { a: 1 });
    expect(error).toHaveBeenCalledWith('[Kernel] failed:', err);
    expect(warn).toHaveBeenCalledWith('[Kernel] careful');
    expect(debug).toHaveBeenCalledWith('[Kernel] detail');
    expect(log).toHaveBeenCalledWith('[Kernel] hello', { a: 1 });
  });
});

describe('pinoSink', () => {
  function fakePino() {
    const calls: Array<{ bindings: Record<string, unknown>; level: LogLevel; obj: Record<string, unknown>; msg: string }> = [];
    const childCalls: Array<Record<string, unknown>> = [];
    const base = {
      child(bindings: Record<string, unknown>) {
        childCalls.push(bindings);
        const at = (level: LogLevel) => (obj: Record<string, unknown>, msg: string) => calls.push({ bindings, level, obj, msg });
        return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
      },
    };
    return { base, calls, childCalls };
  }

  it('binds the scope, lifts the first Error to `err` and keeps the rest as `args`', () => {
    const { base, calls } = fakePino();
    const sink = pinoSink(base);
    const e1 = new Error('first');
    const e2 = new Error('second');
    sink('error', 'PluginLoader', 'restore failed', [e1, 'ctx', e2]);
    sink('info', 'PluginLoader', 'plain', []);
    expect(calls).toEqual([
      { bindings: { scope: 'PluginLoader' }, level: 'error', obj: { err: e1, args: ['ctx', e2] }, msg: 'restore failed' },
      { bindings: { scope: 'PluginLoader' }, level: 'info', obj: {}, msg: 'plain' },
    ]);
  });

  it('creates one child per scope, not one per entry', () => {
    const { base, childCalls } = fakePino();
    const sink = pinoSink(base);
    sink('info', 'a', 'x', []);
    sink('warn', 'a', 'y', []);
    sink('info', 'b', 'z', []);
    expect(childCalls).toEqual([{ scope: 'a' }, { scope: 'b' }]);
  });
});

describe('bestEffort', () => {
  it('runs the step and logs nothing when it succeeds', () => {
    const { entries, restore } = capture();
    const fn = vi.fn();
    bestEffort('unsubscribe', fn);
    restore();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([]);
  });

  it('swallows a synchronous throw and records it at debug with the label', () => {
    const { entries, restore } = capture();
    const err = new Error('already dead');
    expect(() =>
      bestEffort('child kill', () => {
        throw err;
      }),
    ).not.toThrow();
    restore();
    expect(entries).toEqual([['debug', 'best-effort', 'child kill failed (ignored)', [err]]]);
  });

  it('handles a rejected promise the same way (no unhandled rejection)', async () => {
    const { entries, restore } = capture();
    const err = new Error('port closed');
    bestEffort('post SHUTDOWN', () => Promise.reject(err));
    await new Promise((r) => setTimeout(r, 0));
    restore();
    expect(entries).toEqual([['debug', 'best-effort', 'post SHUTDOWN failed (ignored)', [err]]]);
  });

  it('reports through the logger it is given', () => {
    const { entries, restore } = capture();
    bestEffort(
      'terminate',
      () => {
        throw new Error('x');
      },
      createLogger('Sandbox:p1'),
    );
    restore();
    expect(entries[0]?.slice(0, 3)).toEqual(['debug', 'Sandbox:p1', 'terminate failed (ignored)']);
  });
});
