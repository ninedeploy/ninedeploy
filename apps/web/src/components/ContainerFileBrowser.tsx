import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Box,
  ChevronRight,
  Download,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Lock,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Button, Card, ErrorCard, Input, Skeleton, cn } from './ui.js';
import { getFileCategory, type FileCategory } from './VolumeBrowser.js';

function downloadBase64(filename: string, base64: string, category: FileCategory) {
  const name = filename.split('/').pop()!;
  const mime =
    category === 'image'
      ? name.endsWith('.svg')
        ? 'image/svg+xml'
        : 'image/png'
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

interface ContainerFileBrowserProps {
  container: string;
  initialPath?: string;
  serverId?: number | null;
}

export function ContainerFileBrowser(props: ContainerFileBrowserProps) {
  return <ContainerFileBrowserState key={`${props.serverId ?? 'local'}:${props.container}`} {...props} />;
}

function ContainerFileBrowserState({
  container,
  initialPath = '/',
  serverId,
}: ContainerFileBrowserProps) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cwd, setCwd] = useState(initialPath.startsWith('/') ? initialPath : `/${initialPath}`);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<OpenFileState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const hostOptions: [] | [{ serverId: number }] = serverId == null ? [] : [{ serverId }];

  const dir = useQuery({
    queryKey: ['container-files', serverId ?? null, container, cwd],
    queryFn: () => api.containers.listFiles(container, cwd, ...hostOptions),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['container-files', serverId ?? null, container] });
  };

  const del = useMutation({
    mutationFn: (path: string) => api.containers.deleteFile(container, path, ...hostOptions),
    onSuccess: (_r, path) => {
      setEditing(null);
      refresh();
      toast(t('Deleted {name}', { name: path.split('/').pop() ?? '' }), 'success');
    },
    onError: () => toast(t('Delete failed'), 'error'),
  });

  const mkdir = useMutation({
    mutationFn: (path: string) => api.containers.mkdir(container, { path }, ...hostOptions),
    onSuccess: () => {
      refresh();
      toast(t('Folder created'), 'success');
    },
    onError: () => toast(t('Could not create folder'), 'error'),
  });

  const open = useMutation({
    mutationFn: (path: string) => api.containers.readFile(container, path, ...hostOptions),
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
    onError: () => toast(t('Could not read file (binary or >1 MB)'), 'error'),
  });

  // r251: the save carries the exact (path, text) it writes, and only marks
  // the editor clean if it still shows that content. Writing back the
  // click-time snapshot discarded whatever was typed while the save was in
  // flight, and re-opened the old file if the user had moved on to another.
  const save = useMutation({
    mutationFn: (v: { path: string; text: string }) =>
      api.containers.writeFile(container, {
        path: v.path,
        contentBase64: btoa(unescape(encodeURIComponent(v.text))),
      }, ...hostOptions),
    onSuccess: (_res, v) => {
      setEditing((cur) => (cur && cur.path === v.path && cur.text === v.text ? { ...cur, dirty: false } : cur));
      refresh();
      toast(t('File saved'), 'success');
    },
    onError: () => toast(t('Save failed'), 'error'),
  });

  const handleUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result ?? '');
      const base64 = res.split(',')[1] || '';
      const fullPath = cwd === '/' ? `/${file.name}` : `${cwd}/${file.name}`;
      api.containers
        .writeFile(container, { path: fullPath, contentBase64: base64 }, ...hostOptions)
        .then(() => {
          refresh();
          toast(t('Uploaded {name}', { name: file.name }), 'success');
        })
        .catch(() => toast(t('Upload failed'), 'error'));
    };
    reader.readAsDataURL(file);
  };

  const segments = cwd.split('/').filter(Boolean);
  const entries = (dir.data?.entries ?? []).filter((e) =>
    query ? e.name.toLowerCase().includes(query.toLowerCase()) : true,
  );

  return (
    <Card className="flex min-h-[560px] flex-col overflow-hidden border-white/10 bg-slate-950/80">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] bg-slate-900/40 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
          <Box size={14} className="text-indigo-400" />
          <span className="font-semibold text-slate-200">{container}</span>
          {serverId != null && <span className="text-slate-400">{t('Node #{id}', { id: serverId })}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                <ArrowLeft size={13} /> {t('Back')}
              </Button>
              {editing.category === 'text' ? (
                <Button size="sm" onClick={() => save.mutate({ path: editing.path, text: editing.text })} disabled={save.isPending || !editing.dirty}>
                  <Save size={13} /> {save.isPending ? t('Saving…') : editing.dirty ? t('Save') : t('Saved')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => downloadBase64(editing.path, editing.base64, editing.category)}
                >
                  <Download size={13} /> {t('Download')}
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('Filter files…')}
                  className="h-8 w-44 pl-8 font-mono text-xs"
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const name = prompt(t('New folder name'));
                  if (name) mkdir.mutate(cwd === '/' ? `/${name}` : `${cwd}/${name}`);
                }}
              >
                <FolderPlus size={13} /> {t('Folder')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const name = prompt(t('New file name'));
                  if (!name) return;
                  const path = cwd === '/' ? `/${name}` : `${cwd}/${name}`;
                  setEditing({ path, category: 'text', text: '', base64: '', dirty: true });
                }}
              >
                <FilePlus2 size={13} /> {t('File')}
              </Button>
              <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/5 active:scale-[0.98]">
                <Upload size={13} /> {t('Upload')}
                <input
                  type="file"
                  className="hidden"
                  aria-label={t('Upload file to container')}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleUpload(file);
                  }}
                />
              </label>
              <Button size="sm" variant="secondary" onClick={refresh} disabled={dir.isFetching} title={t('Refresh directory')}>
                <RefreshCw size={13} className={dir.isFetching ? 'animate-spin' : undefined} />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Breadcrumb path bar */}
      {!editing && (
        <div className="flex items-center gap-1.5 border-b border-white/[0.06] bg-slate-950/40 px-4 py-2 font-mono text-xs text-slate-400">
          <button
            type="button"
            onClick={() => setCwd('/')}
            className={cn('hover:text-slate-200', cwd === '/' ? 'text-indigo-400 font-semibold' : '')}
          >
            /
          </button>
          {segments.map((seg, i) => {
            const targetPath = `/${segments.slice(0, i + 1).join('/')}`;
            const isLast = i === segments.length - 1;
            return (
              <span key={targetPath} className="flex items-center gap-1.5">
                <ChevronRight size={11} className="text-slate-600" />
                <button
                  type="button"
                  onClick={() => setCwd(targetPath)}
                  className={cn(isLast ? 'text-slate-200 font-semibold' : 'text-slate-400 hover:text-slate-200')}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Content Area with Drag and Drop Support */}
      <div
        data-testid="container-dropzone"
        className={cn('flex flex-1 flex-col transition-colors', dragOver ? 'bg-indigo-950/20 ring-2 ring-indigo-500/50' : '')}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleUpload(file);
        }}
      >
        {editing ? (
          editing.category === 'text' ? (
            <div className="flex flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-white/5 bg-slate-900/30 px-4 py-1.5 font-mono text-[11px] text-slate-400">
                <span>{editing.path}</span>
                <span>{t('{n} lines · UTF-8', { n: editing.text.split('\n').length })}</span>
              </div>
              <textarea
                value={editing.text}
                spellCheck={false}
                onChange={(e) => setEditing({ ...editing, text: e.target.value, dirty: true })}
                className="flex-1 resize-none bg-slate-950/90 p-4 font-mono text-xs leading-relaxed text-slate-200 outline-none"
                aria-label={t('Container file editor')}
              />
            </div>
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
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">{t('Image Preview · Read-only')}</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <Card className="max-w-md p-6 text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/20">
                  <Lock size={22} />
                </div>
                <h3 className="mt-3 font-mono text-sm font-semibold text-slate-100">{editing.path.split('/').pop()}</h3>
                <p className="mt-1 text-xs text-slate-400">{t('Binary or compiled asset file')}</p>
                <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-300/90">
                  {t('Direct text editing is disabled to protect against binary corruption. Download the raw file below.')}
                </div>
                <div className="mt-4 flex justify-center">
                  <Button size="sm" onClick={() => downloadBase64(editing.path, editing.base64, 'binary')}>
                    <Download size={13} /> {t('Download File')}
                  </Button>
                </div>
              </Card>
            </div>
          )
        ) : dir.isLoading ? (
          <div className="flex-1 space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : dir.isError ? (
          <ErrorCard title={t('Could not load container files')} error={dir.error} onRetry={() => void dir.refetch()} />
        ) : entries.length === 0 ? (
          <div className="grid flex-1 place-items-center text-sm text-slate-500">
            {query ? t('No matching files found') : t('Empty directory (drop files here to upload)')}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2">
            {entries.map((e) => {
              const full = cwd === '/' ? `/${e.name}` : `${cwd}/${e.name}`;
              return (
                <div key={e.name} className="group flex items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-white/[0.03]">
                  {e.type === 'dir' ? (
                    <button
                      type="button"
                      onClick={() => setCwd(full)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <Folder size={15} className="shrink-0 text-amber-400/80" />
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
                      {getFileCategory(e.name) === 'image' ? (
                        <FileImage size={15} className="shrink-0 text-emerald-400/80" />
                      ) : getFileCategory(e.name) === 'binary' ? (
                        <Lock size={15} className="shrink-0 text-amber-400/80" />
                      ) : (
                        <FileText size={15} className="shrink-0 text-slate-500" />
                      )}
                      <span className="truncate text-sm text-slate-300 group-hover:text-slate-100">{e.name}</span>
                    </button>
                  )}

                  {e.mode && (
                    <span className="shrink-0 font-mono text-[10px] text-slate-600 bg-white/5 px-1.5 py-0.5 rounded">
                      {e.mode}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[10px] text-slate-600">
                    {e.type === 'file' ? formatBytes(e.sizeBytes) : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(e.type === 'dir' ? t('Delete {name}? (folder and contents)', { name: e.name }) : t('Delete {name}?', { name: e.name }))) {
                        del.mutate(full);
                      }
                    }}
                    className="shrink-0 text-slate-700 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
                    aria-label={t('Delete {name}', { name: e.name })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
