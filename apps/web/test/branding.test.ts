import { describe, expect, it } from 'vitest';
import { safeLogoUrl, safeSupportEmail } from '../src/lib/branding.js';

describe('branding sanitisers (r360)', () => {
  it('lets http(s) and inline images through as logos', () => {
    expect(safeLogoUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(safeLogoUrl('  http://intranet.local/logo.svg ')).toBe('http://intranet.local/logo.svg');
    expect(safeLogoUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeLogoUrl('data:image/svg+xml,%3Csvg%3E')).toBe('data:image/svg+xml,%3Csvg%3E');
  });

  it('refuses every other scheme, relative paths and empties', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      '/logo.png',
      'not a url',
      '',
      '   ',
      null,
      undefined,
    ]) {
      expect(safeLogoUrl(bad)).toBeNull();
    }
  });

  it('accepts a plain support address and refuses anything that could smuggle mailto headers', () => {
    expect(safeSupportEmail(' help@acme.test ')).toBe('help@acme.test');
    for (const bad of ['help@acme.test?cc=x@y.z', 'a b@c.d', 'nobody', 'javascript:x@y.z', '', null, undefined]) {
      expect(safeSupportEmail(bad)).toBeNull();
    }
  });
});
