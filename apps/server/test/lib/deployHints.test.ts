import { describe, expect, it } from 'vitest';
import { detectDeployHints } from '../../src/lib/deployHints.js';

describe('detectDeployHints', () => {
  it('returns empty for a clean log', () => {
    expect(detectDeployHints('Building image...\nDone!\n')).toEqual([]);
  });

  it('returns empty for an empty log', () => {
    expect(detectDeployHints('')).toEqual([]);
  });

  it('detects lockfile mismatch', () => {
    const hints = detectDeployHints('npm ERR! code EUSAGE\nnpm ERR! lockfile is not up to date');
    expect(hints.some((h) => h.label === 'lockfile-mismatch')).toBe(true);
  });

  it('detects TypeScript errors', () => {
    const hints = detectDeployHints('src/app.ts(5,3): error TS2345: Argument of type...');
    expect(hints.some((h) => h.label === 'typescript-error')).toBe(true);
  });

  it('detects missing module', () => {
    const hints = detectDeployHints("Error: Cannot find module 'express'");
    expect(hints.some((h) => h.label === 'missing-module')).toBe(true);
  });

  it('detects port conflict', () => {
    const hints = detectDeployHints('Error: listen EADDRINUSE: address already in use :::3000');
    expect(hints.some((h) => h.label === 'port-conflict')).toBe(true);
  });

  it('detects out-of-memory', () => {
    const hints = detectDeployHints('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');
    expect(hints.some((h) => h.label === 'out-of-memory')).toBe(true);
  });

  it('detects Dockerfile not found', () => {
    const hints = detectDeployHints('failed to read dockerfile: open /work/Dockerfile: no such file');
    expect(hints.some((h) => h.label === 'dockerfile-not-found')).toBe(true);
  });

  it('detects npm 404', () => {
    const hints = detectDeployHints('npm ERR! 404 Not Found - GET https://registry.npmjs.org/nonexistent');
    expect(hints.some((h) => h.label === 'npm-404')).toBe(true);
  });

  it('returns multiple hints when multiple patterns match', () => {
    const log = 'error TS2345: type error\nCannot find module \'react\'';
    const hints = detectDeployHints(log);
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });
});
