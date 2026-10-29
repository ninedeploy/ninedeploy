import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

const io = vi.hoisted(() => ({ op: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', async original => ({ ...await original<typeof import('../../src/lib/agentClient.js')>(), agentOp: io.op }));
vi.mock('../../src/lib/agentCapabilities.js', async original => ({ ...await original<typeof import('../../src/lib/agentCapabilities.js')>(), assertNodeCapability: vi.fn(async () => undefined) }));
const { scanNodeServiceImage, getImageScanResult } = await import('../../src/lib/imageScan.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');
const imageId = `sha256:${'a'.repeat(64)}`;
const different = `sha256:${'b'.repeat(64)}`;
const svc = { id: 8, serverId: 3, runtimeId: 'nd-svc-edge' };
const zero = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
const frame = `ND-IMAGE-SCAN ${JSON.stringify({ imageId, os: null, counts: zero, fixable: zero, findings: [], findingsTruncated: false })}`;
let db: DB;
beforeEach(async () => { db = await migratedDb(); io.op.mockReset(); });
afterEach(() => closeMigratedDb(db));

it('accepts a single successful scan receipt', async () => {
  io.op.mockResolvedValue({ exitCode: 0, lines: [frame] });
  expect(await scanNodeServiceImage(db, svc, 'manual')).toMatchObject({ status: 'ok', imageId });
});

it.each([
  ['duplicate receipts', { exitCode: 0, lines: [frame, frame] }],
  ['failed operation', { exitCode: 1, lines: [frame] }],
  ['oversized receipt', { exitCode: 0, lines: [`ND-IMAGE-SCAN ${'x'.repeat(1_048_577)}`] }],
])('records an error for %s instead of a clean result', async (_name, answer) => {
  io.op.mockResolvedValue(answer);
  expect(await scanNodeServiceImage(db, svc, 'manual')).toMatchObject({ status: 'error' });
  expect(await getImageScanResult(db, svc.id)).toMatchObject({ status: 'error' });
});

it.each([{ knownImageId: undefined, image: imageId }, { knownImageId: imageId, image: different }])(
  'refuses an unchanged receipt that does not match the requested image', async ({ knownImageId, image }) => {
    io.op.mockResolvedValue({ exitCode: 0, lines: [`ND-IMAGE-SCAN ${JSON.stringify({ imageId: image, unchanged: true })}`] });
    expect(await scanNodeServiceImage(db, svc, 'schedule', { knownImageId })).toMatchObject({ status: 'error' });
  },
);
