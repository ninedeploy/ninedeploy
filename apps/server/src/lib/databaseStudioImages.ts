import { isRedisFamily } from './databaseCommands.js';

/** The pinned Redis Commander uses node-config, not REDIS_URL. JSON keeps
 * delimiters in credentials intact and avoids entrypoint password arguments. */
export function redisStudioConfig(host: string, port: number, password: string, label: string): string {
  return JSON.stringify({ noSave: true, noLogData: true, connections: [{ label, host, port, dbIndex: 0, username: 'default', password }] });
}

/** Keep panel and node Studios on the same versioned/digest-pinned images. */
export function studioImageForEngine(engine: string): { image: string; containerPort: number } {
  if (isRedisFamily(engine)) return {
    image: 'rediscommander/redis-commander@sha256:19cd0c49f418779fa2822a0496c5e6516d0c792effc39ed20089e6268477e40a',
    containerPort: 8081,
  };
  return { image: 'adminer:6.0.1', containerPort: 8080 };
}
