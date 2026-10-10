import { describe, expect, it } from 'vitest';
import { classifyCloneFailure } from '../../src/lib/cloneFailure.js';

const CHANGED = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'Host key verification failed.',
  'fatal: Could not read from remote repository.',
].join('\n');

describe('classifyCloneFailure: a pinned SSH host key', () => {
  it('names the pinned key and says how to recover, instead of calling it a network failure', () => {
    const failure = classifyCloneFailure(new Error(CHANGED), 'main', { deployKey: 'k', pinHostKeys: true }, 'git@github.com:o/r.git');
    expect(failure).toMatchObject({ code: 'repo_unreachable', reason: 'pinned host key changed', submodule: false });
    expect(failure?.advice).toContain('reset the pinned host keys');
    expect(failure?.advice).toContain('System → Sources');
  });

  it('keeps the old classification when the source does not pin', () => {
    const failure = classifyCloneFailure(new Error(CHANGED), 'main', { deployKey: 'k' }, 'git@github.com:o/r.git');
    expect(failure?.reason).not.toBe('pinned host key changed');
  });

  it('does not mistake an authentication failure on a pinning source for a key change', () => {
    const failure = classifyCloneFailure(new Error('git@github.com: Permission denied (publickey).'), 'main', { deployKey: 'k', pinHostKeys: true }, 'git@github.com:o/r.git');
    expect(failure?.reason).toBe('authentication failed');
  });
});
