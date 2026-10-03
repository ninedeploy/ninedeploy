import { describe, expect, it } from 'vitest';
import { isDockerHub, parseImageRef } from '../../src/lib/imageRef.js';

describe('parseImageRef', () => {
  it('expands a bare official image to docker.io/library', () => {
    expect(parseImageRef('nginx')).toEqual({
      registry: 'index.docker.io',
      repository: 'library/nginx',
      tag: 'latest',
    });
  });

  it('parses user images with explicit tags', () => {
    expect(parseImageRef('acme/web:1.27')).toEqual({
      registry: 'index.docker.io',
      repository: 'acme/web',
      tag: '1.27',
    });
  });

  it('parses other-registry refs', () => {
    expect(parseImageRef('ghcr.io/acme/web:main')).toEqual({
      registry: 'ghcr.io',
      repository: 'acme/web',
      tag: 'main',
    });
  });

  it('keeps a registry port distinct from the tag', () => {
    expect(parseImageRef('localhost:5000/web:dev')).toEqual({
      registry: 'localhost:5000',
      repository: 'web',
      tag: 'dev',
    });
  });

  it('refuses digest-pinned refs — they never move', () => {
    expect(parseImageRef('nginx@sha256:abc123')).toBeNull();
  });

  it('refuses malformed input', () => {
    expect(parseImageRef('')).toBeNull();
    expect(parseImageRef('nginx:')).toBeNull();
    expect(parseImageRef('UPPERCASE/web')).toBeNull();
    expect(parseImageRef('acme/web:bad tag')).toBeNull();
  });

  it('recognizes Docker Hub under its spellings', () => {
    expect(isDockerHub('index.docker.io')).toBe(true);
    expect(isDockerHub('docker.io')).toBe(true);
    expect(isDockerHub('registry-1.docker.io')).toBe(true);
    expect(isDockerHub('ghcr.io')).toBe(false);
  });
});
