import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bell, Check, Mail, MessageCircle,
  Plug, Send, Siren, Smartphone, Webhook, X, Zap,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from './Toast.js';
import { Button, Input, Modal, Textarea, cn } from './ui.js';
import { type Translate, fill, msg, translate, useT } from '../lib/i18n.js';

const STEPS = [msg('Channel'), msg('Connect'), msg('Events'), msg('Test')];
const TYPES = [
  { id: 'telegram', label: 'Telegram', emoji: '✈️', color: 'from-sky-500 to-blue-600', icon: MessageCircle },
  { id: 'discord', label: 'Discord', emoji: '🎮', color: 'from-indigo-500 to-purple-600', icon: Plug },
  { id: 'webhook', label: 'Webhook', emoji: '🔗', color: 'from-amber-500 to-orange-600', icon: Webhook },
  { id: 'slack', label: 'Slack', emoji: '💬', color: 'from-emerald-500 to-teal-600', icon: MessageCircle },
  { id: 'ntfy', label: 'ntfy', emoji: '📡', color: 'from-rose-500 to-pink-600', icon: Zap },
  { id: 'gotify', label: 'Gotify', emoji: '🔔', color: 'from-fuchsia-500 to-purple-600', icon: Bell },
  { id: 'pushover', label: 'Pushover', emoji: '📲', color: 'from-blue-500 to-indigo-600', icon: Send },
  { id: 'lark', label: 'Lark / Feishu', emoji: '🐦', color: 'from-sky-400 to-cyan-600', icon: MessageCircle },
  { id: 'teams', label: 'Microsoft Teams', emoji: '👥', color: 'from-violet-500 to-indigo-600', icon: MessageCircle },
  { id: 'email', label: msg('Email (SMTP)'), emoji: '✉️', color: 'from-cyan-500 to-sky-600', icon: Mail },
  { id: 'resend', label: msg('Email (Resend)'), emoji: '📨', color: 'from-slate-500 to-zinc-700', icon: Mail },
  // G1.5: FCM (G-22) was CLI-only; the target is a device token, the config the service account JSON.
  { id: 'fcm', label: msg('Firebase push (FCM)'), emoji: '📱', color: 'from-orange-500 to-amber-600', icon: Smartphone },
  // G3.7
  { id: 'mattermost', label: 'Mattermost', emoji: '💬', color: 'from-blue-600 to-sky-700', icon: MessageCircle },
  { id: 'googlechat', label: 'Google Chat', emoji: '💬', color: 'from-green-500 to-emerald-600', icon: MessageCircle },
  { id: 'matrix', label: 'Matrix', emoji: '🟩', color: 'from-zinc-600 to-slate-800', icon: MessageCircle },
  { id: 'pagerduty', label: 'PagerDuty', emoji: '🚨', color: 'from-green-600 to-lime-700', icon: Siren },
  { id: 'opsgenie', label: 'Opsgenie', emoji: '🚨', color: 'from-blue-500 to-cyan-600', icon: Siren },
] as const;

/** The fields the server requires in an FCM service account (lib/fcm.ts `parseServiceAccount`). */
export function fcmServiceAccountError(
  raw: string,
  t: Translate = (text, vars) => translate('en', text, vars),
): string | null {
  if (!raw.trim()) return t('Paste the service account JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return t('Not valid JSON');
  }
  const sa = parsed as Record<string, unknown> | null;
  if (!sa || typeof sa !== 'object' || Array.isArray(sa)) return t('Not a service account JSON object');
  for (const key of ['project_id', 'client_email', 'private_key']) {
    if (typeof sa[key] !== 'string' || !sa[key]) return t('The service account has no {key}', { key });
  }
  return null;
}

const EVENT_GROUPS = [
  { id: 'deploy', label: msg('Deployments'), emoji: '🚀', desc: 'Deploy, rollback, build logs' },
  { id: 'service', label: msg('Services'), emoji: '🖥️', desc: 'Create, delete, stop, start' },
  { id: 'alert', label: msg('Alerts'), emoji: '🔔', desc: 'Metric threshold fired / recovered' },
  { id: 'database', label: msg('Databases'), emoji: '🗄️', desc: 'Create, delete, backup' },
  { id: 'domain', label: msg('Domains'), emoji: '🌐', desc: 'Add, SSL toggle' },
  { id: 'backup', label: msg('Backups'), emoji: '💾', desc: 'Create, restore' },
  { id: 'user', label: msg('Users'), emoji: '👤', desc: 'Register, role change' },
];

const WIZARD_FORM_ID = 'notification-wizard-form';

export function NotificationWizard({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [step, setStep] = useState(0);

  // State
  const [type, setType] = useState<typeof TYPES[number]['id'] | null>(null);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [fcmServiceAccount, setFcmServiceAccount] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set(['deploy', 'service', 'alert']));
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<'ok' | 'fail' | null>(null);
  // The test step needs a persisted channel to deliver through; remember its id
  // so finishing never creates a SECOND channel.
  const [createdId, setCreatedId] = useState<number | null>(null);

  const payload = () => ({
    name: name || `${type} channel`,
    type: type!,
    target,
    eventFilter: Array.from(selectedEvents).join(','),
    ...(type === 'fcm' ? { configJson: fcmServiceAccount } : {}),
  });

  const finish = useMutation({
    // The channel already exists from the test — just sync any edits the user
    // made after testing (back-navigation) and close.
    mutationFn: async () => {
      // finish is only reachable after a successful test (tested === 'ok'),
      // which always sets createdId — so it is guaranteed non-null here.
      const { type: _type, ...patchable } = payload();
      void _type;
      await api.notifications.updateChannel(createdId!, patchable);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notif-channels'] });
      toast(t('Notification channel created!'), 'success');
      onClose();
    },
    onError: () => toast(t('Could not save the channel'), 'error'),
  });

  const canNext = step === 0 ? !!type : step === 1 ? !!target.trim() && (type !== 'fcm' || fcmServiceAccountError(fcmServiceAccount) === null) : true;
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const toggleEvent = (id: string) =>
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const doTest = async () => {
    setTesting(true);
    setTested(null);
    try {
      // Create the channel (once) and deliver a test through it. A re-test
      // after back-navigation PATCHes the existing row instead of duplicating.
      const { type: _type, ...patchable } = payload();
      void _type;
      const ch = createdId != null
        ? { id: createdId }
        : await api.notifications.createChannel(payload());
      if (createdId != null) await api.notifications.updateChannel(createdId, patchable);
      setCreatedId(ch.id);
      await api.notifications.testChannel(ch.id);
      setTested('ok');
      qc.invalidateQueries({ queryKey: ['notif-channels'] });
    } catch {
      setTested('fail');
    } finally {
      setTesting(false);
    }
  };

  // Single submit path: the footer button is type="submit" + form=… — Enter and
  // click both arrive here exactly once (no separate onClick).
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (step < STEPS.length - 1) { if (canNext) next(); }
    else if (tested === 'ok') { finish.mutate(); }
    else { void doTest(); }
  };

  const selectedType = TYPES.find((ty) => ty.id === type);

  return (
    <Modal
      title={<span className="flex items-center gap-2"><Bell size={18} className="text-indigo-400" /> {t('New Notification')}</span>}
      onClose={onClose}
      wide
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" form={WIZARD_FORM_ID} onClick={back} className={cn('mr-auto', step === 0 && 'invisible')}>
            <ArrowLeft size={14} /> {t('Back')}
          </Button>
          <Button type="submit" form={WIZARD_FORM_ID} disabled={!canNext || testing || finish.isPending}>
            {step === STEPS.length - 1 ? (
              tested === 'ok' ? (
                finish.isPending ? t('Saving…') : <><Check size={15} /> {t('Create channel')}</>
              ) : testing ? (
                t('Testing…')
              ) : (
                <><Send size={15} /> {t('Send test')}</>
              )
            ) : (
              <>{t('Continue')} <ArrowRight size={14} /></>
            )}
          </Button>
        </>
      }
    >
      <form id={WIZARD_FORM_ID} onSubmit={onSubmit} className="space-y-5">
        {/* Stepper */}
        <div className="flex items-center gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-1 items-center gap-2">
              <div className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold transition', i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-indigo-500 text-white' : 'bg-white/10 text-slate-500')}>
                {i < step ? <Check size={12} /> : i + 1}
              </div>
              <span className={cn('truncate text-[11px]', i === step ? 'text-slate-200' : 'text-slate-500')}>{t(label)}</span>
              {i < STEPS.length - 1 && <div className={cn('h-px flex-1 transition', i < step ? 'bg-emerald-500/50' : 'bg-white/10')} />}
            </div>
          ))}
        </div>

        {/* Step 1: Choose type — big visual cards */}
        {step === 0 && (
          <div>
            <p className="mb-4 text-sm text-slate-400">{t('Where do you want to receive notifications?')}</p>
            <div className="grid grid-cols-2 gap-3">
              {TYPES.map((ty) => {
                const Icon = ty.icon;
                const active = type === ty.id;
                return (
                  <button key={ty.id} type="button" onClick={() => { setType(ty.id); setName(''); setTarget(''); setFcmServiceAccount(''); }}
                    className={cn('group flex items-center gap-3 rounded-xl border p-3.5 text-left transition', active ? 'border-indigo-500/60 bg-indigo-500/[0.06]' : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]')}>
                    <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white shadow-lg', ty.color)}>
                      <Icon size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-100">{t(ty.label)}</div>
                      <div className="truncate text-[11px] text-slate-500">
                        {ty.id === 'telegram' ? t('Telegram bot')
                          : ty.id === 'discord' ? t('Discord channel')
                          : ty.id === 'webhook' ? t('Any URL')
                          : ty.id === 'slack' ? t('Slack channel')
                          : ty.id === 'ntfy' ? t('ntfy push')
                          : ty.id === 'gotify' ? t('Self-hosted push')
                          : ty.id === 'pushover' ? t('Mobile push')
                          : ty.id === 'lark' ? t('Lark / Feishu bot')
                          : ty.id === 'teams' ? t('Teams channel')
                          : ty.id === 'resend' ? t('Resend email API')
                          : ty.id === 'fcm' ? t('Mobile / web push')
                          : ty.id === 'mattermost' ? t('Incoming webhook')
                          : ty.id === 'googlechat' ? t('Space webhook')
                          : ty.id === 'matrix' ? t('Matrix room')
                          : ty.id === 'pagerduty' ? t('Incidents (Events v2)')
                          : ty.id === 'opsgenie' ? t('Incidents (Alert API)')
                          : t('SMTP email')}
                      </div>
                    </div>
                    {active && <Check size={16} className="text-indigo-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2: Connect — type-specific guided setup */}
        {step === 1 && type && (
          <div className="space-y-4">
            {type === 'telegram' && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl bg-sky-500/[0.06] p-3 ring-1 ring-inset ring-sky-500/20">
                    <p className="mb-1.5 text-xs font-medium text-sky-200">{t('1. Create bot')}</p>
                    <p className="text-[11px] text-slate-400">{fill(t('Open {bot}, send {command}'), { bot: <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">@BotFather</a>, command: <code className="rounded bg-black/30 px-1 text-sky-300">/newbot</code> })}</p>
                  </div>
                  <div className="rounded-xl bg-sky-500/[0.06] p-3 ring-1 ring-inset ring-sky-500/20">
                    <p className="mb-1.5 text-xs font-medium text-sky-200">{t('2. Get Chat ID')}</p>
                    <p className="text-[11px] text-slate-400">{fill(t('Send message to bot, then visit {link}'), { link: <a href="https://api.telegram.org/bot<TOKEN>/getUpdates" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">getUpdates</a> })}</p>
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Bot token : Chat ID')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="789123456:AAEx…:987654321" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'discord' && (
              <>
                <div className="rounded-xl bg-indigo-500/[0.06] p-3 ring-1 ring-inset ring-indigo-500/20">
                  <p className="mb-1.5 text-xs font-medium text-indigo-200">{t('Create Discord Webhook')}</p>
                  <p className="text-[11px] text-slate-400">{t('Channel settings → Integrations → Create Webhook → Copy URL')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Discord Webhook URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://discord.com/api/webhooks/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'slack' && (
              <>
                <div className="rounded-xl bg-emerald-500/[0.06] p-3 ring-1 ring-inset ring-emerald-500/20">
                  <p className="mb-1.5 text-xs font-medium text-emerald-200">{t('Create Slack Webhook')}</p>
                  <p className="text-[11px] text-slate-400">{t('api.slack.com/messaging/webhooks → Create your webhook → Copy URL')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Slack Webhook URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://hooks.slack.com/services/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'ntfy' && (
              <>
                <div className="rounded-xl bg-rose-500/[0.06] p-3 ring-1 ring-inset ring-rose-500/20">
                  <p className="mb-1.5 text-xs font-medium text-rose-200">{t('ntfy topic')}</p>
                  <p className="text-[11px] text-slate-400">{t('Subscribe to a topic in the ntfy app, then use its URL here.')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Topic URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://ntfy.sh/my-ninedeploy-alerts" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'gotify' && (
              <>
                <div className="rounded-xl bg-fuchsia-500/[0.06] p-3 ring-1 ring-inset ring-fuchsia-500/20">
                  <p className="mb-1.5 text-xs font-medium text-fuchsia-200">{t('Gotify app token')}</p>
                  <p className="text-[11px] text-slate-400">{t('In Gotify, create an app (Apps → Create), then paste the message endpoint with its token below.')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Message endpoint URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://push.example.com/message?token=Axxxxxxxxxx" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'pushover' && (
              <>
                <div className="rounded-xl bg-blue-500/[0.06] p-3 ring-1 ring-inset ring-blue-500/20">
                  <p className="mb-1.5 text-xs font-medium text-blue-200">{t('Pushover credentials')}</p>
                  <p className="text-[11px] text-slate-400">{fill(t('Create an {link} for its API token; your user key is on the dashboard.'), { link: <a href="https://pushover.net/apps/build" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{t('application')}</a> })}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('App token @ User key')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="azGDoR8w……@uQiRzpo4DXghDmr9QzzfQu27cmVRsG" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'lark' && (
              <>
                <div className="rounded-xl bg-sky-500/[0.06] p-3 ring-1 ring-inset ring-sky-500/20">
                  <p className="mb-1.5 text-xs font-medium text-sky-200">{t('Lark / Feishu custom bot')}</p>
                  <p className="text-[11px] text-slate-400">{t('In a group chat: Settings → Bots → Add Custom Bot, then paste its webhook URL.')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Webhook URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'teams' && (
              <>
                <div className="rounded-xl bg-violet-500/[0.06] p-3 ring-1 ring-inset ring-violet-500/20">
                  <p className="mb-1.5 text-xs font-medium text-violet-200">{t('Microsoft Teams webhook')}</p>
                  <p className="text-[11px] text-slate-400">{t('In the channel: Workflows → "Post to a channel when a webhook request is received" (or a legacy Incoming Webhook), then paste its URL.')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Webhook URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://prod-00.westeurope.logic.azure.com:443/workflows/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'fcm' && (
              <>
                <div className="rounded-xl bg-orange-500/[0.06] p-3 ring-1 ring-inset ring-orange-500/20">
                  <p className="mb-1.5 text-xs font-medium text-orange-200">Firebase Cloud Messaging</p>
                  <p className="text-[11px] text-slate-400">
                    {t('In the Firebase console: Project settings → Service accounts → Generate new private key. The JSON is stored encrypted; treat it as a secret.')}
                  </p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Device registration token')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="fMEP0vJqS0-…" className="font-mono text-xs" autoFocus />
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Service account JSON')}</span>
                  <Textarea
                    value={fcmServiceAccount}
                    onChange={(e) => setFcmServiceAccount(e.target.value)}
                    aria-label={t('Service account JSON')}
                    placeholder='{"type": "service_account", "project_id": "…", …}'
                    rows={5}
                    className="font-mono text-[11px]"
                  />
                  {fcmServiceAccount.trim() && fcmServiceAccountError(fcmServiceAccount) && (
                    <p className="mt-1 text-[11px] text-rose-400">{fcmServiceAccountError(fcmServiceAccount, t)}</p>
                  )}
                </div>
              </>
            )}
            {type === 'mattermost' && (
              <>
                <div className="rounded-xl bg-blue-500/[0.06] p-3 ring-1 ring-inset ring-blue-500/20">
                  <p className="mb-1.5 text-xs font-medium text-blue-200">{t('Mattermost incoming webhook')}</p>
                  <p className="text-[11px] text-slate-400">{t('Integrations → Incoming Webhooks → Add Incoming Webhook, pick the channel, then paste its URL.')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Webhook URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://mattermost.example.com/hooks/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'googlechat' && (
              <>
                <div className="rounded-xl bg-green-500/[0.06] p-3 ring-1 ring-inset ring-green-500/20">
                  <p className="mb-1.5 text-xs font-medium text-green-200">{t('Google Chat webhook')}</p>
                  <p className="text-[11px] text-slate-400">{t('In the space: Apps & integrations → Webhooks → Add webhook, then paste its URL.')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Webhook URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://chat.googleapis.com/v1/spaces/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'matrix' && <MatrixFields value={target} onChange={setTarget} />}
            {(type === 'pagerduty' || type === 'opsgenie') && <IncidentFields type={type} value={target} onChange={setTarget} />}
            {type === 'email' && <EmailFields value={target} onChange={setTarget} />}
            {type === 'resend' && <ResendFields value={target} onChange={setTarget} />}
            {type === 'webhook' && (
              <>
                <div className="rounded-xl bg-amber-500/[0.06] p-3 ring-1 ring-inset ring-amber-500/20">
                  <p className="mb-1.5 text-xs font-medium text-amber-200">{t('Generic Webhook')}</p>
                  <p className="text-[11px] text-slate-400">{t('NineDeploy will POST JSON for every matching event.')}</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Webhook URL')}</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://your-app.com/webhook" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            <div>
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">{t('Name (optional)')}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('{channel} alerts', { channel: t(selectedType!.label) })} />
            </div>
          </div>
        )}

        {/* Step 3: Event selection — visual toggle cards */}
        {step === 2 && (
          <div>
            <p className="mb-3 text-sm text-slate-400">{t('Which events should trigger a notification?')}</p>
            <div className="grid grid-cols-3 gap-2">
              {EVENT_GROUPS.map((g) => {
                const active = selectedEvents.has(g.id);
                return (
                  <button key={g.id} type="button" onClick={() => toggleEvent(g.id)}
                    className={cn('flex items-center gap-2 rounded-lg border p-2.5 text-left transition', active ? 'border-indigo-500/60 bg-indigo-500/[0.06]' : 'border-white/10 hover:border-white/20')}>
                    <span className="text-base">{g.emoji}</span>
                    <span className={cn('flex-1 text-xs font-medium', active ? 'text-slate-100' : 'text-slate-400')}>{t(g.label)}</span>
                    {active && <Check size={12} className="text-indigo-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 4: Test */}
        {step === 3 && (
          <div className="flex flex-col items-center py-6 text-center">
            <div className={cn('grid h-16 w-16 place-items-center rounded-2xl transition', tested === 'ok' ? 'bg-emerald-500/15 text-emerald-300' : tested === 'fail' ? 'bg-rose-500/15 text-rose-300' : 'bg-indigo-500/15 text-indigo-300')}>
              {tested === 'ok' ? <Check size={28} /> : tested === 'fail' ? <X size={28} /> : <Zap size={28} />}
            </div>
            <p className="mt-4 text-sm font-medium text-slate-200">
              {tested === 'ok' ? t('Test message sent!') : tested === 'fail' ? t('Test failed — check your settings') : t('Ready to test?')}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {tested === 'ok'
                ? type === 'email' || type === 'resend'
                  ? t('Check your inbox for a test message.')
                  : t('Check your {channel} for a test message.', { channel: t(selectedType!.label) })
                : t("We'll send a test notification to verify your setup.")}
            </p>

            {/* Summary */}
            <div className="mt-5 w-full space-y-1.5 rounded-xl bg-white/[0.02] p-3 text-left">
              <SummaryRow label={t('Channel')} value={t(selectedType!.label)} />
              <SummaryRow label={t('Events')} value={selectedEvents.size > 0 ? Array.from(selectedEvents).join(', ') : t('all')} />
              <SummaryRow label={t('Target')} value={summaryTarget(type, target, t)} />
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Email channel target editor — composes the JSON config the server decrypts. */
function EmailFields({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(value) as Record<string, string>;
  } catch {
    /* empty target */
  }
  const set = (key: string, v: string) => onChange(JSON.stringify({ ...cfg, [key]: v }));
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-cyan-500/[0.06] p-3 ring-1 ring-inset ring-cyan-500/20">
        <p className="mb-1 text-xs font-medium text-cyan-200">{t('SMTP settings')}</p>
        <p className="text-[11px] text-slate-400">{t('Credentials are encrypted at rest.')}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('SMTP host')}</span>
          <Input value={cfg['host'] ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" className="h-8 font-mono text-xs" autoFocus />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('Port')}</span>
          <Input value={cfg['port'] ?? ''} onChange={(e) => set('port', e.target.value)} placeholder="587" className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('From')}</span>
          <Input value={cfg['from'] ?? ''} onChange={(e) => set('from', e.target.value)} placeholder="ninedeploy@example.com" className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('To')}</span>
          <Input value={cfg['to'] ?? ''} onChange={(e) => set('to', e.target.value)} placeholder="you@example.com" className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('User')}</span>
          <Input value={cfg['user'] ?? ''} onChange={(e) => set('user', e.target.value)} className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('Password')}</span>
          <Input type="password" value={cfg['pass'] ?? ''} onChange={(e) => set('pass', e.target.value)} className="h-8 font-mono text-xs" />
        </div>
      </div>
    </div>
  );
}

/**
 * The Target row of the test summary. Resend, Matrix and incident targets hold
 * a secret, so show only the part that says where messages go.
 */
function summaryTarget(type: string | null, target: string, t: Translate): string {
  const field = (key: string): string => {
    try {
      const v = (JSON.parse(target) as Record<string, unknown>)[key];
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  };
  if (type === 'resend') return field('to');
  if (type === 'matrix') return field('roomId');
  if (type === 'pagerduty' || type === 'opsgenie') return t('{region} region', { region: (field('region') || 'us').toUpperCase() });
  return target.slice(0, 40) + (target.length > 40 ? '…' : '');
}

/** Resend channel target editor — composes the JSON {apiKey, from, to} the server decrypts. */
function ResendFields({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(value) as Record<string, string>;
  } catch {
    /* empty target */
  }
  const set = (key: string, v: string) => onChange(JSON.stringify({ ...cfg, [key]: v }));
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-slate-500/[0.06] p-3 ring-1 ring-inset ring-slate-500/20">
        <p className="mb-1 text-xs font-medium text-slate-200">Resend</p>
        <p className="text-[11px] text-slate-400">{t('Create an API key at resend.com/api-keys; the From address must be on a domain you verified there. The key is encrypted at rest.')}</p>
      </div>
      <div className="space-y-2">
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('API key')}</span>
          <Input type="password" value={cfg['apiKey'] ?? ''} onChange={(e) => set('apiKey', e.target.value)} placeholder="re_…" className="h-8 font-mono text-xs" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('From')}</span>
            <Input value={cfg['from'] ?? ''} onChange={(e) => set('from', e.target.value)} placeholder="ninedeploy@example.com" className="h-8 font-mono text-xs" />
          </div>
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('To (comma-separated)')}</span>
            <Input value={cfg['to'] ?? ''} onChange={(e) => set('to', e.target.value)} placeholder="you@example.com" className="h-8 font-mono text-xs" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Matrix target editor — composes the JSON {homeserver, roomId, accessToken} the server decrypts. */
function MatrixFields({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(value) as Record<string, string>;
  } catch {
    /* empty target */
  }
  const set = (key: string, v: string) => onChange(JSON.stringify({ ...cfg, [key]: v }));
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-zinc-500/[0.06] p-3 ring-1 ring-inset ring-zinc-500/20">
        <p className="mb-1 text-xs font-medium text-zinc-200">{t('Matrix room')}</p>
        <p className="text-[11px] text-slate-400">{t('Invite a bot account to the room and use its access token. The token is encrypted at rest.')}</p>
      </div>
      <div className="space-y-2">
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('Homeserver')}</span>
          <Input value={cfg['homeserver'] ?? ''} onChange={(e) => set('homeserver', e.target.value)} placeholder="https://matrix.example.org" className="h-8 font-mono text-xs" autoFocus />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('Room ID or alias')}</span>
          <Input value={cfg['roomId'] ?? ''} onChange={(e) => set('roomId', e.target.value)} placeholder="!abcdef:example.org" className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('Access token')}</span>
          <Input type="password" value={cfg['accessToken'] ?? ''} onChange={(e) => set('accessToken', e.target.value)} placeholder="syt_…" className="h-8 font-mono text-xs" />
        </div>
      </div>
    </div>
  );
}

/** PagerDuty / Opsgenie target editor — composes `{routingKey|apiKey, region}`. */
function IncidentFields({ type, value, onChange }: { type: 'pagerduty' | 'opsgenie'; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const keyField = type === 'pagerduty' ? 'routingKey' : 'apiKey';
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(value) as Record<string, string>;
  } catch {
    /* empty target */
  }
  const key = cfg[keyField] ?? '';
  const region = cfg['region'] === 'eu' ? 'eu' : 'us';
  // An empty key leaves the target empty, so Continue stays disabled.
  const set = (k: string, r: string) => onChange(k ? JSON.stringify({ [keyField]: k, region: r }) : '');
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-emerald-500/[0.06] p-3 ring-1 ring-inset ring-emerald-500/20">
        <p className="mb-1 text-xs font-medium text-emerald-200">{type === 'pagerduty' ? t('PagerDuty Events API v2') : t('Opsgenie API integration')}</p>
        <p className="text-[11px] text-slate-400">
          {type === 'pagerduty'
            ? t('Service → Integrations → Add an integration → Events API V2, then copy its integration (routing) key.')
            : t('Team → Integrations → Add integration → API, then copy its API key.')}
          {' '}{t('Only problems open an incident (alerts, monitor or service down, failed deploys, missed backups); the matching recovery or the next successful deploy closes it.')}
        </p>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{type === 'pagerduty' ? t('Routing key') : t('API key')}</span>
          <Input type="password" aria-label={type === 'pagerduty' ? t('Routing key') : t('API key')} value={key} onChange={(e) => set(e.target.value.trim(), region)} className="h-8 font-mono text-xs" autoFocus />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">{t('Region')}</span>
          <select
            aria-label={t('Region')}
            value={region}
            onChange={(e) => set(key, e.target.value)}
            className="h-8 rounded-lg border border-white/10 bg-black/20 px-2 text-xs text-slate-200"
          >
            <option value="us">US</option>
            <option value="eu">EU</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="max-w-[65%] truncate font-mono text-slate-300">{value}</span>
    </div>
  );
}
