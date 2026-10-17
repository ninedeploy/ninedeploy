import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive, Upload } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/format.js';
import { useToast } from './Toast.js';
import { Button, Card, CardBody, Field, Input, Modal, Skeleton } from './ui.js';

/** The panel's limit for one upload (POST /v1/services/:id/source). */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Why a picked file cannot be uploaded, or null. */
export function archiveProblem(file: { name: string; size: number }): string | null {
  if (!/\.(zip|tar\.gz|tgz)$/i.test(file.name)) return 'Pick a .zip or a .tar.gz archive.';
  if (file.size > UPLOAD_MAX_BYTES) return `The archive is ${(file.size / 1024 / 1024).toFixed(1)} MiB; the limit is 100 MiB. Leave node_modules and build output out.`;
  if (file.size === 0) return 'The file is empty.';
  return null;
}

async function bytesOf(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

const CLI_HINT = 'ninedeploy deploy up ./my-app --create my-app';

/**
 * 0.16.1 "Upload source" from the New resource page: name the service, pick a
 * .zip / .tar.gz, and the panel creates a docker service without a repository,
 * stores the archive and deploys it (auto build pack: a Dockerfile wins,
 * otherwise Nixpacks).
 */
export function UploadSourceModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const problem = file ? archiveProblem(file) : null;

  const go = useMutation({
    mutationFn: async () => {
      const portNum = port.trim() ? Number(port) : undefined;
      const svc = await api.services.create({ name: name.trim(), type: 'docker', ...(portNum ? { port: portNum } : {}) });
      try {
        await api.services.uploadSource(svc.id, await bytesOf(file!));
      } catch (err) {
        // The service exists; say so, so a retry uploads to it instead of making another.
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { serviceId: svc.id });
      }
      return svc;
    },
    onSuccess: (svc) => {
      toast(`${svc.name} created — deploying your upload`, 'success');
      onClose();
      navigate(`/services/${svc.id}`);
    },
    onError: (err: Error & { serviceId?: number }) => {
      toast(
        err.serviceId != null ? `Service created, but the upload failed: ${err.message}` : err.message || 'Could not create the service',
        'error',
      );
      if (err.serviceId != null) {
        onClose();
        navigate(`/services/${err.serviceId}`);
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && file && !problem) go.mutate();
  };
  const portBad = port.trim() !== '' && !(Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535);

  return (
    <Modal title="Upload source" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs leading-relaxed text-slate-400">
          Deploy a folder without a Git repository: zip it (or make a .tar.gz) and upload it. A Dockerfile in it is used;
          otherwise Nixpacks detects the stack. Upload a new version any time from the service&apos;s Deploys tab.
        </p>
        <Field label="Service name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" maxLength={100} />
        </Field>
        <Field label="Archive" hint=".zip or .tar.gz, up to 100 MiB. A single top-level folder becomes the root." error={problem ?? undefined}>
          <Input type="file" accept=".zip,.tar.gz,.tgz,application/zip,application/gzip" aria-label="Archive" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Container port" hint="Optional. Nixpacks apps default to 3000." error={portBad ? 'Not a port number.' : undefined}>
          <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="3000" className="font-mono" />
        </Field>
        <p className="text-[11px] text-slate-500">
          From a terminal: <code className="rounded bg-white/5 px-1 font-mono text-[10px] text-slate-300">{CLI_HINT}</code>
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || !file || !!problem || portBad || go.isPending}>
            <Upload size={14} /> {go.isPending ? 'Uploading…' : 'Create and deploy'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 0.16.1: on the Deploys tab of a service built from uploads — send a new
 * version (deployed at once) and see the kept ones. Redeploying an older
 * deployment rebuilds the upload it was made from, while it is kept.
 */
export function UploadSourceCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const uploads = useQuery({ queryKey: ['source-uploads', serviceId], queryFn: () => api.services.sourceUploads(serviceId) });

  const send = useMutation({
    mutationFn: async (file: File) => api.services.uploadSource(serviceId, await bytesOf(file)),
    onSuccess: (res) => {
      toast(res.deploymentId != null ? `Uploaded ${res.sha.slice(0, 7)} — deployment #${res.deploymentId} queued` : `Uploaded ${res.sha.slice(0, 7)}`, 'success');
      qc.invalidateQueries({ queryKey: ['source-uploads', serviceId] });
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
    },
    onError: (err: Error) => toast(err.message || 'Upload failed', 'error'),
  });

  const pick = (file: File | undefined) => {
    if (!file) return;
    const p = archiveProblem(file);
    setProblem(p);
    if (!p) send.mutate(file);
  };

  return (
    <Card className="mb-4">
      <CardBody>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <FileArchive size={15} className="text-slate-500" /> Uploaded source
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-400">
            <Upload size={13} /> {send.isPending ? 'Uploading…' : 'Upload new version'}
            <input
              type="file"
              accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
              aria-label="Upload new version"
              className="sr-only"
              disabled={send.isPending}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <p className="mb-2 text-[11px] text-slate-500">
          This service builds from uploaded archives (.zip / .tar.gz, up to 100 MiB). Or from a terminal:{' '}
          <code className="rounded bg-white/5 px-1 font-mono text-[10px] text-slate-300">ninedeploy deploy up . --service {serviceId}</code>
        </p>
        {problem && <p className="mb-2 text-[11px] text-rose-300/90">{problem}</p>}
        {uploads.isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : (uploads.data?.uploads.length ?? 0) === 0 ? (
          <p className="text-xs text-amber-300/90">Nothing uploaded yet — upload an archive to deploy this service.</p>
        ) : (
          <ul className="space-y-1">
            {uploads.data!.uploads.map((u, i) => (
              <li key={u.sha} className="flex items-center gap-2 text-[11px] text-slate-400">
                <code className="font-mono text-slate-200">{u.sha.slice(0, 7)}</code>
                <span>{u.format}</span>
                <span>{(u.bytes / 1024 / 1024).toFixed(1)} MiB</span>
                <span className="text-slate-500">{formatRelative(u.uploadedAt)}</span>
                {i === 0 && <span className="rounded bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">latest</span>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
