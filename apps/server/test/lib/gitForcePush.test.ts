import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A local-path remote is not a network URL the egress gate understands; this
// suite exercises real git behaviour, not the gate (covered in gitEgress.test).
vi.mock('../../src/lib/gitEgress.js', () => ({
  assertCloneTargetAllowed: async () => undefined,
  vetCloneTarget: async () => null,
  curlResolveEntry: () => '',
}));

const { checkoutCommit } = await import('../../src/lib/git.js');

const root = path.join(os.tmpdir(), `ninedeploy-gitfp-${process.pid}-${Date.now()}`);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function upstream(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  git(dir, 'add', 'app.txt');
  git(dir, 'commit', '-q', '-m', 'A');
  return dir;
}

/** File content, line-ending agnostic (core.autocrlf may rewrite on checkout). */
function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8').trim();
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkoutCommit against a real repository (r273)', () => {
  it('builds the new tip after a force-push instead of silently keeping the old HEAD', async () => {
    const up = upstream('up-force');
    const work = path.join(root, 'work-force');
    await checkoutCommit(up, 'main', undefined, work, () => undefined);
    expect(read(work, 'app.txt')).toBe('v1');

    // Rewrite history upstream: the old commit A is no longer an ancestor, and
    // the rewrite touches the same line, so a merge/rebase pull cannot succeed.
    writeFileSync(path.join(up, 'app.txt'), 'v2\n');
    git(up, 'commit', '-q', '-a', '--amend', '-m', 'B');
    const tip = git(up, 'rev-parse', 'HEAD');

    const resolved = await checkoutCommit(up, 'main', undefined, work, () => undefined);
    expect(resolved).toBe(tip);
    expect(read(work, 'app.txt')).toBe('v2');
  });

  it('follows a fast-forward and discards build leftovers in the reused tree', async () => {
    const up = upstream('up-ff');
    const work = path.join(root, 'work-ff');
    await checkoutCommit(up, 'main', undefined, work, () => undefined);
    // An earlier build left an untracked file the new commit now tracks.
    writeFileSync(path.join(work, 'Dockerfile'), 'FROM stale\n');

    writeFileSync(path.join(up, 'Dockerfile'), 'FROM fresh\n');
    git(up, 'add', 'Dockerfile');
    git(up, 'commit', '-q', '-m', 'C');
    const tip = git(up, 'rev-parse', 'HEAD');

    await expect(checkoutCommit(up, 'main', undefined, work, () => undefined)).resolves.toBe(tip);
    expect(read(work, 'Dockerfile')).toBe('FROM fresh');
  });
});
