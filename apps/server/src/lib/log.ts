/**
 * Process-wide logging for code that has no Fastify instance in reach — the
 * kernel, the event buses, background libs and the env loader.
 *
 * Call sites take a scoped logger (`createLogger('EventBus')`) and never pick
 * the destination themselves. Until the panel boots, entries go to the console
 * (`[scope] message` + args, exactly what the former `console.*` calls wrote,
 * so tests that spy on `console` keep working); `buildApp` then points the sink
 * at the Fastify/pino logger, which adds structure, levels and the log drains.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Receives every entry. `scope` is the logger's name, `args` the extra values (errors, objects). */
export type LogSink = (level: LogLevel, scope: string, message: string, args: unknown[]) => void;

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** The pre-boot / standalone destination. `info` maps to console.log, as before. */
export const consoleSink: LogSink = (level, scope, message, args) => {
  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else if (level === 'debug') console.debug(line, ...args);
  else console.log(line, ...args);
};

let sink: LogSink = consoleSink;

/** Route every logger to `next`; returns the previous sink so a caller can restore it. */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

export function createLogger(scope: string): Logger {
  // Resolved per call, not captured: loggers are module-level constants created
  // long before buildApp swaps the sink.
  const emit = (level: LogLevel) => (message: string, ...args: unknown[]) => sink(level, scope, message, args);
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** The slice of pino's API the adapter uses (Fastify's `app.log` satisfies it). */
export interface PinoLike {
  child(bindings: Record<string, unknown>): Record<LogLevel, (obj: Record<string, unknown>, msg: string) => void>;
}

/**
 * A sink writing to pino: the scope becomes a `scope` binding, an Error among
 * the args becomes `err` (pino serializes its stack), anything else `args`.
 */
export function pinoSink(base: PinoLike): LogSink {
  const children = new Map<string, ReturnType<PinoLike['child']>>();
  return (level, scope, message, args) => {
    let child = children.get(scope);
    if (!child) {
      child = base.child({ scope });
      children.set(scope, child);
    }
    const obj: Record<string, unknown> = {};
    const rest: unknown[] = [];
    for (const a of args) {
      if (a instanceof Error && obj['err'] === undefined) obj['err'] = a;
      else rest.push(a);
    }
    if (rest.length > 0) obj['args'] = rest;
    child[level](obj, message);
  };
}

const bestEffortLog = createLogger('best-effort');

/**
 * Run a cleanup step whose failure must not propagate — unsubscribing, killing
 * an already-dead child, posting to a closed port. Replaces `try { … } catch {}`:
 * the failure is still swallowed, but recorded at debug level with `label`, so
 * it is visible when someone turns logging up instead of vanishing.
 *
 * A returned promise is handled the same way (never an unhandled rejection).
 */
export function bestEffort(label: string, fn: () => unknown, logger: Logger = bestEffortLog): void {
  const report = (err: unknown) => logger.debug(`${label} failed (ignored)`, err);
  try {
    const result = fn();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as Promise<unknown>).then(undefined, report);
    }
  } catch (err) {
    report(err);
  }
}
