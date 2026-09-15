import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bell, Check, Mail, MessageCircle,
  Plug, Send, Webhook, X, Zap,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from './Toast.js';
import { Button, Input, Modal, cn } from './ui.js';

const STEPS = ['Channel', 'Connect', 'Events', 'Test'];
const TYPES = [
  { id: 'telegram', label: 'Telegram', emoji: '✈️', color: 'from-sky-500 to-blue-600', icon: MessageCircle },
  { id: 'discord', label: 'Discord', emoji: '🎮', color: 'from-indigo-500 to-purple-600', icon: Plug },
  { id: 'webhook', label: 'Webhook', emoji: '🔗', color: 'from-amber-500 to-orange-600', icon: Webhook },
  { id: 'slack', label: 'Slack', emoji: '💬', color: 'from-emerald-500 to-teal-600', icon: MessageCircle },
  { id: 'ntfy', label: 'ntfy', emoji: '📡', color: 'from-rose-500 to-pink-600', icon: Zap },
  { id: 'gotify', label: 'Gotify', emoji: '🔔', color: 'from-fuchsia-500 to-purple-600', icon: Bell },
  { id: 'pushover', label: 'Pushover', emoji: '📲', color: 'from-blue-500 to-indigo-600', icon: Send },
  { id: 'lark', label: 'Lark / Feishu', emoji: '🐦', color: 'from-sky-400 to-cyan-600', icon: MessageCircle },
  { id: 'email', label: 'Email (SMTP)', emoji: '✉️', color: 'from-cyan-500 to-sky-600', icon: Mail },
] as const;

const EVENT_GROUPS = [
  { id: 'deploy', label: 'Deployments', emoji: '🚀', desc: 'Deploy, rollback, build logs' },
  { id: 'service', label: 'Services', emoji: '🖥️', desc: 'Create, delete, stop, start' },
  { id: 'alert', label: 'Alerts', emoji: '🔔', desc: 'Metric threshold fired / recovered' },
  { id: 'database', label: 'Databases', emoji: '🗄️', desc: 'Create, delete, backup' },
  { id: 'domain', label: 'Domains', emoji: '🌐', desc: 'Add, SSL toggle' },
  { id: 'backup', label: 'Backups', emoji: '💾', desc: 'Create, restore' },
  { id: 'user', label: 'Users', emoji: '👤', desc: 'Register, role change' },
];

const WIZARD_FORM_ID = 'notification-wizard-form';

export function NotificationWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [step, setStep] = useState(0);

  // State
  const [type, setType] = useState<typeof TYPES[number]['id'] | null>(null);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
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
      toast('Notification channel created!', 'success');
      onClose();
    },
    onError: () => toast('Could not save the channel', 'error'),
  });

  const canNext = step === 0 ? !!type : step === 1 ? !!target.trim() : true;
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

  const selectedType = TYPES.find((t) => t.id === type);

  return (
    <Modal
      title={<span className="flex items-center gap-2"><Bell size={18} className="text-indigo-400" /> New Notification</span>}
      onClose={onClose}
      wide
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" form={WIZARD_FORM_ID} onClick={back} className={cn('mr-auto', step === 0 && 'invisible')}>
            <ArrowLeft size={14} /> Back
          </Button>
          <Button type="submit" form={WIZARD_FORM_ID} disabled={!canNext || testing || finish.isPending}>
            {step === STEPS.length - 1 ? (
              tested === 'ok' ? (
                finish.isPending ? 'Saving…' : <><Check size={15} /> Create channel</>
              ) : testing ? (
                'Testing…'
              ) : (
                <><Send size={15} /> Send test</>
              )
            ) : (
              <>Continue <ArrowRight size={14} /></>
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
              <span className={cn('truncate text-[11px]', i === step ? 'text-slate-200' : 'text-slate-500')}>{label}</span>
              {i < STEPS.length - 1 && <div className={cn('h-px flex-1 transition', i < step ? 'bg-emerald-500/50' : 'bg-white/10')} />}
            </div>
          ))}
        </div>

        {/* Step 1: Choose type — big visual cards */}
        {step === 0 && (
          <div>
            <p className="mb-4 text-sm text-slate-400">Where do you want to receive notifications?</p>
            <div className="grid grid-cols-2 gap-3">
              {TYPES.map((t) => {
                const Icon = t.icon;
                const active = type === t.id;
                return (
                  <button key={t.id} type="button" onClick={() => { setType(t.id); setName(''); setTarget(''); }}
                    className={cn('group flex items-center gap-3 rounded-xl border p-3.5 text-left transition', active ? 'border-indigo-500/60 bg-indigo-500/[0.06]' : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]')}>
                    <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white shadow-lg', t.color)}>
                      <Icon size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-100">{t.label}</div>
                      <div className="truncate text-[11px] text-slate-500">
                        {t.id === 'telegram' ? 'Telegram bot'
                          : t.id === 'discord' ? 'Discord channel'
                          : t.id === 'webhook' ? 'Any URL'
                          : t.id === 'slack' ? 'Slack channel'
                          : t.id === 'ntfy' ? 'ntfy push'
                          : t.id === 'gotify' ? 'Self-hosted push'
                          : t.id === 'pushover' ? 'Mobile push'
                          : t.id === 'lark' ? 'Lark / Feishu bot'
                          : 'SMTP email'}
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
                    <p className="mb-1.5 text-xs font-medium text-sky-200">1. Create bot</p>
                    <p className="text-[11px] text-slate-400">Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">@BotFather</a>, send <code className="rounded bg-black/30 px-1 text-sky-300">/newbot</code></p>
                  </div>
                  <div className="rounded-xl bg-sky-500/[0.06] p-3 ring-1 ring-inset ring-sky-500/20">
                    <p className="mb-1.5 text-xs font-medium text-sky-200">2. Get Chat ID</p>
                    <p className="text-[11px] text-slate-400">Send message to bot, then visit <a href="https://api.telegram.org/bot<TOKEN>/getUpdates" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">getUpdates</a></p>
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Bot token : Chat ID</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="789123456:AAEx…:987654321" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'discord' && (
              <>
                <div className="rounded-xl bg-indigo-500/[0.06] p-3 ring-1 ring-inset ring-indigo-500/20">
                  <p className="mb-1.5 text-xs font-medium text-indigo-200">Create Discord Webhook</p>
                  <p className="text-[11px] text-slate-400">Channel settings → Integrations → Create Webhook → Copy URL</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Discord Webhook URL</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://discord.com/api/webhooks/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'slack' && (
              <>
                <div className="rounded-xl bg-emerald-500/[0.06] p-3 ring-1 ring-inset ring-emerald-500/20">
                  <p className="mb-1.5 text-xs font-medium text-emerald-200">Create Slack Webhook</p>
                  <p className="text-[11px] text-slate-400">api.slack.com/messaging/webhooks → Create your webhook → Copy URL</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Slack Webhook URL</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://hooks.slack.com/services/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'ntfy' && (
              <>
                <div className="rounded-xl bg-rose-500/[0.06] p-3 ring-1 ring-inset ring-rose-500/20">
                  <p className="mb-1.5 text-xs font-medium text-rose-200">ntfy topic</p>
                  <p className="text-[11px] text-slate-400">Subscribe to a topic in the ntfy app, then use its URL here.</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Topic URL</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://ntfy.sh/my-ninedeploy-alerts" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'gotify' && (
              <>
                <div className="rounded-xl bg-fuchsia-500/[0.06] p-3 ring-1 ring-inset ring-fuchsia-500/20">
                  <p className="mb-1.5 text-xs font-medium text-fuchsia-200">Gotify app token</p>
                  <p className="text-[11px] text-slate-400">In Gotify, create an app (Apps → Create), then paste the message endpoint with its token below.</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Message endpoint URL</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://push.example.com/message?token=Axxxxxxxxxx" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'pushover' && (
              <>
                <div className="rounded-xl bg-blue-500/[0.06] p-3 ring-1 ring-inset ring-blue-500/20">
                  <p className="mb-1.5 text-xs font-medium text-blue-200">Pushover credentials</p>
                  <p className="text-[11px] text-slate-400">Create an <a href="https://pushover.net/apps/build" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">application</a> for its API token; your user key is on the dashboard.</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">App token @ User key</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="azGDoR8w……@uQiRzpo4DXghDmr9QzzfQu27cmVRsG" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'lark' && (
              <>
                <div className="rounded-xl bg-sky-500/[0.06] p-3 ring-1 ring-inset ring-sky-500/20">
                  <p className="mb-1.5 text-xs font-medium text-sky-200">Lark / Feishu custom bot</p>
                  <p className="text-[11px] text-slate-400">In a group chat: Settings → Bots → Add Custom Bot, then paste its webhook URL.</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Webhook URL</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/…" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            {type === 'email' && <EmailFields value={target} onChange={setTarget} />}
            {type === 'webhook' && (
              <>
                <div className="rounded-xl bg-amber-500/[0.06] p-3 ring-1 ring-inset ring-amber-500/20">
                  <p className="mb-1.5 text-xs font-medium text-amber-200">Generic Webhook</p>
                  <p className="text-[11px] text-slate-400">NineDeploy will POST JSON for every matching event.</p>
                </div>
                <div>
                  <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Webhook URL</span>
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://your-app.com/webhook" className="font-mono text-xs" autoFocus />
                </div>
              </>
            )}
            <div>
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Name (optional)</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${selectedType!.label} alerts`} />
            </div>
          </div>
        )}

        {/* Step 3: Event selection — visual toggle cards */}
        {step === 2 && (
          <div>
            <p className="mb-3 text-sm text-slate-400">Which events should trigger a notification?</p>
            <div className="grid grid-cols-3 gap-2">
              {EVENT_GROUPS.map((g) => {
                const active = selectedEvents.has(g.id);
                return (
                  <button key={g.id} type="button" onClick={() => toggleEvent(g.id)}
                    className={cn('flex items-center gap-2 rounded-lg border p-2.5 text-left transition', active ? 'border-indigo-500/60 bg-indigo-500/[0.06]' : 'border-white/10 hover:border-white/20')}>
                    <span className="text-base">{g.emoji}</span>
                    <span className={cn('flex-1 text-xs font-medium', active ? 'text-slate-100' : 'text-slate-400')}>{g.label}</span>
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
              {tested === 'ok' ? 'Test message sent!' : tested === 'fail' ? 'Test failed — check your settings' : 'Ready to test?'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {tested === 'ok'
                ? `Check your ${type === 'email' ? 'inbox' : selectedType!.label} for a test message.`
                : 'We\'ll send a test notification to verify your setup.'}
            </p>

            {/* Summary */}
            <div className="mt-5 w-full space-y-1.5 rounded-xl bg-white/[0.02] p-3 text-left">
              <SummaryRow label="Channel" value={selectedType!.label} />
              <SummaryRow label="Events" value={selectedEvents.size > 0 ? Array.from(selectedEvents).join(', ') : 'all'} />
              <SummaryRow label="Target" value={target.slice(0, 40) + (target.length > 40 ? '…' : '')} />
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Email channel target editor — composes the JSON config the server decrypts. */
function EmailFields({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
        <p className="mb-1 text-xs font-medium text-cyan-200">SMTP settings</p>
        <p className="text-[11px] text-slate-400">Credentials are encrypted at rest.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">SMTP host</span>
          <Input value={cfg['host'] ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" className="h-8 font-mono text-xs" autoFocus />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">Port</span>
          <Input value={cfg['port'] ?? ''} onChange={(e) => set('port', e.target.value)} placeholder="587" className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">From</span>
          <Input value={cfg['from'] ?? ''} onChange={(e) => set('from', e.target.value)} placeholder="ninedeploy@example.com" className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">To</span>
          <Input value={cfg['to'] ?? ''} onChange={(e) => set('to', e.target.value)} placeholder="you@example.com" className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">User</span>
          <Input value={cfg['user'] ?? ''} onChange={(e) => set('user', e.target.value)} className="h-8 font-mono text-xs" />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">Password</span>
          <Input type="password" value={cfg['pass'] ?? ''} onChange={(e) => set('pass', e.target.value)} className="h-8 font-mono text-xs" />
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
