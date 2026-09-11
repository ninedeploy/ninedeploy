import { describe, expect, it } from 'vitest';
import { splitHookCommand } from '../../src/engine/pipeline.js';

/**
 * Unit tests for the quote-aware lifecycle-hook tokenizer. Hooks are
 * documented as ONE argv-style command whose compound form is
 * `sh -c "a && b"` — that only works if the split honours quoting. The
 * whitespace split this replaced left the quote bytes in argv
 * (`sh -c '"a'` → command not found).
 */
describe('splitHookCommand', () => {
  it('splits plain whitespace-separated argv', () => {
    expect(splitHookCommand('docker exec -it c sh')).toEqual(['docker', 'exec', '-it', 'c', 'sh']);
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(splitHookCommand('  a   b  ')).toEqual(['a', 'b']);
  });

  it('keeps double-quoted groups as one argument, quotes stripped', () => {
    expect(splitHookCommand('sh -c "migrate && start"')).toEqual(['sh', '-c', 'migrate && start']);
  });

  it('treats single quotes as fully literal (backslashes included)', () => {
    expect(splitHookCommand(`echo 'a "b" \\\\ c'`)).toEqual([`echo`, `a "b" \\\\ c`]);
  });

  it('honours backslash escaping of quotes and backslashes inside double quotes', () => {
    expect(splitHookCommand('print "say \\"hi\\""')).toEqual(['print', 'say "hi"']);
    expect(splitHookCommand('print "a\\\\b"')).toEqual(['print', 'a\\b']);
  });

  it('keeps empty quoted arguments', () => {
    expect(splitHookCommand('tool "" flag')).toEqual(['tool', '', 'flag']);
    expect(splitHookCommand("tool '' flag")).toEqual(['tool', '', 'flag']);
  });

  it('runs unterminated quotes to end of input instead of dropping the token', () => {
    expect(splitHookCommand('sh -c "a && b')).toEqual(['sh', '-c', 'a && b']);
  });

  it('escapes the next character with a backslash outside quotes', () => {
    expect(splitHookCommand('echo a\\ b')).toEqual(['echo', 'a b']);
  });

  it('returns an empty array for a blank command', () => {
    expect(splitHookCommand('   ')).toEqual([]);
  });
});
