import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Exercise the copy PM2's watcher actually resolves, including our pnpm patch.
const requireHere = createRequire(import.meta.url);
const requirePm2 = createRequire(requireHere.resolve('pm2'));
const requireWatcher = createRequire(requirePm2.resolve('chokidar'));
const braces = requireWatcher('braces') as {
  compile(input: unknown): string;
  expand(input: unknown): string[];
  stringify(input: unknown): string;
};
const depthError = expect.objectContaining({
  name: 'SyntaxError',
  message: 'Maximum nesting depth exceeded (256)',
});

describe('PM2 watcher brace nesting bounds', () => {
  it('preserves ordinary patterns, escaped braces and the supported depth boundary', () => {
    expect(braces.compile('src/{app,api}/*.ts')).toBe('src/(app|api)/*.ts');
    expect(braces.expand('src/{app,api}/*.ts')).toEqual(['src/app/*.ts', 'src/api/*.ts']);
    expect(braces.stringify('src/{app,api}/*.ts')).toBe('src/{app,api}/*.ts');
    expect(braces.compile('\\{'.repeat(300))).toBe('{'.repeat(300));
    expect(() => braces.compile('{'.repeat(256) + 'a,b' + '}'.repeat(256))).not.toThrow();
  });

  it('rejects balanced and unclosed brace/parenthesis patterns before recursive walkers', () => {
    const patterns = [
      '{'.repeat(4000) + 'a,b' + '}'.repeat(4000),
      '{'.repeat(4000) + 'x',
      '('.repeat(4000) + 'x' + ')'.repeat(4000),
      '('.repeat(4000) + 'x',
      '{'.repeat(257) + 'a,b' + '}'.repeat(257),
    ];
    for (const pattern of patterns) {
      for (const operation of [braces.compile, braces.expand, braces.stringify]) {
        expect(() => operation(pattern)).toThrowError(depthError);
      }
    }
  });

  it('also bounds caller-supplied ASTs that bypass string parsing', () => {
    type Ast = { type: string; value?: string; nodes?: Ast[] };
    let ast: Ast = { type: 'text', value: 'x' };
    for (let i = 0; i < 4000; i++) ast = { type: 'root', nodes: [ast] };
    for (const operation of [braces.compile, braces.expand, braces.stringify]) {
      expect(() => operation(ast)).toThrowError(depthError);
    }
  });
});
