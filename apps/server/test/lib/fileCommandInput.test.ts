import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { streamFileToCommand } from '../../src/lib/fileCommandInput.js';
import { ExecTimeoutError } from '../../src/lib/exec.js';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'nd-file-input-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('streams exact binary bytes into a real child without a shell', async () => {
  const source = join(directory, 'source.dump'), target = join(directory, 'received.dump');
  const bytes = Buffer.from(Array.from({ length: 1_048_576 }, (_, index) => index % 256));
  await writeFile(source, bytes);
  await streamFileToCommand(process.execPath, ['-e', 'const fs=require("node:fs");process.stdin.pipe(fs.createWriteStream(process.argv[1]));', target], source, 5000);
  expect(await readFile(target)).toEqual(bytes);
});
it('kills and drains a child when input cannot be read', async () => {
  await expect(streamFileToCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], join(directory, 'missing'), 5000)).rejects.toThrow('File input command did not complete');
});
it('bounds a child that never drains stdin', async () => {
  const source = join(directory, 'source.dump'); await writeFile(source, Buffer.alloc(8 * 1024 * 1024));
  await expect(streamFileToCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], source, 500)).rejects.toBeInstanceOf(ExecTimeoutError);
});
