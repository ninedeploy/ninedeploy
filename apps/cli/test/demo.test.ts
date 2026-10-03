import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NineDeployClient } from '@ninedeploy/sdk';
import { demoSeed } from '../src/commands/demo.js';

describe('CLI demo command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  const fakeClient = {
    demo: {
      seed: vi.fn(),
    },
  } as unknown as NineDeployClient;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('runs demoSeed and prints project, database and service details', async () => {
    vi.mocked(fakeClient.demo.seed).mockResolvedValueOnce({
      ok: true,
      projectId: 1,
      projectName: 'Next.js Demo Stack',
      services: [
        { id: 10, name: 'Next.js Docker App', type: 'docker', status: 'running', port: 3000 },
        { id: 11, name: 'Next.js PM2 Service', type: 'pm2', status: 'running', port: null },
      ],
      database: { id: 5, name: 'demo-postgres', engine: 'postgres' },
    });

    await demoSeed(fakeClient);

    expect(logSpy).toHaveBeenCalledWith('  Seeding Next.js Docker + PM2 Demo Environment…');
    expect(logSpy).toHaveBeenCalledWith('  ✓ Project created: Next.js Demo Stack (#1)');
    expect(logSpy).toHaveBeenCalledWith('  ✓ Database created: demo-postgres (postgres)');
    expect(logSpy).toHaveBeenCalledWith('  ✓ Demo environment deployed and running successfully.');
  });

  it('runs demoSeed when database is null', async () => {
    vi.mocked(fakeClient.demo.seed).mockResolvedValueOnce({
      ok: true,
      projectId: 2,
      projectName: 'Next.js Demo Stack',
      services: [
        { id: 20, name: 'Next.js Docker App', type: 'docker', status: 'running', port: 3000 },
      ],
      database: null,
    });

    await demoSeed(fakeClient);

    expect(logSpy).toHaveBeenCalledWith('  ✓ Project created: Next.js Demo Stack (#2)');
  });
});
