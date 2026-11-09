import { expect, it } from 'vitest';
import { isReplayedDelivery, resetReplayWindowForTests } from '../../apps/server/src/lib/webhooks.js';
it('allows the same provider delivery to reach two service-scoped receivers', () => {
  resetReplayWindowForTests();
  const headers = { 'x-github-delivery': 'same-repository-push' };
  const body = '{"ref":"refs/heads/main","after":"abc"}';
  const first = isReplayedDelivery(headers, 'github', { rawBody: body, scope: 1 });
  const duplicate = isReplayedDelivery(headers, 'github', { rawBody: body, scope: 1 });
  expect([first, duplicate]).toEqual([false, true]);
  console.log('CONTROL EXPECTED: first=false duplicate=true | ACTUAL:', first, duplicate);
  const sibling = isReplayedDelivery(headers, 'github', { rawBody: body, scope: 2 });
  console.log('EXPECTED: sibling replay=false | ACTUAL:', sibling);
  console.log(sibling ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
  expect(sibling).toBe(false);
});
