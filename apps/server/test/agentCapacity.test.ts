import { describe, expect, it } from 'vitest';
import { agentRoutes } from '../src/agent.js';
import { buildAgentApp } from '../src/agentApp.js';
import { open as openSealed, seal } from '../src/lib/agentSeal.js';

const shared = 'cd'.repeat(32);
async function appWith() {
  const app = await buildAgentApp();
  app.log.level = 'silent';
  await app.register(agentRoutes, { tokenHash: shared });
  return app;
}
const ping = (index: number) => ({ sealed: seal(shared, { op: 'agent.ping', params: {}, nonce: `capacity-${index}` }) });

describe('agent control-plane capacity and rejection limits', () => {
  it('admits more than 120 authenticated operations without dropping capability checks', async () => {
    const app = await appWith();
    try {
      for (let index = 0; index < 121; index++) {
        const response = await app.inject({ method: 'POST', url: '/agent/exec', payload: ping(index) });
        expect(response.statusCode, `sealed operation ${index + 1}`).toBe(200);
        expect(openSealed(shared, response.json().sealed)).toMatchObject({ nonce: `capacity-${index}`, exitCode: 0 });
      }
    } finally { await app.close(); }
  });

  it('retains the 120-per-minute ceiling for invalid authentication', async () => {
    const app = await appWith();
    try {
      for (let index = 0; index < 120; index++) {
        expect((await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: 'invalid' } })).statusCode).toBe(401);
      }
      const blocked = await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: 'invalid' } });
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // An unrelated peer has its own rejection and request buckets.
      expect((await app.inject({ method: 'POST', url: '/agent/exec', remoteAddress: '127.0.0.2', payload: ping(9001) })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('still bounds valid operations to 1000 per minute', async () => {
    const app = await appWith();
    try {
      for (let index = 0; index < 1000; index++) {
        expect((await app.inject({ method: 'POST', url: '/agent/exec', payload: ping(index) })).statusCode, `sealed operation ${index + 1}`).toBe(200);
      }
      expect((await app.inject({ method: 'POST', url: '/agent/exec', payload: ping(1000) })).statusCode).toBe(429);
    } finally { await app.close(); }
  });

  it('also bounds concurrent invalid authentication attempts', async () => {
    const app = await appWith();
    try {
      const responses = await Promise.all(Array.from({ length: 150 }, () => app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: 'invalid' } })));
      expect(responses.filter(response => response.statusCode === 401)).toHaveLength(120);
      expect(responses.filter(response => response.statusCode === 429)).toHaveLength(30);
    } finally { await app.close(); }
  });
});
