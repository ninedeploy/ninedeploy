import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('query key guard', () => {
  it("r250: a service's deployment list is cached under one key, ['deploys', id]", () => {
    const offenders = files(SRC).filter((f) => readFileSync(f, 'utf8').includes("'service-deploys'"));
    expect(offenders).toEqual([]);
  });

  it("r342: the public OIDC provider list is cached under one key, ['public-oidc-providers']", () => {
    // SsoSection invalidates ['public-oidc-providers'] after every provider
    // edit; a second spelling left Account → linked sign-in stale.
    const offenders = files(SRC).filter((f) => readFileSync(f, 'utf8').includes("'oidc-public-providers'"));
    expect(offenders).toEqual([]);
  });
});
