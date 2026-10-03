import process from 'node:process';

/**
 * Line framing for stdin: a chunk may carry SEVERAL lines (a paste, or piped
 * input in CI) and a line may be split across chunks. Complete lines queue in
 * `lineBuffer` in FIFO order; the incomplete tail stays in `pendingTail` until
 * its newline arrives or stdin ends. prompt()/promptHidden() pull from the
 * queue, so a pasted block answers successive prompts in order instead of
 * collapsing into one value with embedded newlines (r024).
 *
 * Exactly ONE 'data' listener is wired per stdin stream: chunks route to the
 * active hidden prompt (raw keystrokes) or to the line framer — never both,
 * or a pasted line would be delivered twice. When `process.stdin` itself is
 * swapped (test suites install a fresh fake per case), the listeners and the
 * stream-lifecycle state are re-armed on the next call.
 */
let lineBuffer: string[] = [];
let pendingTail = '';
let eof = false;
let wiredStdin: unknown = null;
/** The exact handler references `attach()` registered on the current stdin. */
let wiredData: ((chunk: string) => void) | null = null;
let wiredEnd: (() => void) | null = null;

interface LineWaiter {
  deliver: (line: string) => void;
}

const lineWaiters: LineWaiter[] = [];
/** At most one hidden prompt at a time; it consumes live keystrokes. */
let hiddenWaiter: ((chunk: string) => void) | null = null;
/** EOF handler while a hidden prompt is active (resolves what was typed). */
let hiddenOnEnd: (() => void) | null = null;

function handleData(chunk: string): void {
  pendingTail += chunk;
  const lines = pendingTail.split(/\r?\n/);
  pendingTail = lines.pop() ?? '';
  lineBuffer.push(...lines);
  flushLineWaiters();
}

function handleEnd(): void {
  eof = true;
  // A final line without its newline (piped input that omits it) still counts.
  if (pendingTail !== '') {
    lineBuffer.push(pendingTail);
    pendingTail = '';
  }
  flushLineWaiters();
}

function flushLineWaiters(): void {
  while (lineWaiters.length > 0 && (lineBuffer.length > 0 || eof)) {
    const waiter = lineWaiters.shift()!;
    waiter.deliver(lineBuffer.length > 0 ? lineBuffer.shift()! : '');
  }
}

function detach(oldStdin: NodeJS.ReadStream): void {
  // Remove the same function references `attach()` registered — removing
  // different closures would be a silent no-op and leave live listeners on a
  // swapped-out stream.
  if (wiredData) oldStdin.removeListener('data', wiredData);
  if (wiredEnd) oldStdin.removeListener('end', wiredEnd);
  wiredData = null;
  wiredEnd = null;
}

/**
 * Wire the framer onto the CURRENT process.stdin. Re-arms when the stream
 * object changes (fresh fake per test case); a no-op otherwise, so the real
 * runtime keeps its queue and listeners across successive prompts.
 */
function attach(): void {
  const stdin = process.stdin;
  if (wiredStdin === stdin) return;
  if (wiredStdin) detach(wiredStdin as NodeJS.ReadStream);
  wiredStdin = stdin;
  // A different stream object is a fresh lifecycle.
  lineBuffer = [];
  pendingTail = '';
  eof = false;
  hiddenWaiter = null;
  hiddenOnEnd = null;
  stdin.setEncoding('utf8');
  wiredData = (chunk: string) => {
    if (hiddenWaiter) hiddenWaiter(chunk);
    else handleData(chunk);
  };
  wiredEnd = () => {
    if (hiddenOnEnd) hiddenOnEnd();
    else handleEnd();
  };
  stdin.on('data', wiredData);
  stdin.once('end', wiredEnd);
  stdin.resume();
}

/** Shift one buffered line, or null when the queue is empty. */
function takeLine(): string | null {
  return lineBuffer.length > 0 ? lineBuffer.shift()! : null;
}

/** Read a single line from stdin with normal echo. Honors an optional default. */
export function prompt(message: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    attach();
    process.stdin.resume();
    const deliver = (line: string): void => {
      const t = line.trim();
      resolve(t.length ? t : (defaultValue ?? ''));
    };
    const buffered = takeLine();
    if (buffered !== null) {
      deliver(buffered);
      return;
    }
    if (eof) {
      deliver('');
      return;
    }
    lineWaiters.push({ deliver });
    process.stdout.write(defaultValue ? `${message} [${defaultValue}]: ` : `${message}: `);
  });
}

/** Read a single line from stdin without echoing (for passwords / secrets). */
export function promptHidden(message: string): Promise<string> {
  return new Promise((resolve) => {
    attach();
    process.stdin.resume();
    // A line already framed by a paste/piped write satisfies the prompt
    // without entering raw mode. Stars preserve the historical echo.
    const buffered = takeLine();
    if (buffered !== null) {
      process.stdout.write(`${'*'.repeat(buffered.length)}\n`);
      resolve(buffered);
      return;
    }
    if (eof) {
      process.stdout.write('\n');
      resolve('');
      return;
    }
    const stdin = process.stdin;
    const isTTY = typeof stdin.setRawMode === 'function';
    let data = '';
    const cleanup = (): void => {
      if (isTTY) stdin.setRawMode(false);
      stdin.pause();
      hiddenWaiter = null;
      hiddenOnEnd = null;
    };
    // Escape-sequence decoding state, carried across chunks: terminal control
    // keys (arrows, Home, F1…) arrive as e.g. \x1b[A or \x1bOP — without
    // decoding them, the printable bytes of the sequence would leak into the
    // stored value.
    let escaped = false;
    let inCsi = false;
    hiddenWaiter = (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        if (escaped) {
          escaped = false;
          if (code >= 32 && code <= 126) {
            // '[' opens a CSI sequence; any other printable byte opens a
            // two-byte SS3-style sequence (function keys). Swallow the whole
            // sequence. A control byte instead means the bare Escape key was
            // pressed — fall through so Enter/Ctrl-C still work.
            if (code === 91) inCsi = true;
            continue;
          }
        }
        if (inCsi) {
          // CSI sequences end with a final byte in 0x40–0x7E.
          if (code >= 64 && code <= 126) inCsi = false;
          continue;
        }
        if (code === 27) {
          escaped = true;
        } else if (code === 13 || code === 10) {
          // Enter — deliver the hidden value; the rest of the chunk is the
          // paste tail and must feed the line queue, not vanish (r024). A CRLF
          // paste leaves a leading \n on that tail, which the framer would
          // split into a spurious empty first line and shift every later
          // answer — strip it here.
          let rest = chunk.slice(i + 1);
          if (code === 13 && rest.charCodeAt(0) === 10) rest = rest.slice(1);
          cleanup();
          process.stdout.write('\n');
          resolve(data);
          if (rest !== '') handleData(rest);
          return;
        } else if (code === 3) {
          // Ctrl-C: standard "interrupted" exit code (130 = 128 + SIGINT);
          // cleanup first so raw mode is restored before exiting.
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (code === 127 || code === 8) {
          // Backspace
          if (data.length > 0) {
            data = data.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (code >= 32 && code !== 127) {
          data += chunk[i]!;
          process.stdout.write('*');
        }
      }
    };
    hiddenOnEnd = (): void => {
      // EOF (piped stdin): resolve with whatever was typed so far.
      const typed = data;
      const tail = pendingTail;
      pendingTail = '';
      cleanup();
      eof = true;
      if (typed !== '') {
        process.stdout.write(`${'*'.repeat(typed.length)}\n`);
        resolve(typed);
      } else {
        process.stdout.write('\n');
        resolve('');
      }
      if (tail !== '') handleData(tail);
    };
    process.stdout.write(`${message}: `);
    if (isTTY) stdin.setRawMode(true);
  });
}
