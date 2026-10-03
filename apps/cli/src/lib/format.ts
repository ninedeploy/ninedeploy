/** CLI formatting utilities — colors, spinners, tables, banners. */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

export const c = {
  reset: (s: string) => `${RESET}${s}${RESET}`,
  bold: (s: string) => `${BOLD}${s}${RESET}`,
  dim: (s: string) => `${DIM}${s}${RESET}`,
  red: (s: string) => `${RED}${s}${RESET}`,
  green: (s: string) => `${GREEN}${s}${RESET}`,
  yellow: (s: string) => `${YELLOW}${s}${RESET}`,
  blue: (s: string) => `${BLUE}${s}${RESET}`,
  magenta: (s: string) => `${MAGENTA}${s}${RESET}`,
  cyan: (s: string) => `${CYAN}${s}${RESET}`,
  gray: (s: string) => `${GRAY}${s}${RESET}`,
};

const STATUS_COLORS: Record<string, (s: string) => string> = {
  running: c.green,
  healthy: c.green,
  active: c.green,
  sent: c.green,
  ok: c.green,
  stopped: c.gray,
  idle: c.gray,
  deploying: c.yellow,
  building: c.yellow,
  queued: c.yellow,
  pending: c.yellow,
  creating: c.yellow,
  error: c.red,
  failed: c.red,
  unhealthy: c.red,
};

export function statusColor(status: string): string {
  return (STATUS_COLORS[status] ?? ((s: string) => s))(status);
}

export function banner(): void {
  const gradient = `${MAGENTA}╔${'═'.repeat(44)}╗${RESET}
${MAGENTA}║${RESET}  ${BOLD}   9 NineDeploy${RESET}  ${DIM}Self-hosted PaaS${RESET}        ${MAGENTA}║${RESET}
${MAGENTA}║${RESET}  ${GRAY}Deploy from Git or Docker in one click${RESET}   ${MAGENTA}║${RESET}
${MAGENTA}╚${'═'.repeat(44)}╝${RESET}`;
  console.log(gradient);
  console.log();
}

/** Simple spinner that shows a message while a promise resolves. */
export async function spinner<T>(msg: string, fn: () => Promise<T>): Promise<T> {
  // Piped/CI stdout is not a TTY: `\r`-frames would smear braille garbage
  // through captured logs. Non-TTY output stays to a single plain line.
  const isTTY = process.stdout.isTTY === true;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = isTTY
    ? setInterval(() => {
        process.stdout.write(`\r${CYAN}${frames[i % frames.length]}${RESET} ${msg}...`);
        i++;
      }, 80)
    : null;
  if (!isTTY) process.stdout.write(`${msg}... `);
  try {
    const result = await fn();
    clearInterval(interval ?? undefined);
    if (isTTY) {
      process.stdout.write(`\r${GREEN}✓${RESET} ${msg}\n`);
    } else {
      process.stdout.write(`✓\n`);
    }
    return result;
  } catch (err) {
    clearInterval(interval ?? undefined);
    if (isTTY) {
      process.stdout.write(`\r${RED}✗${RESET} ${msg}\n`);
    } else {
      process.stdout.write(`✗\n`);
    }
    throw err;
  }
}

/** ANSI SGR escape sequence — built from a fragment so the source carries no
 *  literal control character and the regex stays a literal (biome-friendly). */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Visible length: ANSI SGR escapes render as zero width, so they must not
 *  count toward column widths or padding budgets. */
function visibleLength(s: string): number {
  return s.replace(ANSI_SGR, '').length;
}

/** Pad a (possibly colored) cell to `width` VISIBLE characters — padding is
 *  appended after any reset escape, so escape bytes never consume the budget. */
function padVisible(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleLength(s)));
}

/** Print a formatted table from an array of objects. */
export function table(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) { console.log(c.gray('  (empty)')); return; }
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const widths = cols.map((col) => Math.max(col.length, ...rows.map((r) => visibleLength(String(r[col] ?? '')))));

  // Header
  const header = cols.map((col, i) => col.padEnd(widths[i]!)).join('  ');
  console.log(`  ${c.bold(c.cyan(header))}`);
  console.log(`  ${'─'.repeat(widths.reduce((a, b) => a + b + 2, -2))}`);

  // Rows
  for (const row of rows) {
    const cells = cols.map((col, i) => {
      const val = String(row[col] ?? '');
      // statusColor AFTER padding would shift shorter cells; padVisible works
      // for BOTH colored and pre-colored-by-the-caller values (call sites
      // pass c.dim('—') / c.gray('never') straight into table()).
      if (col === 'status' || col === 'health') return padVisible(statusColor(val), widths[i]!);
      return padVisible(val, widths[i]!);
    });
    console.log(`  ${cells.join('  ')}`);
  }
  console.log();
}

/** Print a key-value pair with alignment. */
export function kv(key: string, value: unknown, indent = 2): void {
  const padded = ' '.repeat(indent);
  const val = value === null || value === undefined ? c.gray('—') : String(value);
  console.log(`${padded}${c.gray(key.padEnd(16))} ${val}`);
}

/** Print a section header. */
export function header(title: string): void {
  console.log();
  console.log(`  ${c.bold(c.cyan(title))}`);
  console.log(`  ${c.gray('─'.repeat(Math.max(title.length + 2, 30)))}`);
}

/** Print an error and mark the process as failed (exit code 1, no hard exit). */
export function error(msg: string, code = 1): void {
  console.error(`\n  ${c.red('✗')} ${msg}\n`);
  process.exitCode = code;
}

/** Print a success message. */
export function success(msg: string): void {
  console.log(`  ${c.green('✓')} ${c.green(msg)}`);
}

/** Print an info message. */
export function info(msg: string): void {
  console.log(`  ${c.blue('ℹ')} ${c.dim(msg)}`);
}

/** Format bytes to human readable. */
export function fmtBytes(b: number): string {
  if (!b) return '0 B';
  const mb = b / 1048576;
  if (mb < 1) return `${(b / 1024).toFixed(0)} KB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

/** Format relative time. */
export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return c.gray('never');
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
