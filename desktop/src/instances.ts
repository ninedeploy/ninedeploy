import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeInstanceUrl } from './address.js';

export { normalizeInstanceUrl } from './address.js';

/** A NineDeploy panel the user chose to open. `origin` is the only address the window may show. */
export interface Instance {
  id: string;
  name: string;
  origin: string;
  /** Plain http to a host other than this machine: credentials cross the network unencrypted. */
  insecure: boolean;
  addedAt: string;
  lastOpenedAt?: string;
}

interface StoreFile {
  version: 1;
  instances: Instance[];
}

function isInstance(value: unknown): value is Instance {
  const v = value as Partial<Instance> | null;
  return (
    !!v &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.origin === 'string' &&
    typeof v.insecure === 'boolean' &&
    typeof v.addedAt === 'string' &&
    normalizeInstanceUrl(v.origin).ok
  );
}

/** Write through a temporary file so a crash mid-write never leaves half a JSON document. */
export function writeFileAtomic(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The instance list, kept as JSON in the app's user-data directory. It holds no credentials. */
export class InstanceStore {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Instance[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
    const instances = (parsed as Partial<StoreFile> | null)?.instances;
    return Array.isArray(instances) ? instances.filter(isInstance) : [];
  }

  get(id: string): Instance | undefined {
    return this.list().find((i) => i.id === id);
  }

  add(name: string, address: string): Instance {
    const normalized = normalizeInstanceUrl(address);
    if (!normalized.ok) throw new Error(normalized.reason);
    const list = this.list();
    if (list.some((i) => i.origin === normalized.origin)) throw new Error(`${normalized.origin} is already in the list.`);
    const label = name.trim().slice(0, 80) || new URL(normalized.origin).host;
    const instance: Instance = {
      id: randomUUID(),
      name: label,
      origin: normalized.origin,
      insecure: normalized.insecure,
      addedAt: this.now().toISOString(),
    };
    this.save([...list, instance]);
    return instance;
  }

  remove(id: string): Instance | undefined {
    const list = this.list();
    const gone = list.find((i) => i.id === id);
    if (gone) this.save(list.filter((i) => i.id !== id));
    return gone;
  }

  markOpened(id: string): void {
    const at = this.now().toISOString();
    this.save(this.list().map((i) => (i.id === id ? { ...i, lastOpenedAt: at } : i)));
  }

  private save(instances: Instance[]): void {
    const body: StoreFile = { version: 1, instances };
    writeFileAtomic(this.file, `${JSON.stringify(body, null, 2)}\n`);
  }
}
