import { describe, expect, it } from 'vitest';
import { MAX_SERVICE_FILE_BYTES, serviceFilePathProblem, serviceFilePut, utf8Length } from '../src/index.js';

describe('file mounts (0.16.3)', () => {
  it('takes an absolute file path outside what Docker manages', () => {
    expect(serviceFilePut.parse({ path: '/etc/nginx/nginx.conf', content: 'events {}' })).toEqual({ path: '/etc/nginx/nginx.conf', content: 'events {}' });
    expect(serviceFilePathProblem('/app/config.yaml')).toBeNull();
    // A name that only starts like a reserved path is fine.
    expect(serviceFilePathProblem('/devices.json')).toBeNull();
  });

  it('refuses directories, relative paths, ".." and the paths Docker manages', () => {
    for (const path of ['/', '/etc/', 'etc/x.conf', '/a/../b', '/proc/x', '/sys', '/dev/null', '/etc/hosts', '/etc/resolv.conf', '/var/run/docker.sock', `/${'a'.repeat(300)}`]) {
      expect(serviceFilePut.safeParse({ path, content: '' }).success, path).toBe(false);
    }
    expect(serviceFilePathProblem('/etc/hostname')).toMatch(/managed by Docker/);
    expect(serviceFilePathProblem('/srv/')).toMatch(/not a directory/);
  });

  it('caps the content at 256 KiB of UTF-8 and refuses NUL bytes', () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
    expect(serviceFilePut.safeParse({ path: '/a', content: 'x'.repeat(MAX_SERVICE_FILE_BYTES) }).success).toBe(true);
    expect(serviceFilePut.safeParse({ path: '/a', content: 'é'.repeat(MAX_SERVICE_FILE_BYTES / 2 + 1) }).success).toBe(false);
    expect(serviceFilePut.safeParse({ path: '/a', content: `a${String.fromCharCode(0)}b` }).success).toBe(false);
  });
});
