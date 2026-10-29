import { beforeEach, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/exec.js', async original => ({ ...await original<typeof import('../../src/lib/exec.js')>(), capture }));
const { composeStackImages } = await import('../../src/lib/imageScan.js');
const first = 'a'.repeat(12), second = 'b'.repeat(12);
const image = `sha256:${'c'.repeat(64)}`;
beforeEach(() => capture.mockReset());

it('combines confirmed containers that use the same image', async () => {
  capture.mockResolvedValueOnce(`${first}\n${second}\n`).mockResolvedValueOnce(`${image}\tapi\n${image}\tworker\n`);
  expect(await composeStackImages('shop')).toEqual([{ imageId: image, services: ['api', 'worker'] }]);
});

it('rejects incomplete inspection instead of silently omitting a container', async () => {
  capture.mockResolvedValueOnce(`${first}\n${second}\n`).mockResolvedValueOnce(`${image}\tapi\n`);
  await expect(composeStackImages('shop')).rejects.toThrow(/incomplete|unconfirmed/i);
});

it('rejects malformed container listings instead of treating them as an empty stack', async () => {
  capture.mockResolvedValueOnce('not-an-id\n');
  await expect(composeStackImages('shop')).rejects.toThrow(/incomplete|unconfirmed/i);
});

it.each([
  ['duplicate container', `${first}\n${first}\n`, ''],
  ['invalid image', `${first}\n`, 'not-an-image\tapi\n'],
  ['missing service label', `${first}\n`, `${image}\t<no value>\n`],
  ['unexpected fields', `${first}\n`, `${image}\tapi\textra\n`],
])('rejects %s in the inventory', async (_name, containers, inspection) => {
  capture.mockResolvedValueOnce(containers).mockResolvedValueOnce(inspection);
  await expect(composeStackImages('shop')).rejects.toThrow(/incomplete|unconfirmed/i);
});

it('returns an empty list for a genuinely stopped stack', async () => {
  capture.mockResolvedValueOnce('');
  expect(await composeStackImages('shop')).toEqual([]);
  expect(capture).toHaveBeenCalledOnce();
});
