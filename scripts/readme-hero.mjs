#!/usr/bin/env node
// A5: cut the README's short recording and convert it to the GIF the README shows.
// e2e/tests/hero.spec.ts writes hero.webm and hero.json (through scripts/smoke-browser-e2e.mjs);
// this keeps the seconds asked for and encodes a GIF from them. ffmpeg runs in a container, so
// nothing is installed on the machine.
//
// Usage:
//   node scripts/readme-hero.mjs <hero.webm> <hero.gif> [--keep=<from>-<to>[,<from>-<to>…]] [--fps=8] [--width=1104] [--colors=96] [--max-mb=8]
//   node scripts/readme-hero.mjs <hero.webm> --info        prints the recording's length and size
// The seconds are those of hero.json, where each step of the recording happened.

import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';

const FFMPEG_IMAGE = 'jrottenberg/ffmpeg:7.1-ubuntu';
const [, , webmArg, gifArg, ...flags] = process.argv;
const option = (name, fallback) => flags.find((flag) => flag.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (!webmArg) throw new Error('usage: readme-hero.mjs <hero.webm> <hero.gif> [--keep=<from>-<to>,…] | --info');
const webm = resolve(webmArg);
const gif = resolve(gifArg && !gifArg.startsWith('--') ? gifArg : `${webm}.gif`);
const keep = option('keep', null);
const ranges = keep === null ? null : keep.split(',').map((range) => range.split('-').map(Number));
if (ranges?.some(([from, to]) => !(from >= 0 && to > from))) throw new Error('--keep takes <from>-<to> pairs with to greater than from');
const fps = Number(option('fps', 8));
const width = Number(option('width', 1104));
const colors = Number(option('colors', 96));
const maxMb = Number(option('max-mb', 8));

// The two files must share a directory: the container sees one mount.
if (dirname(webm) !== dirname(gif)) throw new Error('the recording and the GIF must be in one directory');

function ffmpeg(args, timeout = 600_000) {
  return spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dirname(webm)}:/data`, '--entrypoint', 'ffmpeg', FFMPEG_IMAGE, ...args], {
    encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 << 20,
  });
}

const input = ['-i', `/data/${basename(webm)}`];
if (flags.includes('--info')) {
  const probe = ffmpeg(['-hide_banner', ...input], 120_000);
  // ffmpeg prints what it read of the file on stderr before it stops on "At least one output".
  const line = probe.stderr.split('\n').find((text) => text.includes('Duration:'));
  console.log(`${basename(webm)}: ${statSync(webm).size} bytes; ${line?.trim() ?? 'no duration line'}`);
  process.exit(0);
}

// The seconds kept, joined without a gap: a comma inside a filter's argument is escaped for the filter chain.
const kept = ranges === null ? '' : `select=${ranges.map(([from, to]) => `between(t\\,${from}\\,${to})`).join('+')},setpts=N/FRAME_RATE/TB,`;
const filters = [
  `${kept}fps=${fps}`,
  `scale=${width}:-2:flags=lanczos`,
  'split[frames][for palette]',
  `[for palette]palettegen=max_colors=${colors}:stats_mode=diff[palette]`,
  '[frames][palette]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
].join(',');
const run = ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', ...input, '-vf', filters, '-loop', '0', `/data/${basename(gif)}`]);
if (run.status !== 0) throw new Error(`ffmpeg exited ${run.status}: ${(run.stderr || run.error?.message || '').trim().slice(-2000)}`);
const size = statSync(gif).size;
const seconds = ranges === null ? null : ranges.reduce((sum, [from, to]) => sum + to - from, 0);
console.log(
  `${basename(gif)}: ${(size / 2 ** 20).toFixed(2)} MiB from ${basename(webm)} (${(statSync(webm).size / 2 ** 20).toFixed(1)} MiB): `
  + `${ranges === null ? 'the whole recording' : `kept ${keep} (${seconds.toFixed(1)} s)`}, ${fps} fps, ${width} px wide, ${colors} colours`,
);
if (size > maxMb * 2 ** 20) {
  console.error(`The GIF is above ${maxMb} MiB: keep fewer seconds, or lower fps, width or colours.`);
  process.exitCode = 1;
}
