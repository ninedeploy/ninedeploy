import { z } from 'zod';
import { HttpError } from './errors.js';

export const DATABASE_CLIENT_ENGINES = ['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'keydb', 'dragonfly'] as const;
const text = z.string().max(1024).refine(value => !value.includes('\0'), 'Invalid database client operand');
/** Internal sealed operand only; never persist, log, or accept caller argv/env. */
export const databaseClientInput = z.object({
  engine: z.enum(DATABASE_CLIENT_ENGINES),
  username: text.min(1),
  database: text.min(1),
  password: text,
}).strict();
export type DatabaseClientInput = z.infer<typeof databaseClientInput>;
export function databaseClientCommand(input: { engine: string; username: string; database: string; password: string }): { cmd: string[]; env: string[] } {
  switch (input.engine) {
    case 'postgres': return {cmd:['psql','-U',input.username,'-d',input.database],env:[`PGPASSWORD=${input.password}`]};
    case 'mysql': case 'mariadb': return {cmd:[input.engine,'-uroot'],env:[`MYSQL_PWD=${input.password}`]};
    case 'redis': case 'dragonfly': return {cmd:['redis-cli'],env:[`REDISCLI_AUTH=${input.password}`]};
    case 'valkey': return {cmd:['valkey-cli'],env:[`REDISCLI_AUTH=${input.password}`,`VALKEYCLI_AUTH=${input.password}`]};
    case 'keydb': return {cmd:['keydb-cli'],env:[`REDISCLI_AUTH=${input.password}`]};
    default: throw new HttpError(422,'client_mode_unsupported',`No interactive client for ${input.engine}: open a shell (mode "shell") instead.`);
  }
}

/** Memory-only pending terminal material; never serialize into history/audit. */
export interface PreparedDatabaseClient { databaseId: number; containerId: string; input: DatabaseClientInput }
