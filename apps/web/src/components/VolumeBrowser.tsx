import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileImage,
  FilePlus2,
  FileText,
  FolderPlus,
  Folder,
  HardDrive,
  Lock,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from './Toast.js';
import { Button, Card, Skeleton, cn } from './ui.js';
import { formatBytes } from '../lib/format.js';

export type FileCategory = 'text' | 'image' | 'binary';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'env',
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'vue', 'svelte',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'cs', 'sql',
  'dockerfile', 'gitignore', 'npmrc', 'editorconfig', 'lock', 'prisma', 'graphql', 'proto',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg']);

const BINARY_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'iso',
  'db', 'sqlite', 'sqlite3', 'rdb', 'dump', 'parquet', 'arrow',
  'bin', 'exe', 'dll', 'so', 'dylib', 'wasm', 'pyc', 'class', 'jar', 'node',
  'pdf', 'mp4', 'mp3', 'mov', 'wav', 'ogg', 'avi', 'mkv', 'flac', 'webm',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
]);

export function getFileCategory(filename: string): FileCategory {
  const lower = filename.toLowerCase();
  const base = lower.split('/').pop()!;

  if (base === 'dockerfile' || base === 'makefile' || base === 'procfile' || base === 'license' || base === 'readme') {
    return 'text';
  }
  if (base.startsWith('.env')) return 'text';

  const parts = base.split('.');
  if (parts.length < 2) {
    return 'text';
  }
  const ext = parts.pop()!;
  if (ext === 'gz' && parts.length > 0 && parts[parts.length - 1] === 'tar') {
    return 'binary';
  }
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';

  return 'text';
}

function getFileIcon(name: string, type: 'file' | 'dir') {
  if (type === 'dir') return <Folder size={15} className="shrink-0 text-amber-400/80" />;
  const category = getFileCategory(name);
  if (category === 'image') return <FileImage size={15} className="shrink-0 text-emerald-400/80" />;
  if (category === 'binary') return <Lock size={15} className="shrink-0 text-amber-400/80" />;
  return <FileText size={15} className="shrink-0 text-slate-500" />;
}

function downloadBase64File(filename: string, base64: string, category: FileCategory) {
  const name = filename.split('/').pop()!;
  const mime = category === 'image'
    ? (name.endsWith('.svg') ? 'image/svg+xml' : 'image/png')
    : 'application/octet-stream';

  const a = document.createElement('a');
  a.href = `data:${mime};base64,${base64}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

interface OpenFileState {
  path: string;
  category: FileCategory;
  text: string;
  base64: string;
  dirty: boolean;
}

/**
 * File manager for a single Docker volume: directory listing with breadcrumb
 * navigation, extension-aware safe viewing/editing, image preview, binary
 * protection, and mkdir/save/delete actions.
 */
export function VolumeBrowser({ volume, onClose }: { volume: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cwd, setCwd] = useState('');
  const [editing, setEditing] = useState<OpenFileState | null>(null);

  const dir = useQuery({
    queryKey: ['volume-files', volume, cwd],
    queryFn: () => api.volumes.listFiles(volume, cwd),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['volume-files', volume] });
  };

  const del = useMutation({
    mutationFn: (path: string) => api.volumes.deleteFile(volume, path),
    onSuccess: (_r, path) => {
      setEditing(null);
      refresh();
      toast(`Deleted ${path.split('/').pop()}`, 'success');
    },
    onError: () => toast('Delete failed', 'error'),
  });

  const mkdir = useMutation({
    mutationFn: (path: string) => api.volumes.mkdir(volume, { path }),
    onSuccess: () => {
      refresh();
      toast('Folder created', 'success');
    },
    onError: () => toast('Could not create the folder', 'error'),
  });

  const open = useMutation({
    mutationFn: (path: string) => api.volumes.readFile(volume, path),
    onSuccess: (res, path) => {
      const category = getFileCategory(path);
      let text = '';
      if (category === 'text') {
        text =
          res.encoding === 'base64'
            ? new TextDecoder().decode(Uint8Array.from(atob(res.content), (c) => c.charCodeAt(0)))
            : res.content;
      }
      setEditing({
        path,
        category,
        text,
        base64: res.content,
        dirty: false,
      });
    },
    onError: () => toast('Could not read the file (binary or >1 MB?)', 'error'),
  });

  // r251: the save carries the exact (path, text) it writes, and only marks
  // the editor clean if it still shows that content. Writing back the
  // click-time snapshot discarded whatever was typed while the save was in
  // flight, and re-opened the old file if the user had moved on to another.
  const save = useMutation({
    mutationFn: (v: { path: string; text: string }) =>
      api.volumes.writeFile(volume, {
        path: v.path,
        contentBase64: btoa(unescape(encodeURIComponent(v.text))),
      }),
    onSuccess: (_res, v) => {
      setEditing((cur) => (cur && cur.path === v.path && cur.text === v.text ? { ...cur, dirty: false } : cur));
      refresh();
      toast('Saved', 'success');
    },
    onError: () => toast('Save failed', 'error'),
  });

  const crumbs = cwd ? cwd.split('/') : [];
  const entriesEmpty = (dir.data?.entries ?? []).length === 0;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };
  const backdropProps = {
    onClick: onClose,
    onKeyDown,
    role: 'presentation' as const,
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" {...backdropProps}>
      <div
        role="dialog"
        aria-label={`Files in ${volume}`}
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
          <HardDrive size={15} className="text-amber-400" />
          <span className="truncate font-mono text-xs text-slate-300">{volume}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {editing ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                  <ArrowLeft size={13} /> Back
                </Button>
                {editing.category === 'text' ? (
                  <Button size="sm" onClick={() => save.mutate({ path: editing.path, text: editing.text })} disabled={save.isPending || !editing.dirty}>
                    <Save size={13} /> {save.isPending ? 'Saving…' : editing.dirty ? 'Save' : 'Saved'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => downloadBase64File(editing.path, editing.base64, editing.category)}
                  >
                    <Download size={13} /> Download
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const name = prompt('New folder name');
                    if (name) mkdir.mutate(cwd ? `${cwd}/${name}` : name);
                  }}
                >
                  <FolderPlus size={13} /> Folder
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const name = prompt('New file name');
                    if (!name) return;
                    const path = cwd ? `${cwd}/${name}` : name;
                    setEditing({ path, category: 'text', text: '', base64: '', dirty: true });
                  }}
                >
                  <FilePlus2 size={13} /> File
                </Button>
                <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/5 active:scale-[0.98]">
                  <Upload size={13} /> Upload
                  <input
                    type="file"
                    className="hidden"
                    aria-label="Upload file to volume"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        const res = String(reader.result ?? '');
                        const base64 = res.split(',')[1] || '';
                        const path = cwd ? `${cwd}/${file.name}` : file.name;
                        api.volumes.writeFile(volume, { path, contentBase64: base64 }).then(() => {
                          refresh();
                          toast(`Uploaded ${file.name}`, 'success');
                        }).catch(() => toast('Upload failed', 'error'));
                      };
                      reader.readAsDataURL(file);
                    }}
                  />
                </label>
                <Button size="sm" variant="secondary" onClick={refresh} disabled={dir.isFetching}>
                  <RefreshCw size={13} className={dir.isFetching ? 'animate-spin' : undefined} />
                </Button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-200"
              aria-label="Close volume browser"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* breadcrumb */}
        {!editing && (
          <div className="flex items-center gap-1 border-b border-white/[0.06] px-4 py-2 font-mono text-xs">
            <button type="button" onClick={() => setCwd('')} className="text-slate-400 hover:text-slate-200">
              /
            </button>
            {crumbs.map((c, i) => (
              <span key={crumbs.slice(0, i + 1).join('/')} className="flex items-center gap-1">
                <ChevronRight size={11} className="text-slate-600" />
                <button
                  type="button"
                  onClick={() => setCwd(crumbs.slice(0, i + 1).join('/'))}
                  className={cn(i === crumbs.length - 1 ? 'text-slate-200' : 'text-slate-400 hover:text-slate-200')}
                >
                  {c}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* body */}
        {editing ? (
          editing.category === 'text' ? (
            <textarea
              value={editing.text}
              spellCheck={false}
              onChange={(e) => setEditing({ ...editing, text: e.target.value, dirty: true })}
              className="flex-1 resize-none bg-transparent p-4 font-mono text-xs leading-relaxed text-slate-200 outline-none"
              aria-label="File editor"
            />
          ) : editing.category === 'image' ? (
            <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
              <div className="relative flex max-h-[50vh] max-w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40 p-4">
                <img
                  src={`data:${editing.path.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${editing.base64}`}
                  alt={editing.path.split('/').pop()}
                  className="max-h-[45vh] max-w-full rounded object-contain shadow-2xl"
                />
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
                <FileImage size={14} className="text-emerald-400" />
                <span className="font-mono text-slate-200">{editing.path.split('/').pop()}</span>
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">Image Preview · Read-only</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <Card className="max-w-md p-6 text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/20">
                  <Lock size={22} />
                </div>
                <h3 className="mt-3 font-mono text-sm font-semibold text-slate-100">{editing.path.split('/').pop()}</h3>
                <p className="mt-1 text-xs text-slate-400">
                  This file is recognized as a binary / archive or compiled asset.
                </p>
                <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-300/90">
                  Direct text editing is disabled to protect against data corruption. You can download the raw binary file to your computer.
                </div>
                <div className="mt-4 flex justify-center">
                  <Button
                    size="sm"
                    onClick={() => downloadBase64File(editing.path, editing.base64, 'binary')}
                  >
                    <Download size={13} /> Download File
                  </Button>
                </div>
              </Card>
            </div>
          )
        ) : dir.isLoading ? (
          <div className="flex-1 space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : dir.isError ? (
          <div className="grid flex-1 place-items-center text-sm text-slate-500">Couldn't open the volume.</div>
        ) : entriesEmpty ? (
          <div className="grid flex-1 place-items-center text-sm text-slate-500">Empty directory</div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2">
            {dir.data!.entries.map((e) => {
              const full = cwd ? `${cwd}/${e.name}` : e.name;
              return (
                <div key={e.name} className="group flex items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-white/[0.03]">
                  {e.type === 'dir' ? (
                    <button type="button" onClick={() => setCwd(full)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                      {getFileIcon(e.name, 'dir')}
                      <span className="truncate text-sm text-slate-200">{e.name}</span>
                      <ChevronRight size={12} className="shrink-0 text-slate-600" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => open.mutate(full)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      disabled={open.isPending}
                    >
                      {getFileIcon(e.name, 'file')}
                      <span className="truncate text-sm text-slate-300 group-hover:text-slate-100">{e.name}</span>
                      {getFileCategory(e.name) === 'binary' && (
                        <span className="rounded bg-white/5 px-1 py-0.2 font-mono text-[9px] text-slate-500">bin</span>
                      )}
                      {getFileCategory(e.name) === 'image' && (
                        <span className="rounded bg-emerald-500/10 px-1 py-0.2 font-mono text-[9px] text-emerald-400">img</span>
                      )}
                    </button>
                  )}
                  <span className="shrink-0 font-mono text-[10px] text-slate-600">
                    {e.type === 'file' ? formatBytes(e.sizeBytes) : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete ${e.name}?${e.type === 'dir' ? ' (folder and everything in it)' : ''}`)) {
                        del.mutate(full);
                      }
                    }}
                    className="shrink-0 text-slate-700 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
                    aria-label={`Delete ${e.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
