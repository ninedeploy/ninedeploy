// Generates docs/CLI_REFERENCE.md from the built CLI's own `--help` output.
//
// Usage: node scripts/generate-cli-reference.mjs [outputFile]
//
// Run `pnpm build` first: the reference is read from apps/cli/dist, so it can
// never describe a command, argument or option the CLI does not have. The
// curated guide (sign-in, configuration, examples, SDK and MCP) stays in
// docs/AI_MCP_CLI.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'apps', 'cli', 'dist', 'index.js');
const outFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'docs', 'CLI_REFERENCE.md');
if (!fs.existsSync(cli)) {
  console.error('apps/cli/dist/index.js is missing: run `pnpm build` first.');
  process.exit(1);
}

// ANSI color sequences (ESC is built at runtime: Biome rejects control characters in literals).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s) => s.replace(ANSI, '');
const help = (args) => {
  try {
    return strip(execFileSync(process.execPath, [cli, ...args, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).split(/\r?\n/);
  } catch (err) {
    return strip(String(err.stdout || '')).split(/\r?\n/);
  }
};
const version = strip(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })).trim();
const isHelpFlag = (flag) => /^(-h, )?--help$/.test(flag);

/** Split a two-column help row (`  left<2+ spaces>right`) into its columns. */
function columns(line) {
  const i = line.slice(2).search(/\s{2,}/);
  if (i < 0) return [line.trim(), ''];
  return [line.slice(2, 2 + i).trim(), line.slice(2 + i).trim()];
}

function parse(lines) {
  const usageLine = lines.find((l) => l.startsWith('Usage:')) ?? '';
  const ui = lines.indexOf(usageLine);
  const desc = [];
  for (const l of lines.slice(ui + 1)) {
    if (/^(Options|Commands):\s*$/.test(l)) break;
    if (l.trim() !== '') desc.push(l.trim());
  }
  const options = [];
  const commands = [];
  const sectionAt = (name) => lines.indexOf(`${name}:`);
  // A section is a list of rows; a row starts with exactly two spaces and
  // continues on the indented lines below it.
  const collect = (start, stopName, sink) => {
    let current = null;
    for (const l of lines.slice(start + 1)) {
      if (l.trim() === '' || l === `${stopName}:`) break;
      if (/^ {2}\S/.test(l)) {
        if (current) sink(current);
        const [left, text] = columns(l);
        current = { left, text };
      } else if (current) {
        current.text += ` ${l.trim()}`;
      }
    }
    if (current) sink(current);
  };
  const oi = sectionAt('Options');
  if (oi >= 0) collect(oi, 'Commands', (o) => options.push({ flag: o.left, text: o.text }));
  const ci = sectionAt('Commands');
  if (ci >= 0) {
    collect(ci, 'Options', (c) => {
      // `name|alias [args] <args>` -> first name, argument placeholders, text.
      const m = /^([^\s|]+)(?:\|[^\s|]+)*((?:\s+(?:\[[^\]]*\]|<[^>]+>))*)$/.exec(c.left);
      if (m && m[1] !== 'help') commands.push({ name: m[1], args: m[2].trim(), text: c.text });
    });
  }
  return { usage: usageLine, desc: desc.join(' '), options, commands };
}

const esc = (s) => s.replace(/\|/g, '\\|');
const out = [];
out.push('# CLI command reference');
out.push('');
out.push(`Every command of the \`ninedeploy\` CLI at version **${version}**, generated from the CLI's own \`--help\` output by \`scripts/generate-cli-reference.mjs\`. Each entry gives the usage line, the description and the options exactly as the CLI prints them. For sign-in, configuration, examples and the SDK and MCP references, see [API, MCP, CLI and SDK](AI_MCP_CLI.md).`);
out.push('');
out.push('The same text is available in a terminal with `ninedeploy <command> --help` or `ninedeploy <command> <subcommand> --help`.');
out.push('');

const commands = parse(help([])).commands;
out.push('| Command | Description |');
out.push('|---|---|');
for (const c of commands) out.push(`| [\`${c.name}\`](#${c.name}) | ${esc(c.text)} |`);
out.push('');

const optionTable = (opts) => {
  const rows = opts.filter((o) => !isHelpFlag(o.flag));
  if (!rows.length) return;
  out.push('');
  out.push('| Option | Description |');
  out.push('|---|---|');
  for (const o of rows) out.push(`| \`${esc(o.flag)}\` | ${esc(o.text)} |`);
};

let subcommands = 0;
for (const c of commands) {
  const h = parse(help([c.name]));
  const alias = (h.usage.match(/^Usage:\s*ninedeploy\s+[\w-]+\|([\w|-]+)/) || [])[1];
  out.push(`## \`${c.name}\``, '');
  if (h.usage) out.push('```', h.usage.replace(/^Usage:\s*/, ''), '```', '');
  out.push(h.desc || c.text);
  if (alias) out.push('', `Can also be called as ${alias.split('|').map((a) => `\`ninedeploy ${a}\``).join(' or ')}.`);
  optionTable(h.options);
  out.push('');
  for (const s of h.commands) {
    const sh = parse(help([c.name, s.name]));
    out.push(`### \`${c.name} ${s.name}\``, '');
    if (sh.usage) out.push('```', sh.usage.replace(/^Usage:\s*/, ''), '```', '');
    out.push(sh.desc || s.text);
    optionTable(sh.options);
    out.push('');
    subcommands++;
  }
}
fs.writeFileSync(outFile, `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
console.log(`docs/CLI_REFERENCE.md: version ${version}, ${commands.length} commands, ${subcommands} subcommands`);
