import { SLEEP_AFTER_MAX, SLEEP_AFTER_MIN } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, fmtTime, header, info, kv, spinner, success } from '../lib/format.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * 0.16.11 scale to zero:
 *
 *   ninedeploy sleep show <service> [--json]
 *   ninedeploy sleep set <service> <minutes>
 *   ninedeploy sleep off <service>
 *   ninedeploy sleep now <service>
 *   ninedeploy sleep wake <service>
 *
 * `<service>` is an id, a slug or a name. A sleeping service keeps its
 * containers, volumes and variables; the next request through one of its
 * domains (or `wake`, Start, Restart) starts it again.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** Skip the spinner for `--json` so stdout stays parseable. */
const load = <T>(json: boolean | undefined, msg: string, fn: () => Promise<T>): Promise<T> => (json ? fn() : spinner(msg, fn));

const REQUIREMENTS =
  'It needs traffic analytics on (Traefik → Traffic) and a routed domain: requests are counted from the traffic log, and a request through a domain wakes it.';

/** `<minutes>` as a whole number in the schema's range; null after printing why not. */
export function sleepMinutes(raw: string): number | null {
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || n < SLEEP_AFTER_MIN || n > SLEEP_AFTER_MAX) {
    error(`<minutes> must be a whole number from ${SLEEP_AFTER_MIN} to ${SLEEP_AFTER_MAX} (got "${plain(raw)}")`);
    return null;
  }
  return n;
}

/** The setting in words (the server keeps it at 5 minutes or more). */
export function sleepSetting(minutes: number | null | undefined): string {
  return minutes ? `sleeps after ${minutes} minutes without a request` : 'never sleeps';
}

/** `ninedeploy sleep show <service> [--json]` */
export async function sleepShow(client: NineDeployClient, ref: string, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const svc = await load(opts.json, 'Loading the service', () => client.services.get(id));
    const minutes = svc.sleepAfterMinutes ?? null;
    const asleepAt = svc.asleepAt ?? null;
    if (opts.json) {
      console.log(JSON.stringify({ sleepAfterMinutes: minutes, asleepAt }, null, 2));
      return;
    }
    header(`Scale to zero: ${plain(svc.name)}`);
    kv('When idle', minutes ? sleepSetting(minutes) : c.gray(sleepSetting(minutes)));
    kv('Now', asleepAt ? c.yellow('asleep') : 'awake');
    if (asleepAt) {
      kv('Went to sleep', fmtTime(asleepAt));
      console.log();
      info('The next request through one of its domains wakes it, or `ninedeploy sleep wake`.');
    }
    console.log();
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy sleep set <service> <minutes>` */
export async function sleepSet(client: NineDeployClient, ref: string, rawMinutes: string): Promise<void> {
  const minutes = sleepMinutes(rawMinutes);
  if (minutes === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const updated = await spinner('Saving', () => client.services.update(id, { sleepAfterMinutes: minutes }));
    success(`${plain(updated.name)} ${sleepSetting(updated.sleepAfterMinutes ?? minutes)}.`);
    info(REQUIREMENTS);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy sleep off <service>` */
export async function sleepOff(client: NineDeployClient, ref: string): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const updated = await spinner('Turning scale to zero off', () => client.services.update(id, { sleepAfterMinutes: null }));
    success(`${plain(updated.name)} never sleeps now.`);
    if (updated.asleepAt) info('It is asleep now: the next request through one of its domains wakes it, or `ninedeploy sleep wake`.');
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy sleep now <service>` */
export async function sleepNow(client: NineDeployClient, ref: string): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    await spinner('Putting the service to sleep', () => client.services.sleep(id));
    success(`${plain(ref)} is asleep. The next request through one of its domains wakes it.`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy sleep wake <service>` */
export async function sleepWake(client: NineDeployClient, ref: string): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const res = await spinner('Waking the service (it waits for the healthcheck)', () => client.services.wake(id));
    success(`${plain(ref)} is awake (${plain(res.status)}).`);
  } catch (err) {
    error(message(err));
  }
}
