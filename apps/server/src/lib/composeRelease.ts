/** Resolved Compose models contain secrets. Persist only through releaseRecords. */
export interface ComposeRelease {
  version: 1;
  serviceId: number;
  slug: string;
  composeService: string;
  runtimeId: string;
  port: number | null;
  healthPath: string;
  model: Record<string, unknown>;
}

export const MAX_COMPOSE_RELEASE_BYTES = 1024 * 1024;
export const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Keep external file contents out of the promise of a reproducible release. */
function validateModel(model: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const pending: Array<[unknown, number]> = [[model, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (depth > 64) throw new Error('Compose release exceeds the supported nesting depth');
    if (Array.isArray(value) || object(value)) {
      for (const child of Object.values(value)) pending.push([child, depth + 1]);
    }
  }
  if (!object(model.services) || Object.keys(model.services).length === 0) throw new Error('Compose release has no services');
  if (Object.keys(model.services).length > 64) throw new Error('Compose release exceeds 64 services');
  for (const key of ['configs', 'secrets', 'include']) {
    if (model[key] && Object.keys(model[key] as object).length > 0) throw new Error('Compose release depends on external configuration files');
  }
  for (const value of Object.values(model.services)) {
    if (!object(value)) throw new Error('Invalid Compose service');
    for (const key of ['env_file', 'label_file', 'extends', 'develop', 'profiles', 'configs', 'secrets']) {
      if (value[key] && Object.keys(value[key] as object).length > 0) throw new Error('Compose release depends on external files or profiles');
    }
    if (value.volumes != null && (!Array.isArray(value.volumes) || value.volumes.some(v => !object(v) || v.type !== 'volume' || typeof v.source !== 'string' || !v.source))) {
      throw new Error('Compose release requires named volumes; bind and anonymous mounts are not recorded');
    }
    if (value.environment != null && (!object(value.environment) || Object.values(value.environment).some(v => typeof v !== 'string'))) {
      throw new Error('Compose release contains unresolved environment values');
    }
  }
  return model.services as Record<string, Record<string, unknown>>;
}

/** Pin the images actually used by every container, never a mutable tag. */
export function createComposeRelease(
  identity: Omit<ComposeRelease, 'version' | 'model'>,
  resolvedJson: string,
  images: Record<string, string>,
): ComposeRelease {
  if (Buffer.byteLength(resolvedJson) > MAX_COMPOSE_RELEASE_BYTES) throw new Error('Compose release exceeds 1 MiB');
  const model: unknown = JSON.parse(resolvedJson);
  if (!object(model)) throw new Error('Invalid Compose model');
  const definitions = validateModel(model);
  if (!Object.hasOwn(definitions, identity.composeService)) throw new Error('Compose routing service is absent');
  for (const [name, definition] of Object.entries(definitions)) {
    const image = images[name];
    if (!image || !IMAGE_ID.test(image)) throw new Error('Compose release is missing a container image');
    definition.image = image;
    definition.pull_policy = 'never';
    const deploy = definition.deploy;
    if (!definition.restart && !(object(deploy) && deploy.restart_policy)) definition.restart = 'unless-stopped';
    // Builds are artifacts now: no checkout, rebuild, watch or mutable tag on restore.
    delete definition.build;
  }
  const record: ComposeRelease = { ...identity, version: 1, model };
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_COMPOSE_RELEASE_BYTES) throw new Error('Compose release exceeds 1 MiB');
  return record;
}

export function parseComposeRelease(json: string): ComposeRelease {
  if (Buffer.byteLength(json) > MAX_COMPOSE_RELEASE_BYTES) throw new Error('Compose release exceeds 1 MiB');
  const r: unknown = JSON.parse(json);
  if (!object(r) || r.version !== 1 || !Number.isSafeInteger(r.serviceId) || (r.serviceId as number) < 1 ||
      typeof r.slug !== 'string' || !r.slug || typeof r.composeService !== 'string' || !r.composeService || typeof r.runtimeId !== 'string' || !r.runtimeId ||
      typeof r.healthPath !== 'string' || !(r.port === null || (Number.isInteger(r.port) && (r.port as number) > 0 && (r.port as number) <= 65535)) || !object(r.model)) {
    throw new Error('Invalid Compose release record');
  }
  const definitions = validateModel(r.model);
  if (!Object.hasOwn(definitions, r.composeService)) throw new Error('Compose routing service is absent');
  for (const d of Object.values(definitions)) {
    if (typeof d.image !== 'string' || !IMAGE_ID.test(d.image) || d.build != null || d.pull_policy !== 'never') throw new Error('Compose release image is not pinned');
  }
  return r as unknown as ComposeRelease;
}

/** `compose config` already escapes dollars for replay. Never escape twice. */
export function renderComposeRelease(record: ComposeRelease): string {
  return JSON.stringify(record.model);
}
