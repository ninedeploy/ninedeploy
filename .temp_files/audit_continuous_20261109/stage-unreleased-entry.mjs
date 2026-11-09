import { execFileSync } from 'node:child_process';
const git = (args, input) => execFileSync('git', args, { encoding: 'utf8', input });
export function stageUnreleasedEntry(entry, moveIds = []) {
  if (!entry.startsWith('- ') || entry.includes('\n')) throw new Error('Expected one changelog bullet');
  const currentId = Number(/\(F(\d+)\)\.$/.exec(entry)?.[1]);
  if (!currentId) throw new Error('Finding id missing');
  let content = git(['show', 'HEAD:CHANGELOG.md']).replace(/\r\n/g, '\n');
  const selected = new Set([...moveIds, currentId]);
  const notes = new Map();
  content = content.split('\n').filter(line => {
    const id = Number(/^-.+\(F(\d+)\)\.$/.exec(line)?.[1]);
    if (!selected.has(id)) return true;
    notes.set(id, line); return false;
  }).join('\n');
  for (const id of moveIds) if (!notes.has(id)) throw new Error(`Missing owned historical bullet F${id}`);
  notes.set(currentId, entry);
  const header = '## [Unreleased]\n';
  const at = content.indexOf(header);
  if (at < 0) throw new Error('Unreleased heading missing');
  const begin = at + header.length;
  const next = content.indexOf('\n## [', begin);
  const end = next < 0 ? content.length : next;
  let body = content.slice(begin, end);
  const bullets = [...notes].sort((a,b) => b[0]-a[0]).map(([,line]) => line).join('\n');
  const anchor = '### Fixed\n\n';
  body = body.includes(anchor) ? body.replace(anchor, anchor + bullets + '\n')
    : (body.trim() ? body.trimEnd() + '\n\n' : '\n') + anchor + bullets + '\n';
  content = content.slice(0, begin) + body + content.slice(end);
  const hash = git(['hash-object', '-w', '--stdin'], content).trim();
  git(['update-index', '--cacheinfo', '100644', hash, 'CHANGELOG.md']);
  return hash;
}
