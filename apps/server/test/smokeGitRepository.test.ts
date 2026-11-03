import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSwarmGitRepository, gitHttpServerCode } from '../../../scripts/lib/smoke-git-repository.mjs';

it('serves two real commits over smart HTTP to shallow clones and retains the original pinned commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nd-owned-git-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const repository = createSwarmGitRepository(root);
    child = spawn(process.execPath, ['-e', gitHttpServerCode(root, 0)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Owned Git HTTP startup deadline')), 5000);
      child!.once('error', reject);
      child!.stdout!.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim()).port); } });
    });
    const url = `http://127.0.0.1:${port}/repo.git`;
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
    };
    git(['clone', '--depth', '1', url, 'first']);
    expect(git(['-C', 'first', 'rev-parse', 'HEAD'])).toBe(repository.first);
    expect(readFileSync(join(root, 'first', 'app.cjs'), 'utf8')).toContain('baked-one');
    const second = repository.advance(); expect(second).not.toBe(repository.first);
    git(['clone', '--depth', '1', url, 'second']);
    expect(git(['-C', 'second', 'rev-parse', 'HEAD'])).toBe(second);
    expect(readFileSync(join(root, 'second', 'app.cjs'), 'utf8')).toContain('baked-two');
    git(['-C', 'second', 'fetch', 'origin', repository.first]); git(['-C', 'second', 'checkout', repository.first]);
    expect(readFileSync(join(root, 'second', 'app.cjs'), 'utf8')).toContain('baked-one');
    expect((await fetch(`http://127.0.0.1:${port}/outside.git/info/refs`)).status).toBe(404);
    for (let n = 0; n < 20 && (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).active; n++) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).active).toBe(0);
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).requests).toBeGreaterThan(0);
  } finally {
    if (child && child.exitCode == null) {
      const exited = new Promise(resolve => child!.once('exit', resolve)); child.kill(); await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
