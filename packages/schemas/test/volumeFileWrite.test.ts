import { describe, expect, it } from 'vitest';
import { containerFileWrite, volumeFileWrite } from '../src/service.js';

describe.each([
  ['volume', volumeFileWrite],
  ['container', containerFileWrite],
] as const)('%s file content validation', (_kind, schema) => {
  it.each(['@@@@', 'a', 'AA=A', '====', 'AAAA==='])(
    'refuses malformed base64 %j before the write operation',
    (contentBase64) => {
      expect(schema.safeParse({ path: 'app.env', contentBase64 }).success).toBe(false);
    },
  );

  it.each(['', 'YQ==', 'YWI=', 'YWJj', 'Y W\nJj'])(
    'preserves valid base64 %j, including empty and wrapped content',
    (contentBase64) => {
      expect(schema.parse({ path: 'app.env', contentBase64 })).toEqual({
        path: 'app.env', contentBase64,
      });
    },
  );

  it('accepts an editor-sized binary payload without altering it', () => {
    const contentBase64 = Buffer.alloc(1024 * 1024).toString('base64');
    expect(schema.parse({ path: 'app.env', contentBase64 }).contentBase64).toBe(contentBase64);
  });
});
