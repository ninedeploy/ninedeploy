// The server package's unit suite split across processes: how many, and how their coverage is
// checked once. Pure functions, so a test can hold them to what they promise;
// scripts/test-server-sharded.mjs drives them.
import path from 'node:path';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';

const TYPES = ['statements', 'branches', 'functions', 'lines'];

/** What one shard holds at its most, in GiB: Vitest, the server's module graph and its coverage. Measured in a container on November 25, 2026: three shards together held 5.8 GiB at their most. */
export const SHARD_GIB = 2;

/**
 * How many processes to run at once: twice the cores, never more than 12, and never more than
 * the memory holds (two GiB stay for everything else) — unless the count is set. Eight shards in
 * a 7.8 GiB container were killed for want of memory on November 25, 2026.
 */
export function shardCount(value, parallelism, totalGiB = Number.POSITIVE_INFINITY) {
  if (value !== undefined && value !== '') {
    const set = Number(value);
    if (!Number.isInteger(set) || set < 1) throw new Error(`SERVER_TEST_SHARDS must be a whole number of at least 1, got "${value}"`);
    return set;
  }
  if (!Number.isInteger(parallelism) || parallelism < 1) throw new Error(`availableParallelism() gave ${parallelism}`);
  return Math.max(1, Math.min(12, parallelism * 2, Math.floor((totalGiB - 2) / SHARD_GIB)));
}

/** What `vitest list --filesOnly` printed: one path a line, under `test/`. */
export function parseFileList(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('test/'));
}

/**
 * The files in small chunks for the processes to take in turn, in Vitest's order and every file
 * in one chunk. Four chunks a process: the last chunk a process takes is then a quarter of its
 * work, where Vitest's own `--shard` leaves one alphabetical range a process — and the heaviest
 * files sit together in the alphabet (11.5 minutes against an average of 6.6, November 25, 2026).
 */
export function chunkFiles(files, workers) {
  const size = Math.max(1, Math.ceil(files.length / (workers * 4)));
  const chunks = [];
  for (let at = 0; at < files.length; at += size) chunks.push(files.slice(at, at + size));
  return chunks;
}

// ANSI colour sequences. ESC is built at runtime: Biome rejects control characters in a literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Complete lines out of a stream that arrives in pieces of its own choosing: a pipe can hand a
 * line over in two, and Vitest's summary arrived as " Test Files " and "38 passed (38)".
 * Call with the last piece and `true` at the end.
 */
export function lineSplitter() {
  let rest = '';
  return (text, final = false) => {
    const lines = `${rest}${text}`.replaceAll('\r\n', '\n').split('\n');
    rest = lines.pop();
    return final ? (rest ? [...lines, rest] : lines) : lines;
  };
}

/** How many files a chunk's summary line says passed, coloured or not; null for any other line. */
export function passedFiles(line) {
  const summary = /^\s*Test Files\s+(\d+) passed/.exec(line.replace(ANSI, ''));
  return summary ? Number(summary[1]) : null;
}

/**
 * The four global floors as apps/server/vitest.config.ts names them, so the floors have one home.
 * The block carries comments, so the numbers are read from the last `thresholds: {` in the file.
 */
export function readThresholds(configText) {
  const at = configText.lastIndexOf('thresholds: {');
  const numbers = at < 0 ? null : /statements:\s*([\d.]+)\s*,\s*branches:\s*([\d.]+)\s*,\s*functions:\s*([\d.]+)\s*,\s*lines:\s*([\d.]+)/.exec(configText.slice(at));
  if (!numbers) throw new Error('could not read the four coverage floors from apps/server/vitest.config.ts');
  const [statements, branches, functions, lines] = numbers.slice(1).map(Number);
  for (const [type, floor] of Object.entries({ statements, branches, functions, lines })) {
    if (!(floor >= 0 && floor <= 100)) throw new Error(`the ${type} floor read from apps/server/vitest.config.ts is ${floor}, not a percentage`);
  }
  return { statements, branches, functions, lines };
}

/** The report's file keys as Vitest names them elsewhere: from the workspace root, with a leading
 * slash. The `json` reporter writes absolute paths, which differ between shards' machines and
 * hold a backslash on Windows. A coverage map files a report by the `path` inside it, so that
 * moves with the key.
 */
export function keysFromRoot(report, root) {
  const out = {};
  for (const [file, data] of Object.entries(report)) {
    const key = `/${path.relative(root, file).split(path.sep).join('/')}`;
    out[key] = { ...data, path: key };
  }
  return out;
}

/** Every shard's report (the `json` coverage reporter's document) as one coverage map. */
export function mergeReports(reports) {
  const map = createCoverageMap({});
  for (const report of reports) map.merge(report);
  return map;
}

/** The floors a summary does not meet, in Vitest's own words; empty when it passes. */
export function unmetThresholds(summary, thresholds) {
  return TYPES
    .filter((type) => summary[type].pct < thresholds[type])
    .map((type) => `ERROR: Coverage for ${type} (${summary[type].pct.toFixed(2)}%) does not meet global threshold (${thresholds[type]}%)`);
}

const pct = (covered, total) => (total ? Number(((covered / total) * 100).toFixed(2)) : 100);

/** A summary's four percentages: of one file, or of the whole map. */
export function percentages(summary) {
  return Object.fromEntries(TYPES.map((type) => [type, pct(summary[type].covered, summary[type].total)]));
}

/** For the log: every source directory with its covered and total counts, largest directory first. */
export function directoryRows(map) {
  const rows = new Map();
  for (const file of map.files()) {
    const dir = file.split('/').slice(0, -1).join('/') || '.';
    const summary = map.fileCoverageFor(file).toSummary();
    const row = rows.get(dir) ?? { dir, files: 0, ...Object.fromEntries(TYPES.map((type) => [type, { covered: 0, total: 0 }])) };
    row.files += 1;
    for (const type of TYPES) { row[type].covered += summary[type].covered; row[type].total += summary[type].total; }
    rows.set(dir, row);
  }
  return [...rows.values()]
    .map((row) => ({ dir: row.dir, files: row.files, pct: Object.fromEntries(TYPES.map((type) => [type, pct(row[type].covered, row[type].total)])) }))
    .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));
}

/** The `json-summary` document of a merged map: one entry per file, and `total`. */
export function summaryDocument(map) {
  const document = {};
  for (const file of map.files()) document[file] = map.fileCoverageFor(file).toSummary().data;
  document.total = map.getCoverageSummary().data;
  return document;
}
