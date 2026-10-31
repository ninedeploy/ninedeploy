import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { ciJobs, type DB, type services } from '@ninedeploy/db';
import { checkoutCommit, type CloneCreds } from './git.js';
import { resolveCloneCreds } from './sourceCreds.js';
import { extractSourceUpload, isUploadSourced } from './sourceUpload.js';

type Service = typeof services.$inferSelect;
type Job = typeof ciJobs.$inferSelect;

const SHA_RE = /^[0-9a-f]{40}$/i;

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += String(d).slice(0, 2000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

/**
 * The job's source as a tar.gz, checked out by the panel with the service's
 * own Git credential. The runner never sees the credential: `.git` is left
 * out of the archive (its config holds the tokenized remote). The commit is
 * pinned on the job by the first checkout, so a retried attempt builds the
 * same tree.
 */
export async function buildSourceArchive(db: DB, service: Service, job: Job): Promise<{ file: string; sha: string; cleanup: () => void }> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nd-ci-src-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const work = path.join(root, 'src');
    let sha: string;
    if (isUploadSourced(service)) {
      sha = (await extractSourceUpload(service.id, job.commitSha, work)).sha;
    } else {
      const creds: CloneCreds | undefined = service.previewFromFork === true ? undefined : await resolveCloneCreds(db, service);
      const pinned = job.commitSha ?? (job.ref && SHA_RE.test(job.ref) ? job.ref : undefined);
      const branch = job.ref && !SHA_RE.test(job.ref) ? job.ref : service.branch;
      sha = await checkoutCommit(service.repoUrl ?? '', branch, pinned, work, () => undefined, creds);
    }
    if (!job.commitSha) await db.update(ciJobs).set({ commitSha: sha }).where(eq(ciJobs.id, job.id));
    const file = path.join(root, 'source.tar.gz');
    await run('tar', ['-czf', file, '--exclude=./.git', '-C', work, '.'], root);
    return { file, sha, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
