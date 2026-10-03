import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prompt, promptHidden } from '../src/prompts.js';

type FakeStdin = EventEmitter & {
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
  setRawMode?: ReturnType<typeof vi.fn>;
};

/** A fake stdin stream. `tty: true` adds setRawMode, which triggers the TTY path. */
function makeStdin(tty: boolean): FakeStdin {
  const s = new EventEmitter() as FakeStdin;
  s.resume = vi.fn();
  s.pause = vi.fn();
  s.setEncoding = vi.fn();
  if (tty) s.setRawMode = vi.fn();
  return s;
}

function stubStdin(stdin: FakeStdin) {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as NodeJS.ReadStream);
}

let stdoutWrite: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stdoutWrite = vi.fn();
  vi.spyOn(process, 'stdout', 'get').mockReturnValue({
    write: stdoutWrite,
  } as unknown as NodeJS.WriteStream);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('prompt', () => {
  it('writes the message with a default hint and resolves trimmed input', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = prompt('Server URL', 'http://default');

    expect(stdoutWrite).toHaveBeenCalledWith('Server URL [http://default]: ');
    stdin.emit('data', '  http://x  \n');
    await expect(result).resolves.toBe('http://x');
  });

  it('resolves the default when the input is empty', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = prompt('Server URL', 'http://default');

    stdin.emit('data', '\r\n');
    await expect(result).resolves.toBe('http://default');
  });

  it('resolves an empty string for empty input without a default', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = prompt('Email');

    expect(stdoutWrite).toHaveBeenCalledWith('Email: ');
    stdin.emit('data', '   \n');
    await expect(result).resolves.toBe('');
  });

  it('resolves the default when stdin ends (EOF in piped/CI input)', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = prompt('Server URL', 'http://default');

    stdin.emit('end');
    await expect(result).resolves.toBe('http://default');
  });

  it('resolves an empty string on EOF without a default', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = prompt('Email');

    stdin.emit('end');
    await expect(result).resolves.toBe('');
  });
});

describe('promptHidden', () => {
  it('echoes asterisks and resolves on Enter when stdin is a TTY', async () => {
    const stdin = makeStdin(true);
    stubStdin(stdin);

    const result = promptHidden('Password');

    expect(stdoutWrite).toHaveBeenCalledWith('Password: ');
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);

    stdin.emit('data', 'ab');
    expect(stdoutWrite).toHaveBeenCalledWith('*');

    stdin.emit('data', '\r');
    await expect(result).resolves.toBe('ab');
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith('\n');
  });

  it('handles backspace and non-printable characters on a non-TTY stream', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = promptHidden('Password');

    expect(stdin.setRawMode).toBeUndefined();
    stdin.emit('data', 'pas\u007f'); // p, a, s, backspace
    stdin.emit('data', '\u0008'); // another backspace
    stdin.emit('data', '\u001b'); // ESC — falls through the branch chain
    stdin.emit('data', '\r');
    await expect(result).resolves.toBe('p');
    expect(stdoutWrite).toHaveBeenCalledWith('\b \b');
  });

  it('ignores backspace when there is no input yet', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = promptHidden('Password');

    stdin.emit('data', '\u007f'); // nothing to delete
    stdin.emit('data', 'x\r');
    await expect(result).resolves.toBe('x');
    expect(stdoutWrite).not.toHaveBeenCalledWith('\b \b');
  });

  it('exits with the SIGINT code 130 on Ctrl-C and restores raw mode', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdin = makeStdin(true);
    stubStdin(stdin);

    promptHidden('Password'); // never resolves — Ctrl-C terminates instead

    stdin.emit('data', '\u0003');
    expect(exit).toHaveBeenCalledWith(130);
    // Cleanup runs before exit: raw mode is restored and the stream paused.
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
  });

  it('resolves typed input on EOF (piped stdin)', async () => {
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const result = promptHidden('Password');

    stdin.emit('data', 'secret');
    stdin.emit('end');
    await expect(result).resolves.toBe('secret');
  });
});

// ── r024: stdin line framing ───────────────────────────────────────────────
//
// stdin delivers CHUNKS, not lines: a multi-line paste or piped write arrives
// as one chunk, and a line can be split across chunks. The framer must queue
// complete lines in FIFO order, keep the incomplete tail, and route the tail
// left after a hidden prompt's Enter back into the queue — otherwise a pasted
// block collapses into one value with embedded newlines (the r024 defect) or
// is silently lost. Each case loads a FRESH module instance (the framer keeps
// per-process state) against a fresh fake stdin.

async function loadFramer(): Promise<typeof import('../src/prompts.js')> {
  vi.resetModules();
  return await import('../src/prompts.js');
}

async function flushed(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Wait until the given prompt label has been flushed to stdout. */
async function waitForLabel(label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (stdoutWrite.mock.calls.some((c: unknown[]) => String(c[0]).includes(label))) return;
    await flushed();
  }
  throw new Error(`prompt label "${label}" never flushed`);
}

describe('prompt line framing (r024)', () => {
  it('delivers the FIRST line of a multi-line paste to the active prompt', async () => {
    const { prompt } = await loadFramer();
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const pending = prompt('Repository URL');
    await flushed();
    await waitForLabel('Repository URL');
    stdin.emit('data', 'my-service\nmain\n');
    await expect(pending).resolves.toBe('my-service');
  });

  it('feeds successive prompts in FIFO order from one paste', async () => {
    const { prompt } = await loadFramer();
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const a = prompt('A');
    await flushed();
    await waitForLabel('A');
    const b = prompt('B');
    await flushed();
    await waitForLabel('B');
    stdin.emit('data', 'one\ntwo\n');
    await expect(a).resolves.toBe('one');
    await expect(b).resolves.toBe('two');
  });

  it('reassembles a line split across two chunk writes', async () => {
    const { prompt } = await loadFramer();
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const pending = prompt('Split');
    await flushed();
    await waitForLabel('Split');
    stdin.emit('data', 'hel');
    await flushed();
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending');
    stdin.emit('data', 'lo\n');
    await expect(pending).resolves.toBe('hello');
  });

  it('counts a final line without a trailing newline on EOF', async () => {
    const { prompt } = await loadFramer();
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const pending = prompt('No newline');
    await flushed();
    await waitForLabel('No newline');
    stdin.emit('data', 'tail-line');
    await flushed();
    stdin.emit('end');
    await expect(pending).resolves.toBe('tail-line');
  });
});

describe('promptHidden line framing (r024)', () => {
  it('routes the paste tail after Enter to the NEXT prompt', async () => {
    const { promptHidden, prompt } = await loadFramer();
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const pw = promptHidden('Password');
    await flushed();
    await waitForLabel('Password');
    const name = prompt('Name');
    await flushed();
    await waitForLabel('Name');
    stdin.emit('data', 'secret\nadmin\n');
    await expect(pw).resolves.toBe('secret');
    await expect(name).resolves.toBe('admin');
  });

  it('strips the LF of a CRLF paste tail so later answers do not shift', async () => {
    const { promptHidden, prompt } = await loadFramer();
    const stdin = makeStdin(false);
    stubStdin(stdin);

    const pw = promptHidden('Password');
    await flushed();
    await waitForLabel('Password');
    const name = prompt('Name');
    await flushed();
    await waitForLabel('Name');
    // Windows paste: \r\n terminators. The hidden prompt consumes up to \r;
    // the tail starts with \n, which must not queue a spurious empty line.
    stdin.emit('data', 'secret\r\nadmin\r\n');
    await expect(pw).resolves.toBe('secret');
    await expect(name).resolves.toBe('admin');
  });

  it('swallows arrow-key CSI sequences instead of leaking their bytes', async () => {
    const { promptHidden } = await loadFramer();
    const stdin = makeStdin(true);
    stubStdin(stdin);

    const pw = promptHidden('Password');
    await flushed();
    await waitForLabel('Password');
    // Up arrow pressed twice, then the actual value.
    stdin.emit('data', '\u001b[A\u001b[B');
    stdin.emit('data', 'real');
    stdin.emit('data', '\r');
    await expect(pw).resolves.toBe('real');
    // The sequence bytes must never have echoed as stars.
    expect(stdoutWrite).not.toHaveBeenCalledWith('*'.repeat(2));
  });

  it('swallows a two-byte Alt-chord (ESC + printable) without storing either byte', async () => {
    const { promptHidden } = await loadFramer();
    const stdin = makeStdin(true);
    stubStdin(stdin);

    const pw = promptHidden('Password');
    await flushed();
    await waitForLabel('Password');
    stdin.emit('data', '\u001bx'); // Alt-x chord — both bytes dropped
    stdin.emit('data', 'x');
    stdin.emit('data', '\r');
    await expect(pw).resolves.toBe('x');
  });
});

describe('stdin swap', () => {
  it('detaches listeners from the old stream so stale data cannot pollute', async () => {
    const { prompt } = await loadFramer();
    const first = makeStdin(false);
    stubStdin(first);

    const done = prompt('First');
    await flushed();
    await waitForLabel('First');
    first.emit('data', 'one\n');
    await expect(done).resolves.toBe('one');

    // A fresh fake stdin (as a test suite re-stubs per case) must re-arm on
    // the new object AND fully detach the old one.
    const second = makeStdin(false);
    stubStdin(second);
    const next = prompt('Second');
    await flushed();
    await waitForLabel('Second');
    second.emit('data', 'fresh\n'); // the real answer on the new stream
    first.emit('data', 'stale\n'); // late data on the OLD stream
    await expect(next).resolves.toBe('fresh');
  });
});
