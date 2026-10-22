import { describe, expect, it } from 'vitest';
import { createComposeRelease, MAX_COMPOSE_RELEASE_BYTES, parseComposeRelease, renderComposeRelease } from '../../src/lib/composeRelease.js';

const image = `sha256:${'a'.repeat(64)}`;
const identity = { serviceId: 1, slug: 'stack', composeService: 'web', runtimeId: 'ndcmp-stack-web-1', port: 8080, healthPath: '/ready' };
const model = () => ({ services: { web: { image: 'example:latest', build: { context: '/repo' }, environment: { PASSWORD: 'private-$HOME-$$-${TOKEN}' }, volumes: [{ type: 'volume', source: 'data', target: '/data' }] } }, volumes: { data: { name: 'ndcmp-stack_data' } } });

describe('Compose release artifacts', () => {
  it('pins actual images, removes rebuild inputs, and retains resolved environment inside the record', () => {
    const record = createComposeRelease(identity, JSON.stringify(model()), { web: image });
    expect(record.model.services).toMatchObject({ web: { image, pull_policy: 'never', environment: { PASSWORD: 'private-$HOME-$$-${TOKEN}' } } });
    expect((record.model.services as Record<string, object>).web).not.toHaveProperty('build');
    expect(parseComposeRelease(JSON.stringify(record))).toEqual(record);
    expect(record.port).toBe(8080);
  });

  it('preserves the dollar escaping already emitted by docker compose config for replay', () => {
    const canonical = model();
    canonical.services.web.environment.PASSWORD = 'private-$$HOME-$$$$-$${TOKEN}';
    const record = createComposeRelease(identity, JSON.stringify(canonical), { web: image });
    const output = JSON.parse(renderComposeRelease(record));
    expect(output.services.web.environment.PASSWORD).toBe('private-$$HOME-$$$$-$${TOKEN}');
    expect((record.model.services as Record<string, { environment: object }>).web?.environment).toEqual(canonical.services.web.environment);
  });

  it.each([
    { volumes: [{ type: 'bind', source: '/host/secret', target: '/data' }] },
    { volumes: [{ type: 'volume', target: '/anonymous' }] },
    { configs: ['config'] },
    { secrets: ['secret'] },
    { profiles: ['optional'] },
    { env_file: ['.env'] },
    { label_file: ['labels.txt'] },
    { environment: { UNRESOLVED: null } },
  ])('refuses a model whose runtime is not self-contained: %j', patch => {
    const input = model();
    Object.assign(input.services.web, patch);
    expect(() => createComposeRelease(identity, JSON.stringify(input), { web: image })).toThrow(/Compose release/);
  });

  it('refuses missing images, malformed IDs, missing routing service, oversized records and future versions', () => {
    expect(() => createComposeRelease(identity, JSON.stringify(model()), {})).toThrow(/missing a container image/);
    expect(() => createComposeRelease(identity, JSON.stringify(model()), { web: 'example:latest' })).toThrow(/missing a container image/);
    expect(() => createComposeRelease({ ...identity, composeService: 'missing' }, JSON.stringify(model()), { web: image })).toThrow(/routing service/);
    expect(() => createComposeRelease(identity, ' '.repeat(MAX_COMPOSE_RELEASE_BYTES + 1), { web: image })).toThrow(/1 MiB/);
    const record = createComposeRelease(identity, JSON.stringify(model()), { web: image });
    expect(() => parseComposeRelease(JSON.stringify({ ...record, version: 2 }))).toThrow(/Invalid/);
    (record.model.services as Record<string, { image: string }>).web!.image = 'latest';
    expect(() => parseComposeRelease(JSON.stringify(record))).toThrow(/not pinned/);
  });
});
