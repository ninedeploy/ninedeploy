import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ node: vi.fn(), capability: vi.fn(), agent: vi.fn() }));
vi.mock('../../src/lib/agentCapabilities.js', () => ({ assertNodeCapability: h.capability }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agent }));
const { nodeContainerTool } = await import('../../src/lib/nodeContainerTools.js');
const { HttpError } = await import('../../src/lib/errors.js');
const db = { query: { servers: { findFirst: h.node } } } as never;
beforeEach(() => {
  h.node.mockReset().mockResolvedValue({ id: 7 }); h.capability.mockReset().mockResolvedValue(undefined);
  h.agent.mockReset().mockResolvedValue({ exitCode: 0, lines: [JSON.stringify({ ok: true, result: { content: 'eA==', encoding: 'base64' } })] });
});
describe('explicit-host node container transport', () => {
  it('negotiates sealed capability and reads only through the selected node', async () => {
    expect(await nodeContainerTool(db, 7, 'same-name', 'read', { path: '/tmp/file' })).toEqual({ content: 'eA==', encoding: 'base64' });
    expect(h.capability).toHaveBeenCalledWith(db, 7, expect.objectContaining({ cap: 'docker.containerTools', sealedRequired: true }));
    expect(h.agent).toHaveBeenCalledWith(db, 7, 'docker.containerTool', { action: 'read', container: 'same-name', path: '/tmp/file' }, expect.any(Function), { tolerateExit: true });
  });
  it('does not contact a missing node', async () => {
    h.node.mockResolvedValue(undefined); await expect(nodeContainerTool(db, 7, 'same-name', 'read')).rejects.toMatchObject({ statusCode: 404 });
    expect(h.capability).not.toHaveBeenCalled(); expect(h.agent).not.toHaveBeenCalled();
  });
  it('preserves an old/unsealed agent refusal without sending a container operation', async () => {
    h.capability.mockRejectedValue(new HttpError(422, 'node_agent_outdated', 'Update the agent'));
    await expect(nodeContainerTool(db, 7, 'same-name', 'read')).rejects.toMatchObject({ code: 'node_agent_outdated' }); expect(h.agent).not.toHaveBeenCalled();
  });
  it.each([
    { exitCode: 0, lines: [] }, { exitCode: 0, lines: ['{}', '{}'] }, { exitCode: 0, lines: ['bad JSON'] },
    { exitCode: 0, lines: ['null'] }, { exitCode: 0, lines: ['{}'] },
    { exitCode: 1, lines: ['{"ok":true,"result":{}}'] },
    { exitCode: 0, lines: ['{"ok":true,"result":{"content":"invalid!","encoding":"base64"}}'] },
    { exitCode: 0, lines: ['{"ok":true,"result":{"content":"text","encoding":"utf8"}}'] },
  ])('refuses ambiguous or invalid node output without usable file content: %j', async response => {
    h.agent.mockResolvedValue(response); await expect(nodeContainerTool(db, 7, 'same-name', 'read')).rejects.toMatchObject({ code: 'node_container_unconfirmed', statusCode: 502 });
  });
  it('preserves the node oversized-file refusal instead of returning a partial file', async () => {
    h.agent.mockResolvedValue({ exitCode: 1, lines: [JSON.stringify({ ok: false, error: { status: 413, code: 'file_too_large', message: 'File exceeds editor limit' } })] });
    await expect(nodeContainerTool(db, 7, 'same-name', 'read')).rejects.toMatchObject({ statusCode: 413, code: 'file_too_large' });
  });
  it('does not expose raw transport errors', async () => {
    h.agent.mockRejectedValue(Error('fixture-secret-in-transport'));
    await expect(nodeContainerTool(db, 7, 'same-name', 'read')).rejects.toThrow('no local fallback');
  });
  it('rejects malformed inspect data instead of displaying a fabricated empty runtime', async () => {
    h.agent.mockResolvedValue({ exitCode: 0, lines: ['{"ok":true,"result":{"id":"not-an-immutable-id"}}'] });
    await expect(nodeContainerTool(db, 7, 'same-name', 'inspect')).rejects.toMatchObject({ statusCode: 502 });
  });
});
