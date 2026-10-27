import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { STATUS_PAGE_MONITORS_MAX, type MonitorView, type StatusPageView } from '@ninedeploy/schemas';
import { uptimeApi, uptimeKeys } from '../../lib/uptimeApi.js';
import {
  emptyStatusPageForm,
  type FieldErrors,
  moveItem,
  monitorStatusUi,
  slugify,
  type StatusPageForm,
  statusPageToForm,
  validateStatusPageForm,
} from '../../lib/uptime.js';
import { useToast } from '../Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Field, Input, Modal, Select, Switch, Textarea, cn } from '../ui.js';

/** Create or edit a public status page (operators): its texts and which monitors it shows, in order. */
export function StatusPageFormModal({ page, monitors, onClose }: { page?: StatusPageView; monitors: readonly MonitorView[]; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const mode = page ? 'edit' : 'create';
  const [form, setForm] = useState<StatusPageForm>(() => (page ? statusPageToForm(page) : emptyStatusPageForm()));
  // A new page's slug follows its title until the slug is typed in.
  const [slugTouched, setSlugTouched] = useState(Boolean(page));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const set = <K extends keyof StatusPageForm>(key: K, value: StatusPageForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const available = monitors.filter((m) => !form.monitorIds.includes(m.id));

  const save = useMutation({
    mutationFn: ({ body }: Extract<ReturnType<typeof validateStatusPageForm>, { ok: true }>) =>
      page ? uptimeApi.statusPages.update(page.id, body) : uptimeApi.statusPages.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: uptimeKeys.statusPages });
      toast(page ? t('Status page saved') : t('Status page created'), 'success');
      onClose();
    },
    onError: (err: Error) => {
      const message = err.message || t('Could not save the status page');
      setServerError(message);
      toast(message, 'error');
    },
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setServerError(null);
    const result = validateStatusPageForm(form, mode);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result);
  };

  return (
    <Modal
      title={page ? t('Edit {name}', { name: page.title }) : t('New status page')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => submit()} disabled={save.isPending}>
            {save.isPending ? t('Saving…') : page ? t('Save page') : t('Create page')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" aria-label={t('Status page')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('Title')} error={errors.title}>
            <Input
              value={form.title}
              onChange={(e) => {
                const title = e.target.value;
                setForm((f) => ({ ...f, title, slug: slugTouched ? f.slug : slugify(title) }));
              }}
              placeholder="Acme status"
              maxLength={100}
            />
          </Field>
          <Field label={t('Slug')} error={errors.slug} hint={t('Public at {path}', { path: `/status/${form.slug || '<slug>'}` })}>
            <Input
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', e.target.value);
              }}
              placeholder="acme"
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
        </div>
        <Field label={t('Description (optional)')} error={errors.description}>
          <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={2} maxLength={500} />
        </Field>
        <Field
          label={t('Notice (optional)')}
          error={errors.notice}
          hint={t('Shown at the top of the page: planned maintenance, an ongoing incident.')}
        >
          <Textarea value={form.notice} onChange={(e) => set('notice', e.target.value)} rows={2} maxLength={1000} />
        </Field>

        <div className="space-y-2 rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 text-sm text-slate-300">
              {t('Published')}
              <span className="block text-[11px] text-slate-500">{t('Unpublished pages answer 404 to everyone.')}</span>
            </span>
            <Switch checked={form.published} onChange={(v) => set('published', v)} label={t('Published')} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-slate-300">{t('Show response times')}</span>
            <Switch checked={form.showResponseTimes} onChange={(v) => set('showResponseTimes', v)} label={t('Show response times')} />
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">{t('Monitors')}</span>
          <p className="mb-2 text-[11px] text-slate-500">{t('Shown by name only, never the target, in this order.')}</p>
          {form.monitorIds.length === 0 ? (
            <p className="rounded-lg bg-white/[0.02] px-3 py-2 text-xs text-slate-500 ring-1 ring-inset ring-white/5">{t('No monitors on this page yet.')}</p>
          ) : (
            <ol className="space-y-1" aria-label={t('Monitors on the page')}>
              {form.monitorIds.map((id, i) => {
                const m = byId.get(id);
                const ui = monitorStatusUi(m?.status ?? 'pending');
                const name = m?.name ?? t('monitor #{id}', { id });
                return (
                  <li key={id} className="flex items-center gap-2 rounded-lg bg-white/[0.02] px-3 py-1.5 text-sm ring-1 ring-inset ring-white/5">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', ui.dot)} />
                    <span className="min-w-0 flex-1 truncate text-slate-200">{name}</span>
                    <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={i === 0} aria-label={t('Move {name} up', { name })} onClick={() => set('monitorIds', moveItem(form.monitorIds, i, -1))}>
                      <ArrowUp size={13} />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      disabled={i === form.monitorIds.length - 1}
                      aria-label={t('Move {name} down', { name })}
                      onClick={() => set('monitorIds', moveItem(form.monitorIds, i, 1))}
                    >
                      <ArrowDown size={13} />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={t('Remove {name}', { name })}
                      onClick={() => set('monitorIds', form.monitorIds.filter((x) => x !== id))}
                    >
                      <X size={13} />
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
          {available.length > 0 && form.monitorIds.length < STATUS_PAGE_MONITORS_MAX && (
            <Select
              aria-label={t('Add a monitor')}
              value=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id) set('monitorIds', [...form.monitorIds, id]);
              }}
              className="mt-2 h-9 text-xs"
            >
              <option value="">{t('Add a monitor…')}</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
          {errors.monitorIds && <p className="mt-1.5 text-[11px] text-rose-300">{errors.monitorIds}</p>}
        </div>

        {serverError && (
          <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-inset ring-rose-500/20">
            {serverError}
          </p>
        )}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
