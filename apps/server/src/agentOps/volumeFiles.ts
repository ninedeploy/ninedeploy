import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { volumeFileTool } from '../engine/volumeFileTools.js';
import { isManagedVolume } from './operands.js';
import type { AgentOpModule } from './index.js';

const input = z.object({ action: z.enum(['list', 'read', 'write', 'mkdir', 'delete']), volume: z.string().refine(isManagedVolume),
  path: z.string().max(2048).optional(), contentBase64: z.string().max(2 * 1024 * 1024).optional() }).strict();

export const volumeFileOps: AgentOpModule = {
  name: 'agentOps/volumeFiles.ts', caps: ['volume.files'],
  ops: { 'volume.fileTool': { cap: 'volume.files', sealedOnly: true,
    async run(params, sink) {
      const parsed = input.safeParse(params);
      if (!parsed.success) throw new Error('Invalid volume file operands');
      try {
        const { volume, action, ...operands } = parsed.data;
        const result = await volumeFileTool(volume, action, operands);
        const reply = JSON.stringify({ ok: true, result });
        if (Buffer.byteLength(reply) > 2 * 1024 * 1024) throw new HttpError(413, 'volume_reply_too_large', 'Volume result exceeds the supported limit');
        sink(reply); return 0;
      } catch (error) {
        sink(JSON.stringify({ ok: false, error: error instanceof HttpError ? { status: error.statusCode, code: error.code, message: error.message }
          : { status: 502, code: 'node_volume_tool_failed', message: 'Node volume operation could not be confirmed; no local fallback was attempted' } }));
        return 1;
      }
    },
  } },
};
