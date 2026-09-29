import { describe, expect, it } from 'vitest';
import { buildAgentApp } from '../src/agentApp.js';

/**
 * r438: the agent app's bodyLimit must sit ABOVE its own 1 MiB content caps —
 * workspace files travel base64-wrapped (~4/3 inflation), so Fastify's 1 MiB
 * default killed honest payloads with a generic 413 before the agent's own
 * better-messaged check could run (effective cap was ~0.75 MiB).
 */
describe('buildAgentApp bodyLimit (r438)', () => {
  it('allows what the agent\'s own 1 MiB content checks permit (envelope overhead included)', async () => {
    const app = await buildAgentApp();
    expect(app.initialConfig.bodyLimit).toBe(4 * 1024 * 1024);
    await app.close();
  });
});
