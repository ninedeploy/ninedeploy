import { z } from 'zod';

/** A rollback record survives a crash between saving a setting and proxy acknowledgement. */
export const proxySettingJournal = z.object({
  serverId: z.number().int().positive().nullable(),
  previous: z.object({ present: z.boolean(), value: z.json() }),
}).strict();
