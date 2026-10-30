import { expect, it, vi } from 'vitest';
import type { PrimaryRuntimeSnapshot } from '@ninedeploy/db';
import { retireNodeDeploymentGeneration } from '../../src/lib/nodeDeploymentRetirement.js';

const owner = { serviceId: 7, serverId: 4, deploymentId: 11, epoch: 3, requestId: 'a'.repeat(32) };
const group: PrimaryRuntimeSnapshot = { runtimeId: 'web-10', port: 3000, healthPath: '/', healthCheck: null, replicas: 1, commitSha: null,
  containers: [{ name: 'web-10', id: 'b'.repeat(64), observed: true }],
  spares: [{ name: 'web-10-r2', id: 'c'.repeat(64), observed: true }, { name: 'web-10-r3', id: null, observed: true }] };
const checkpoint = vi.fn(async () => undefined);
const client = () => ({ retire: vi.fn(async input => ({ requestId: input.requestId, serviceId: input.serviceId, revision: input.revision,
  complete: true, items: input.targets.map(target => ({ ...target, removed: true })) })) });
const args = () => ({ owner, group, selectedRuntimeId: 'web-11', graceSeconds: 5, checkpoint });

it('replays one immutable retirement intent covering running and spare IDs', async () => {
  const agent = client(); await retireNodeDeploymentGeneration(agent, args()); await retireNodeDeploymentGeneration(agent, args());
  expect(agent.retire.mock.calls[0]).toEqual(agent.retire.mock.calls[1]);
  expect(agent.retire.mock.calls[0]![0].targets).toEqual([{ id: 'b'.repeat(64), name: 'web-10', deploymentId: 10 },
    { id: 'c'.repeat(64), name: 'web-10-r2', deploymentId: 10 }]);
});
it('refuses a selected, unknown or malformed generation before invoking the agent', async () => {
  const agent = client();
  await expect(retireNodeDeploymentGeneration(agent, { ...args(), selectedRuntimeId: group.runtimeId })).rejects.toThrow(/authority/);
  await expect(retireNodeDeploymentGeneration(agent, { ...args(), group: { ...group, spares: [{ name: 'web-10-r2', id: null, observed: false }] } })).rejects.toThrow(/unconfirmed/);
  await expect(retireNodeDeploymentGeneration(agent, { ...args(), group: { ...group, runtimeId: 'web-unknown' } })).rejects.toThrow(/generation/);
  expect(agent.retire).not.toHaveBeenCalled();
});
it('rejects incomplete retirement evidence', async () => {
  const agent = client(), normal = agent.retire.getMockImplementation()!;
  agent.retire.mockImplementation(async input => ({ ...await normal(input), items: [] }));
  await expect(retireNodeDeploymentGeneration(agent, args())).rejects.toThrow(/receipt/);
});
it('rechecks ownership when the agent reply is lost or returns after a newer owner', async () => {
  const agent = client(), check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('owner changed'));
  agent.retire.mockRejectedValue(new Error('reply lost'));
  await expect(retireNodeDeploymentGeneration(agent, { ...args(), checkpoint: check })).rejects.toThrow('owner changed');
  expect(check).toHaveBeenCalledTimes(2);
});
