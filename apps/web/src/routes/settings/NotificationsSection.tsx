import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CirclePause, CirclePlay, Pencil, Send, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Input, cn } from '../../components/ui.js';
import { NotificationWizard } from '../../components/NotificationWizard.js';

/** Shape of a Discord channel's `config_json` blob (G-18 PR-A + G-18B). */
interface DiscordChannelConfig {
  username?: string;
  avatarUrl?: string;
  title?: string;
  color?: number;
}

/** Parse the raw `config_json` string into the typed shape, falling
 *  back to an empty object when the blob is missing or malformed. */
function parseDiscordConfig(raw: string | null | undefined): DiscordChannelConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cfg: DiscordChannelConfig = {};
    if (typeof parsed.username === 'string') cfg.username = parsed.username;
    if (typeof parsed.avatarUrl === 'string') cfg.avatarUrl = parsed.avatarUrl;
    if (typeof parsed.title === 'string') cfg.title = parsed.title;
    if (typeof parsed.color === 'number') cfg.color = parsed.color;
    return cfg;
  } catch {
    return {};
  }
}

/** Stringify the typed shape back to a blob the API will accept. */
function serializeDiscordConfig(cfg: DiscordChannelConfig): string {
  // Drop empty fields so a "clear the embed" form submission does
  // not retain ghost keys in the JSON blob.
  const cleaned: Record<string, string | number> = {};
  if (cfg.username) cleaned.username = cfg.username;
  if (cfg.avatarUrl) cleaned.avatarUrl = cfg.avatarUrl;
  if (cfg.title) cleaned.title = cfg.title;
  if (cfg.color !== undefined) cleaned.color = cfg.color;
  return JSON.stringify(cleaned);
}

/** Notifications: delivery channels (Telegram, Discord, Slack, ntfy, Gotify, Pushover, Lark, email, webhook). */
export function NotificationsSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const channels = useQuery({ queryKey: ['notif-channels'], queryFn: () => api.notifications.listChannels() });
  const [showChannel, setShowChannel] = useState(false);
  const removeChannel = useMutation({ mutationFn: (id: number) => api.notifications.removeChannel(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['notif-channels'] }) });
  const testChannel = useMutation({ mutationFn: (id: number) => api.notifications.testChannel(id), onSuccess: () => toast('Test sent!', 'success'), onError: () => toast('Test failed', 'error') });
  // Channel editing: toggle active / rename / adjust the event filter
  // and, for Discord channels, edit the embed options (username,
  // avatar URL, title, color). The embed fields live inside the
  // `config_json` blob the server stores — PR #24 added the column
  // and the schema; PR #34 (this one) wires the panel.
  type EditableChannel = {
    id: number;
    name: string;
    eventFilter: string;
    discord: DiscordChannelConfig;
  };
  const [editChannel, setEditChannel] = useState<EditableChannel | null>(null);
  const updateChannel = useMutation({
    mutationFn: (input: { id: number; name?: string; eventFilter?: string; active?: boolean; configJson?: string | null }) => {
      const { id, ...patch } = input;
      return api.notifications.updateChannel(id, patch);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notif-channels'] });
      setEditChannel(null);
    },
    onError: () => toast('Could not update the channel', 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Notifications</h2>
          <Button size="sm" variant="secondary" onClick={() => setShowChannel(true)}>+ Add channel</Button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Get notified on deploy, alert, database, domain, backup events via Telegram, Discord, Slack, ntfy, Gotify, Pushover, Lark, email, or any webhook.
        </p>
        {showChannel && <NotificationWizard onClose={() => setShowChannel(false)} />}
        <div className="space-y-1.5">
          {channels.data?.map((ch) => (
            <div key={ch.id}>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5">
                <div className="flex items-center gap-2">
                  <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase', ch.type === 'telegram' || ch.type === 'lark' ? 'bg-sky-500/15 text-sky-300' : ch.type === 'discord' ? 'bg-indigo-500/15 text-indigo-300' : ch.type === 'gotify' ? 'bg-fuchsia-500/15 text-fuchsia-300' : ch.type === 'pushover' ? 'bg-blue-500/15 text-blue-300' : ch.type === 'ntfy' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300')}>{ch.type}</span>
                  <span className="text-sm text-slate-200">{ch.name}</span>
                  {ch.eventFilter && <span className="font-mono text-[10px] text-slate-500">{ch.eventFilter}</span>}
                  {!ch.active && <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] text-slate-400">paused</span>}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button"
                    onClick={() => updateChannel.mutate({ id: ch.id, active: !ch.active })}
                    className={cn('rounded p-1.5 hover:bg-white/5', ch.active ? 'text-emerald-400' : 'text-slate-500')}
                    title={ch.active ? 'Pause (deactivate)' : 'Activate'}
                  >
                    {ch.active ? <CirclePause size={13} /> : <CirclePlay size={13} />}
                  </button>
                  <button type="button" onClick={() => testChannel.mutate(ch.id)} className="rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-emerald-300" title="Send test"><Send size={13} /></button>
                  <button type="button" onClick={() => setEditChannel({ id: ch.id, name: ch.name, eventFilter: ch.eventFilter ?? '', discord: parseDiscordConfig(ch.configJson) })} className="rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-indigo-300" title="Edit"><Pencil size={13} /></button>
                  <button type="button" onClick={() => removeChannel.mutate(ch.id)} className="rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-rose-400" title="Remove"><Trash2 size={13} /></button>
                </div>
              </div>
              {editChannel !== null && editChannel.id === ch.id && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    updateChannel.mutate({
                      id: ch.id,
                      name: editChannel.name.trim() || ch.name,
                      eventFilter: editChannel.eventFilter,
                      configJson: ch.type === 'discord' ? serializeDiscordConfig(editChannel.discord) : null,
                    });
                  }}
                  className="mt-1.5 space-y-2 rounded-lg bg-indigo-500/[0.04] px-3 py-2 ring-1 ring-inset ring-indigo-500/20"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input value={editChannel.name} onChange={(e) => setEditChannel({ ...editChannel, name: e.target.value })} placeholder="name" className="h-7 w-32 text-xs" aria-label="Channel name" />
                    <Input value={editChannel.eventFilter} onChange={(e) => setEditChannel({ ...editChannel, eventFilter: e.target.value })} placeholder="event filter (empty = all)" className="h-7 w-56 font-mono text-xs" aria-label="Event filter" />
                  </div>
                  {ch.type === 'discord' && (
                    <div className="rounded-md border border-indigo-500/20 bg-indigo-500/[0.04] p-2">
                      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-indigo-300">Discord embed</div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Input
                          value={editChannel.discord.title ?? ''}
                          onChange={(e) => setEditChannel({ ...editChannel, discord: { ...editChannel.discord, title: e.target.value } })}
                          placeholder="embed title (e.g. Deploy completed)"
                          className="h-7 w-full text-xs"
                          aria-label="Embed title"
                        />
                        <Input
                          value={editChannel.discord.username ?? ''}
                          onChange={(e) => setEditChannel({ ...editChannel, discord: { ...editChannel.discord, username: e.target.value } })}
                          placeholder="username override"
                          className="h-7 w-full text-xs"
                          aria-label="Webhook username"
                        />
                        <Input
                          value={editChannel.discord.avatarUrl ?? ''}
                          onChange={(e) => setEditChannel({ ...editChannel, discord: { ...editChannel.discord, avatarUrl: e.target.value } })}
                          placeholder="avatar URL (https://…)"
                          className="h-7 w-full text-xs"
                          aria-label="Webhook avatar URL"
                        />
                        <Input
                          value={editChannel.discord.color !== undefined ? `#${editChannel.discord.color.toString(16).padStart(6, '0')}` : ''}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            // Accept `#rrggbb` or `rrggbb`; reject everything
                            // else by clearing the value.
                            const m = /^#?([0-9a-fA-F]{6})$/.exec(v);
                            if (!m) {
                              setEditChannel({ ...editChannel, discord: { ...editChannel.discord, color: undefined } });
                              return;
                            }
                            setEditChannel({ ...editChannel, discord: { ...editChannel.discord, color: parseInt(m[1]!, 16) } });
                          }}
                          placeholder="color (#2563eb)"
                          className="h-7 w-full font-mono text-xs"
                          aria-label="Embed color"
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setEditChannel(null)}>Cancel</Button>
                    <Button type="submit" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={updateChannel.isPending}>
                      {updateChannel.isPending ? '…' : 'Save'}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
          {(!channels.data || channels.data.length === 0) && !showChannel && <p className="py-2 text-xs text-slate-600">No notification channels configured.</p>}
        </div>
      </CardBody>
    </Card>
  );
}
