import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { FileKey2, Pencil, Trash2, Upload } from 'lucide-react';
import type { CustomCertificate, CustomCertificateSaved } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, ErrorCard, Field, Input, Modal, Skeleton, Textarea } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

const DAY_MS = 86_400_000;
/** Matches the inventory's "expiring soon" default. */
const EXPIRING_DAYS = 30;

interface FormState {
  name: string;
  certPem: string;
  keyPem: string;
}

const EMPTY: FormState = { name: '', certPem: '', keyPem: '' };

/** Days until `notAfter` (negative once expired). */
export function daysLeft(notAfter: string, now = Date.now()): number {
  return Math.floor((new Date(notAfter).getTime() - now) / DAY_MS);
}

function ExpiryBadge({ cert }: { cert: CustomCertificate }) {
  const t = useT();
  const days = daysLeft(cert.notAfter);
  if (cert.expired || days < 0) return <Badge tone="rose">{t('expired')}</Badge>;
  if (days <= EXPIRING_DAYS) return <Badge tone="amber">{t('{days}d left', { days })}</Badge>;
  return <Badge tone="emerald">{t('valid')}</Badge>;
}

/** Read a picked PEM file into the form field (the file never leaves the browser except in the request). */
function readPicked(e: ChangeEvent<HTMLInputElement>, apply: (text: string) => void) {
  const file = e.target.files?.[0];
  if (file) void file.text().then(apply);
}

/**
 * Traefik → Certificates → Uploaded certificates (0.14, operator only).
 * A domain fully covered by a valid uploaded certificate is served with it
 * instead of Let's Encrypt. Private keys are write-only: no response carries
 * one, and the form forgets it after a successful save.
 */
export function CertificatesCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useQuery({ queryKey: ['traefik-custom-certificates'], queryFn: () => api.traefik.customCertificates.list() });
  /** `null` = closed, `'new'` = upload, a certificate = replace it. */
  const [editing, setEditing] = useState<'new' | CustomCertificate | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [deleting, setDeleting] = useState<CustomCertificate | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['traefik-custom-certificates'] });
    // The ACME list on this page (and its counts) merges uploaded certificates.
    void qc.invalidateQueries({ queryKey: ['traefik'] });
  };

  const saved = (res: CustomCertificateSaved, uploaded: boolean) => {
    setForm(EMPTY);
    setEditing(null);
    refresh();
    const hosts = res.hostnames.join(', ');
    toast(uploaded ? t('Certificate uploaded: {hosts}', { hosts }) : t('Certificate replaced: {hosts}', { hosts }), 'success');
    for (const w of res.warnings) toast(w, 'info');
  };

  const save = useMutation({
    mutationFn: ({ target, f }: { target: 'new' | CustomCertificate; f: FormState }) =>
      target === 'new'
        ? api.traefik.customCertificates.upload({ name: f.name.trim(), certPem: f.certPem, keyPem: f.keyPem })
        : api.traefik.customCertificates.replace(target.id, {
            ...(f.name.trim() ? { name: f.name.trim() } : {}),
            certPem: f.certPem,
            keyPem: f.keyPem,
          }),
    onSuccess: (res, { target }) => saved(res, target === 'new'),
    onError: (err) => toast(err instanceof Error ? err.message : t('Could not save the certificate'), 'error'),
  });

  const remove = useMutation({
    mutationFn: (cert: CustomCertificate) => api.traefik.customCertificates.delete(cert.id),
    onSuccess: (_res, cert) => {
      refresh();
      toast(t('Certificate "{name}" deleted', { name: cert.name }), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Could not delete the certificate'), 'error'),
  });

  const open = (target: 'new' | CustomCertificate) => {
    setForm(EMPTY);
    setEditing(target);
  };

  if (list.isLoading) {
    return (
      <Card>
        <CardBody>
          <Skeleton className="h-24" />
        </CardBody>
      </Card>
    );
  }
  if (list.isError || !list.data) {
    return <ErrorCard title={t("Couldn't load the uploaded certificates")} error={list.error} onRetry={() => void list.refetch()} />;
  }

  const certs = list.data;
  const isNew = editing === 'new';
  const invalid = (isNew && form.name.trim() === '') || form.certPem.trim() === '' || form.keyPem.trim() === '';

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <FileKey2 size={14} /> {t('Uploaded certificates')}
        </h2>
        <Button size="sm" onClick={() => open('new')}>
          <Upload size={12} /> {t('Upload certificate')}
        </Button>
      </div>
      {certs.length === 0 ? (
        <CardBody>
          <p className="text-sm text-slate-500">{t("No uploaded certificates. Domains use Let's Encrypt.")}</p>
          <p className="mt-1 text-xs text-slate-600">
            {t('Upload a certificate (e.g. a purchased wildcard) and every SSL domain it fully covers is served with it instead.')}
          </p>
        </CardBody>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3">{t('Name')}</th>
                <th className="px-5 py-3">{t('Hostnames')}</th>
                <th className="px-5 py-3">{t('Issuer')}</th>
                <th className="px-5 py-3">{t('Expires')}</th>
                <th className="px-5 py-3">{t('Covers')}</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {certs.map((cert) => (
                <tr key={cert.id} className="border-t border-white/5 align-top" data-testid={`custom-cert-${cert.id}`}>
                  <td className="px-5 py-3">
                    <div className="font-medium">{cert.name}</div>
                    <div className="font-mono text-[10px] text-slate-600" title={cert.fingerprint}>
                      {cert.fingerprint.slice(0, 16)}
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs">{cert.hostnames.join(', ')}</td>
                  <td className="px-5 py-3 text-xs text-slate-400">{cert.issuer ?? '—'}</td>
                  <td className="px-5 py-3 text-xs">
                    <div className="tabular-nums">{formatDateTime(cert.notAfter)}</div>
                    <ExpiryBadge cert={cert} />
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-400">
                    {cert.coveredDomains.length === 0 ? (
                      <span className="text-slate-600">{t('no domains')}</span>
                    ) : (
                      cert.coveredDomains.map((d) => <div key={d.id}>{d.hostname}</div>)
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => open(cert)} aria-label={t('Replace {name}', { name: cert.name })}>
                        <Pencil size={12} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(cert)} aria-label={t('Delete {name}', { name: cert.name })}>
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal
          title={isNew ? t('Upload certificate') : t('Replace "{name}"', { name: (editing as CustomCertificate).name })}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {t('Cancel')}
              </Button>
              <Button onClick={() => save.mutate({ target: editing, f: form })} disabled={invalid || save.isPending}>
                {save.isPending ? t('Saving…') : isNew ? t('Upload') : t('Replace')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Field label={t('Name')} hint={isNew ? undefined : t('blank = keep')}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="wildcard-example-com" />
            </Field>
            <Field label={t('Certificate chain (PEM)')} hint={t('leaf first')}>
              <Textarea
                rows={6}
                className="font-mono text-[11px]"
                value={form.certPem}
                onChange={(e) => setForm({ ...form, certPem: e.target.value })}
                placeholder="-----BEGIN CERTIFICATE-----"
              />
            </Field>
            <input
              type="file"
              accept=".pem,.crt,.cer"
              aria-label={t('Certificate file')}
              className="text-xs text-slate-500"
              onChange={(e) => readPicked(e, (text) => setForm((f) => ({ ...f, certPem: text })))}
            />
            <Field label={t('Private key (PEM)')} hint={t('unencrypted; never shown again')}>
              <Textarea
                rows={5}
                className="font-mono text-[11px]"
                value={form.keyPem}
                onChange={(e) => setForm({ ...form, keyPem: e.target.value })}
                placeholder="-----BEGIN PRIVATE KEY-----"
              />
            </Field>
            <input
              type="file"
              accept=".pem,.key"
              aria-label={t('Private key file')}
              className="text-xs text-slate-500"
              onChange={(e) => readPicked(e, (text) => setForm((f) => ({ ...f, keyPem: text })))}
            />
            <p className="text-[11px] text-slate-500">
              {t('RSA ≥ 2048, ECDSA P-256/P-384 or Ed25519. A www pair needs both names covered.')}
            </p>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t('Delete this certificate?')}
        message={t('Domains served with "{name}" fall back to Let\'s Encrypt.', { name: deleting?.name ?? '' })}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}
