import { describe, expect, it, vi } from 'vitest';
import { createClient, NineDeployError } from '../src/index.js';

describe('deployment release metadata', () => {
  it('reads safe recovery metadata through the service-scoped endpoint', async () => {
    const info = { available: true, mode: 'recorded-compose', imageCount: 2, reason: 'Volume data is not restored.' };
    const fetch = vi.fn(async () => new Response(JSON.stringify(info), { status: 200 }));
    const client = createClient({ baseUrl: 'https://panel.test', token: 'fixture-token', fetch });
    expect(await client.deploys.releaseInfo(7, 42)).toEqual(info);
    expect(fetch).toHaveBeenCalledWith('https://panel.test/v1/services/7/deploys/42/release', expect.objectContaining({ method: 'GET' }));
  });

  it('propagates service access refusal instead of promising recovery', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Service not found' } }), { status: 404 }));
    const client = createClient({ baseUrl: 'https://panel.test', token: 'fixture-token', fetch });
    await expect(client.deploys.releaseInfo(7, 42)).rejects.toBeInstanceOf(NineDeployError);
  });
});
