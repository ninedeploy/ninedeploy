/**
 * `ninedeploy templates community {list,import,remove}` —
 * G-13 community template contribution.
 *
 * The CLI is a thin renderer around
 * `client.templates.community.{list,import,remove}`. The
 * import command accepts `-` to read from stdin so a
 * `curl -s https://.../template.json | ninedeploy
 * templates community import -` pipeline lands the
 * upstream contribution without writing it to disk
 * first.
 */
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, spinner, success, table } from '../lib/format.js';
import { readFile } from 'node:fs/promises';

export async function communityTemplatesList(client: NineDeployClient): Promise<void> {
  const res = await spinner('Reading community catalog', () => client.templates.community.list());
  header('Community templates');
  info(`Entries:    ${res.entries.length}`);
  info(`Total size: ${res.totalBytes} bytes`);
  if (res.entries.length === 0) {
    info('(no community templates)');
  } else {
    console.log();
    table(
      res.entries.map((e) => ({
        id: e.id,
        name: e.template.name,
        category: e.template.category,
        bytes: e.bytes,
      })),
      ['id', 'name', 'category', 'bytes'],
    );
  }
  if (res.errors.length > 0) {
    console.log();
    info(c.yellow(`Parse errors: ${res.errors.length}`));
    for (const err of res.errors) {
      console.log(`  ${c.red('✗')} ${err.file}: ${err.error}`);
    }
  }
}

/**
 * `ninedeploy templates community import <file>` — the
 * path can be `-` for stdin, in which case the CLI
 * reads until EOF.
 */
export async function communityTemplatesImport(
  client: NineDeployClient,
  path: string,
  opts: { replace?: boolean } = {},
): Promise<void> {
  if (!path) {
    error('Usage: ninedeploy templates community import <file> [- | path.json]');
    return;
  }
  let content: string;
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    content = Buffer.concat(chunks).toString('utf8');
  } else {
    try {
      content = await readFile(path, 'utf8');
    } catch (err) {
      error(`Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
  try {
    const res = await spinner('Validating + importing', () =>
      client.templates.community.import(content, { replace: opts.replace }),
    );
    success(`Imported ${res.id} (${res.bytes} bytes, file: ${res.file}).`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
}

export async function communityTemplatesRemove(client: NineDeployClient, idStr: string): Promise<void> {
  if (!idStr) {
    error('Usage: ninedeploy templates community remove <id>');
    return;
  }
  try {
    const res = await spinner('Removing', () => client.templates.community.remove(idStr));
    if (!res.removed) {
      error(`Community template "${idStr}" not found.`);
      return;
    }
    success(`Removed ${idStr}.`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
  }
}
