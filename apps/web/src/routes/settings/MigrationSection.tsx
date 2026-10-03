import { useRef, useState } from 'react';
import { Download, GitBranch, Upload } from 'lucide-react';
import { Link } from 'react-router';
import { authedFetch } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { downloadBlob } from '../../lib/format.js';
import { Card, CardBody } from '../../components/ui.js';

/** Migration: full-system export/import plus quick links. */
export function MigrationSection() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const doExport = async () => {
    try {
      toast('Preparing export…', 'info');
      const res = await authedFetch('/v1/system/export');
      if (!res.ok) throw new Error('Export failed');
      downloadBlob(await res.blob(), `ninedeploy-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
      toast('Export downloaded', 'success');
    } catch {
      toast('Export failed', 'error');
    }
  };

  const doImport = async (file: File) => {
    setImporting(true);
    try {
      toast('Importing… this may take a moment', 'info');
      const buf = await file.arrayBuffer();
      const res = await authedFetch('/v1/system/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      // A JSON error body must not be reported as a successful import.
      const json = (await res.json().catch(() => null)) as { message?: string; error?: { message?: string } } | null;
      if (!res.ok) {
        throw new Error(json?.error?.message || json?.message || 'Import failed');
      }
      toast(json?.message || 'Import complete — restart NineDeploy', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <Card className="mb-5">
        <CardBody>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Migration</h2>
          <p className="mb-3 text-xs text-slate-500">
            Export the full system state (database, encryption key, Traefik config, .env) to migrate to another server.
            Import on the new server, then restart.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button"
              onClick={doExport}
              className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-4 py-2 text-sm text-slate-300 transition hover:bg-white/[0.08]"
            >
              <Download size={15} /> Export backup
            </button>
            <button type="button"
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-4 py-2 text-sm text-slate-300 transition hover:bg-white/[0.08] disabled:opacity-50"
            >
              <Upload size={15} /> {importing ? 'Importing…' : 'Import backup'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".gz,.tar.gz,application/gzip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doImport(f);
                e.target.value = '';
              }}
            />
          </div>
        </CardBody>
      </Card>

      {/* Quick links — in-app navigation, never raw API endpoints */}
      <Card>
        <CardBody>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Quick Links</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link to="/monitoring" className="rounded-lg bg-white/[0.04] px-3 py-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-200">Activity log</Link>
            <Link to="/monitoring" className="rounded-lg bg-white/[0.04] px-3 py-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-200">Health check</Link>
            <a href="https://github.com/ninedeploy/ninedeploy" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-3 py-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-200"><GitBranch size={13} /> GitHub ↗</a>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
