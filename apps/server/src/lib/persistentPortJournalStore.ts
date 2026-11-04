import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPersistentPortHostAuthority, type PersistentPortHostContext } from './persistentPortHostAuthority.js';
import { persistentPortRules, type PersistentPortNftSpec } from './persistentPortNft.js';
import { assertPersistentPortJournal, type PersistentPortJournal } from './persistentPortPublication.js';

const MAX_JOURNAL_BYTES = 256 * 1024;
export interface PersistentPortJournalStore {
  context: PersistentPortHostContext;
  read(): PersistentPortJournal | null;
  /** Resolves only after file data, rename and directory metadata are synced.
   * An error can leave either version installed; callers must retain all
   * generations until they reconstruct and confirm the durable intent. */
  save(journal: PersistentPortJournal): void;
}

/** Scope one service's journal to the same non-stealable host lock used by
 * kernel mutators. No production activation switch is added here. All users
 * on one target host must choose the same private directory/lock namespace. */
export async function withPersistentPortJournalStore<T>(
  directory: string,
  input: PersistentPortNftSpec,
  operation: (store: PersistentPortJournalStore) => Promise<T>,
): Promise<T> {
  const desired = structuredClone(input);
  persistentPortRules(desired);
  return withPersistentPortHostAuthority(directory, async (context) => {
    const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let active = true;
    try {
      const originalDirectory = fstatSync(dirFd);
      const path = join(directory, `service-${desired.serviceId}.json`);
      const guard = () => {
        if (!active) throw new Error('Persistent port journal scope has ended');
        const current = lstatSync(directory);
        if (!current.isDirectory() || current.dev !== originalDirectory.dev || current.ino !== originalDirectory.ino) {
          throw new Error('Persistent port journal directory identity changed');
        }
      };
      const read = (): PersistentPortJournal | null => {
        guard();
        let fd: number;
        try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw new Error('Persistent port journal cannot be opened safely');
        }
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > MAX_JOURNAL_BYTES) {
            throw new Error('Unsafe persistent port journal file');
          }
          const buffer = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
          let count = 0;
          while (count < buffer.length) {
            const bytes = readSync(fd, buffer, count, buffer.length - count, count);
            if (bytes === 0) break;
            count += bytes;
          }
          if (count > MAX_JOURNAL_BYTES) throw new Error('Persistent port journal exceeds its size limit');
          let value: PersistentPortJournal;
          try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))) as PersistentPortJournal;
            assertPersistentPortJournal(value, desired);
          } catch { throw new Error('Invalid persistent port journal contents'); }
          return value;
        } finally { closeSync(fd); }
      };
      const save = (inputJournal: PersistentPortJournal) => {
        guard();
        const journal = structuredClone(inputJournal);
        assertPersistentPortJournal(journal, desired);
        const bytes = Buffer.from(`${JSON.stringify(journal)}\n`);
        if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('Persistent port journal exceeds its size limit');
        // Refuse an existing foreign, malformed, aliased or permissive file.
        // All legitimate writers are fenced by the same host authority.
        read();
        const temporary = join(directory, `.service-${desired.serviceId}-${randomUUID()}.tmp`);
        let fd: number | undefined;
        let created = false;
        try {
          fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          created = true;
          writeFileSync(fd, bytes);
          fsyncSync(fd);
          const writtenFd = fd; fd = undefined; closeSync(writtenFd);
          guard();
          renameSync(temporary, path);
          created = false;
          fsyncSync(dirFd);
        } finally {
          if (fd !== undefined) closeSync(fd);
          // Only this invocation's exclusive nonce path is eligible for removal.
          if (created) {
            try { guard(); unlinkSync(temporary); }
            catch { /* Leave an uncertain private orphan for owned recovery. */ }
          }
        }
      };
      return await operation({ context, read, save });
    } finally { active = false; closeSync(dirFd); }
  });
}
