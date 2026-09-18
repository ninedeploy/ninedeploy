import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, GitPullRequest, Layers, Server, Settings, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { toInt } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, cn, Field, Input, Select, Skeleton, Switch } from '../../components/ui.js';
import { ServiceTagsCard } from './ServiceTagsCard.js';

/** Service fields, build configuration, lifecycle hooks, PR previews, and resource limits. */
export function SettingsTab({ serviceId, svc }: { serviceId: number; svc: Service }) {
  return (
    <div className="mt-5 space-y-5">
      <SettingsCard serviceId={serviceId} />
      <TagsCard serviceId={serviceId} svc={svc} />
      <PreviewEnvironmentsCard svc={svc} />
      <TargetNodeCard svc={svc} />
      <LimitsCard svc={svc} />
      <ScalingCard svc={svc} />
    </div>
  );
}

/**
 * Project / workspace / label tags for a service. The same component used
 * by the top-bar filter chips, just anchored to a single service. Read-only
 * for non-operators (members can see which tags apply, but not change them).
 */
function TagsCard({ serviceId }: { serviceId: number; svc: Service }) {
  // Fetch the resolved tag rows from the dedicated tags endpoint so the
  // editor sees the same names / slugs / colors the rest of the UI uses.
  // The service detail response is a leaner subset.
  const { data: tags } = useQuery({
    queryKey: ['service-tags', serviceId],
    queryFn: () => api.serviceTags.get(serviceId),
  });
  const initial = {
    projects: (tags?.projects ?? []).map((p) => ({
      id: p.id,
      workspaceId: null as number | null,
      workspaceName: null as string | null,
      name: p.name,
      slug: p.slug,
      description: null as string | null,
      serviceCount: 0,
      databaseCount: 0,
      createdAt: '',
      updatedAt: '',
    })),
    workspaces: (tags?.workspaces ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      description: null as string | null,
      ownerId: 0,
      myRole: 'viewer' as const,
      serviceCount: 0,
      projectCount: 0,
      memberCount: 0,
      createdAt: '',
      updatedAt: '',
    })),
    labels: (tags?.labels ?? []).map((l) => ({
      id: l.id,
      workspaceId: null as number | null,
      name: l.name,
      color: l.color,
      serviceCount: 0,
      createdAt: '',
      updatedAt: '',
    })),
  };
  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center gap-2">
          <Tag size={14} className="text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-200">Tags</h2>
          <span className="text-xs text-slate-500">
            Where this service appears in the workspace, which project groups it, and the labels that classify it.
          </span>
        </div>
        <ServiceTagsCard serviceId={serviceId} initial={initial} />
      </CardBody>
    </Card>
  );
}

// ── Settings (service fields + build config + lifecycle hooks) ─────────────
function SettingsCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.isOperator === true;
  const service = useQuery({ queryKey: ['service', serviceId], queryFn: () => api.services.get(serviceId) });
  // Credential list is admin-only server-side; members see the attached name
  // read-only instead of a select that would 403 on load.
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.sources.list(),
    enabled: isAdmin,
  });
  const svc = service.data;

  // Auto-update is a standalone toggle (not part of the big form): flipping
  // it takes effect immediately, like the server's other watchdogs.
  const autoUpdateMutation = useMutation({
    mutationFn: (enabled: boolean) => api.services.update(serviceId, { autoUpdate: enabled }),
    onSuccess: (_res, enabled) => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      toast(enabled ? 'Auto-update enabled' : 'Auto-update disabled', 'success');
    },
    onError: () => toast('Could not change auto-update', 'error'),
  });

  const [form, setForm] = useState<{
    name: string; branch: string; repoUrl: string; image: string; port: string;
    healthPath: string; volumeMount: string; sourceId: string;
    buildPack: string; baseDir: string; installCmd: string; buildCmd: string; startCmd: string; dockerfilePath: string; outputDir: string;
    preDeployCmd: string; postDeployCmd: string; preStopCmd: string;
    restartPolicy: string; stopGraceSeconds: string;
  } | null>(null);
  useEffect(() => {
    if (!svc || form) return;
    setForm({
      name: svc.name,
      branch: svc.branch,
      repoUrl: svc.repoUrl ?? '',
      image: svc.image ?? '',
      port: svc.port ? String(svc.port) : '',
      healthPath: svc.healthPath ?? '',
      volumeMount: svc.volumeMount ?? '',
      sourceId: svc.sourceId ? String(svc.sourceId) : '',
      buildPack: svc.build?.buildPack ?? 'auto',
      baseDir: svc.build?.baseDir ?? '/',
      installCmd: svc.build?.installCmd ?? '',
      buildCmd: svc.build?.buildCmd ?? '',
      startCmd: svc.build?.startCmd ?? '',
      dockerfilePath: svc.build?.dockerfilePath ?? '',
      outputDir: svc.build?.outputDir ?? '',
      preDeployCmd: svc.build?.preDeployCmd ?? '',
      postDeployCmd: svc.build?.postDeployCmd ?? '',
      preStopCmd: svc.build?.preStopCmd ?? '',
      restartPolicy: svc.build?.restartPolicy ?? 'unless-stopped',
      stopGraceSeconds: String(svc.build?.stopGraceSeconds ?? 5),
    });
  }, [svc, form]);

  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      // Omit empty service fields the schema cannot take blank (repo URL,
      // image, port, health path).
      const orUndef = <T,>(v: T) => (v === '' ? undefined : v);
      return api.services.update(serviceId, {
        name: f.name,
        branch: f.branch,
        repoUrl: orUndef(f.repoUrl),
        image: orUndef(f.image),
        port: orUndef(f.port) ? toInt(f.port) : undefined,
        healthPath: orUndef(f.healthPath),
        volumeMount: orUndef(f.volumeMount),
        // Admins may attach or clear the credential; members keep the current
        // one (an omitted key leaves it untouched server-side).
        sourceId: isAdmin ? (f.sourceId ? toInt(f.sourceId) : null) : undefined,
        build: {
          buildPack: f.buildPack as 'auto' | 'nixpacks' | 'dockerfile' | 'static',
          baseDir: f.baseDir,
          // r205: build fields are prefilled, so a blank one is a deliberate
          // clear — sent as '' (the server stores it as null). They used to
          // be omitted, so a start command or pre-deploy hook, once set, could
          // never be removed from the panel.
          installCmd: f.installCmd,
          buildCmd: f.buildCmd,
          startCmd: f.startCmd,
          dockerfilePath: f.dockerfilePath,
          outputDir: f.outputDir,
          // Non-admins never see these fields, so they must not send them
          // either: an omitted key leaves whatever an admin stored intact.
          preDeployCmd: isAdmin ? f.preDeployCmd : undefined,
          postDeployCmd: isAdmin ? f.postDeployCmd : undefined,
          preStopCmd: isAdmin ? f.preStopCmd : undefined,
          restartPolicy: f.restartPolicy,
          stopGraceSeconds: toInt(f.stopGraceSeconds, 5)!,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast('Settings saved — redeploy to apply', 'success');
    },
    onError: () => toast('Could not save settings', 'error'),
  });

  if (!svc || !form) return <Card><CardBody><Skeleton className="h-40 w-full" /></CardBody></Card>;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Settings size={15} className="text-slate-500" /> Service settings
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
        >
          <Field label="Name"><Input value={form.name} onChange={set('name')} className="h-9" /></Field>
          <Field label="Branch"><Input value={form.branch} onChange={set('branch')} className="h-9" /></Field>
          <Field label="Repo URL"><Input value={form.repoUrl} onChange={set('repoUrl')} placeholder="https://github.com/…" className="h-9 font-mono text-xs" /></Field>
          <Field label="Git credential (private repos)" hint="Used for cloning, analysis and webhook deploys">
            {isAdmin ? (
              <Select value={form.sourceId} onChange={set('sourceId')} className="h-9">
                <option value="">Public / none</option>
                {sources.data?.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.name} ({s.type})</option>
                ))}
              </Select>
            ) : (
              <Input value={svc.sourceName ?? 'public / none'} disabled className="h-9" title="Credentials are managed by admins under System → Sources" />
            )}
          </Field>
          <Field label="Image (image deploys)"><Input value={form.image} onChange={set('image')} placeholder="nginx:latest" className="h-9 font-mono text-xs" /></Field>
          {svc.image && svc.type === 'docker' && (
            <div className="col-span-full flex items-center justify-between gap-3 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
              <div>
                <div className="text-xs font-medium text-slate-300">Auto-update (digest watch)</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  Every 30 minutes the registry is probed; when this image&apos;s tag moved, a normal deployment is
                  queued through the usual health checks{svc.serverId != null ? ' on its node' : ''}. Enabling only
                  sets a baseline — it never deploys by itself.
                </div>
              </div>
              <Switch
                checked={svc.autoUpdate === true}
                onChange={(v) => autoUpdateMutation.mutate(v)}
                disabled={autoUpdateMutation.isPending}
                label="Auto-update"
              />
            </div>
          )}
          <Field label="Container port (Traefik target)"><Input value={form.port} onChange={set('port')} inputMode="numeric" autoComplete="off" placeholder="3000" className="h-9 font-mono text-xs" /></Field>
          <Field label="Health path"><Input value={form.healthPath} onChange={set('healthPath')} placeholder="/" className="h-9 font-mono text-xs" /></Field>
          <Field label="Volume mount"><Input value={form.volumeMount} onChange={set('volumeMount')} placeholder="/app/data" className="h-9 font-mono text-xs" /></Field>

          <div className="col-span-full mt-2 border-t border-white/5 pt-4 text-xs font-medium uppercase tracking-wide text-slate-500">
            Build configuration
          </div>
          <Field label="Build pack">
            <Select value={form.buildPack} onChange={set('buildPack')} className="h-9">
              <option value="auto">auto</option>
              <option value="nixpacks">nixpacks</option>
              <option value="dockerfile">dockerfile</option>
              <option value="static">static</option>
              <option value="railpack">railpack</option>
            </Select>
          </Field>
          <Field label="Base directory"><Input value={form.baseDir} onChange={set('baseDir')} className="h-9 font-mono text-xs" /></Field>
          {form.buildPack === 'static' && (
            <Field label="Output directory" hint="Relative to base directory; served by nginx">
              <Input value={form.outputDir} onChange={set('outputDir')} placeholder="dist" className="h-9 font-mono text-xs" />
            </Field>
          )}
          <Field label="Install command"><Input value={form.installCmd} onChange={set('installCmd')} placeholder="npm ci" className="h-9 font-mono text-xs" /></Field>
          <Field label="Build command"><Input value={form.buildCmd} onChange={set('buildCmd')} placeholder="npm run build" className="h-9 font-mono text-xs" /></Field>
          <Field label="Start command"><Input value={form.startCmd} onChange={set('startCmd')} placeholder="npm start" className="h-9 font-mono text-xs" /></Field>
          {/* The same column names the compose file for a git-repo compose
              service. An inline stack ignores it — it always deploys the YAML
              stored on the service (Compose File tab). */}
          <Field label="Dockerfile / compose file path"><Input value={form.dockerfilePath} onChange={set('dockerfilePath')} placeholder="./Dockerfile" className="h-9 font-mono text-xs" /></Field>

          {/* Lifecycle hooks execute binaries on the HOST (engine/pipeline.ts),
              so the API restricts them to admins. Showing them to a member
              would only produce a 403 on save. */}
          {isAdmin && (
            <>
              <div className="col-span-full mt-2 border-t border-white/5 pt-4 text-xs font-medium uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                <Layers size={13} className="text-indigo-400" /> CI/CD Lifecycle Hooks
              </div>
              <div className="col-span-full rounded-lg border border-white/[0.05] bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-500 space-y-1">
                <p>
                  <span className="font-medium text-slate-300">Order:</span> pre-deploy runs right after the code checkout (before build) · post-deploy
                  runs once the healthcheck passes and the new container is live · pre-stop during old-container shutdown.
                </p>
                <p>
                  Commands run on the HOST inside this service&apos;s repo directory and receive the full runtime env — including managed-database keys
                  (<code className="font-mono text-[10px] text-indigo-200">DATABASE_URL</code>,{" "}
                  <code className="font-mono text-[10px] text-indigo-200">WORDPRESS_DB_*</code>, …). That makes volume/repair one-liners possible, e.g.
                  regenerating a baked config:
                </p>
                <code className="block overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-indigo-200">
                  docker run --rm -v nd-svc-web-html:/data alpine sh -c &quot;rm -f /data/wp-config.php&quot;
                </code>
                <p>
                  Pre-deploy failure <span className="text-slate-300">fails the deploy</span>; post-deploy failure is logged but non-fatal. Everything
                  streams into the deployment log.
                </p>
                <p>Fields take ONE command (argv-style) — wrap compound logic yourself, e.g.{" "}
                  <code className="font-mono text-[10px] text-indigo-200">sh -c &quot;a &amp;&amp; b&quot;</code>.
                </p>
              </div>
              <Field label="Pre-deploy command (e.g. DB migrations)">
                <Input value={form.preDeployCmd} onChange={set('preDeployCmd')} placeholder="npm run db:migrate" className="h-9 font-mono text-xs" />
              </Field>
              <Field label="Post-deploy command (e.g. cache warm-up)">
                <Input value={form.postDeployCmd} onChange={set('postDeployCmd')} placeholder="curl -sSL http://localhost:3000/api/warmup" className="h-9 font-mono text-xs" />
              </Field>
              <Field label="Pre-stop command">
                <Input value={form.preStopCmd} onChange={set('preStopCmd')} placeholder="npm run cleanup" className="h-9 font-mono text-xs" />
              </Field>
            </>
          )}
          <Field label="Restart policy">
            <Select value={form.restartPolicy} onChange={set('restartPolicy')} className="h-9">
              <option value="unless-stopped">unless-stopped</option>
              <option value="always">always</option>
              <option value="on-failure">on-failure</option>
              <option value="on-failure:5">on-failure:5 (loop cap)</option>
              <option value="no">no</option>
            </Select>
          </Field>
          <Field label="Stop grace (seconds)">
            <Input value={form.stopGraceSeconds} onChange={set('stopGraceSeconds')} inputMode="numeric" placeholder="5" className="h-9 font-mono text-xs" />
          </Field>

          <div className="col-span-full">
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            <span className="ml-3 text-xs text-slate-500">Build + runtime changes apply on the next deploy.</span>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// ── Ephemeral PR / MR Preview Environments ─────────────────────────────────
function PreviewEnvironmentsCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(svc.previewDeploymentsEnabled ?? false);
  const [autoDestroy, setAutoDestroy] = useState(svc.previewAutoDestroyOnClose ?? true);
  const [pattern, setPattern] = useState(svc.previewDomainPattern ?? 'pr-{{pr}}-{{slug}}.{{domain}}');
  const [maxActive, setMaxActive] = useState(String(svc.previewMaxActive ?? 5));

  const save = useMutation({
    mutationFn: () =>
      api.services.update(svc.id, {
        previewDeploymentsEnabled: enabled,
        previewAutoDestroyOnClose: autoDestroy,
        // r205: an emptied pattern clears it (null) instead of being dropped.
        previewDomainPattern: pattern || null,
        previewMaxActive: parseInt(maxActive, 10) || 5,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast('PR Preview settings saved', 'success');
    },
    onError: () => toast('Could not save PR preview settings', 'error'),
  });

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <GitPullRequest size={16} className="text-indigo-400" /> Ephemeral PR / MR Preview Deployments
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-slate-700 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-indigo-600 peer-checked:after:translate-x-full peer-focus:outline-none" />
          </label>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Automatically provision isolated preview environments on Pull Request / Merge Request webhooks (GitHub, GitLab, Gitea), and destroy them upon merge or close.
        </p>

        {enabled && (
          <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
            <Field label="Preview Domain Pattern" hint="Variables: {{pr}}, {{slug}}, {{domain}}">
              <Input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="pr-{{pr}}-{{slug}}.{{domain}}"
                className="h-9 font-mono text-xs"
              />
            </Field>
            <Field label="Max Active Previews">
              <Input
                value={maxActive}
                onChange={(e) => setMaxActive(e.target.value)}
                inputMode="numeric"
                placeholder="5"
                className="h-9 font-mono text-xs"
              />
            </Field>
            <div className="col-span-full">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoDestroy}
                  onChange={(e) => setAutoDestroy(e.target.checked)}
                  className="rounded border-white/20 bg-slate-800 text-indigo-500 focus:ring-0"
                />
                Auto-destroy ephemeral preview container and URL when PR is closed / merged
              </label>
            </div>
          </div>
        )}

        <div className="pt-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save PR preview settings'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Target node ────────────────────────────────────────────────────────────
/**
 * Where this service runs: the panel host, or one of the registered nodes.
 *
 * The API has accepted `serverId` on create and update since the fleet feature
 * shipped and the panel offered no way to set it, so multi-node was reachable
 * only from the CLI or a raw API call. Now that a docker service pinned to a
 * node is genuinely built and started there, the field needs a home in the UI.
 *
 * Docker and Compose services can target a node; PM2 cannot, because it is a
 * host process the agent has no operation for. For PM2 the card explains the
 * limit instead of offering a choice that would only fail at deploy time.
 */
function TargetNodeCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  // Docker and Compose both run on a node. PM2 is a host process the agent has
  // no operation for, so offering the choice would only fail at deploy time.
  const remotable = svc.type === 'docker' || svc.type === 'compose';

  // Nodes are an operator-only listing; a member sees the current target as
  // read-only text rather than a select that would 403 on load.
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.servers.list(),
    enabled: isOperator && remotable,
  });

  // Initialised once from the service row so a background refetch never fights
  // an edit in progress.
  const [target, setTarget] = useState(svc.serverId == null ? '' : String(svc.serverId));

  const save = useMutation({
    mutationFn: () => api.services.update(svc.id, { serverId: target === '' ? null : Number(target) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast('Target saved — applied on the next deploy', 'success');
    },
    onError: () => toast('Could not save the target node', 'error'),
  });

  const currentName =
    svc.serverId == null
      ? 'this panel host'
      : (servers.data?.find((s) => s.id === svc.serverId)?.name ?? `node #${svc.serverId}`);

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Server size={15} className="text-slate-500" /> Target node
        </div>

        {!remotable ? (
          <p className="text-xs text-slate-500">
            PM2 services run on this panel host. They are host processes and the node agent has no
            operation for them, so a deploy pinned to a node would be refused. Remote nodes run{' '}
            <code className="font-mono">docker</code> and <code className="font-mono">compose</code>{' '}
            services.
          </p>
        ) : !isOperator ? (
          <p className="text-xs text-slate-500">
            Runs on <span className="text-slate-300">{currentName}</span>. Only an instance operator
            can move a service between hosts.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="flex flex-wrap items-end gap-4"
          >
            <Field label="Runs on">
              <Select
                // `Field` renders its label as a span, not a <label>, so the
                // control carries its own accessible name.
                aria-label="Runs on"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 w-64"
                disabled={servers.isLoading}
              >
                <option value="">This panel host</option>
                {(servers.data ?? []).map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name} ({s.host}) {s.status === 'online' ? '' : `— ${s.status}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save target'}
            </Button>
          </form>
        )}

        {remotable && isOperator ? (
          <p className="mt-2 text-xs text-slate-500">
            A node builds and runs the service itself and terminates TLS for its own domains, so
            point the DNS record at the node — not at this panel. Applied on the next deploy;
            the container on the previous host is not moved for you.
          </p>
        ) : null}

        {isOperator && svc.type === 'docker' && (svc.image || svc.repoUrl) ? (
          <FanoutTargetsCard svc={svc} />
        ) : null}
      </CardBody>
    </Card>
  );
}

// ── Multi-server fan-out ───────────────────────────────────────────────────
export function FanoutTargetsCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api.servers.list() });
  const targets = useQuery({ queryKey: ['fanout-targets', svc.id], queryFn: () => api.fanout.get(svc.id) });
  const [selected, setSelected] = useState<number[] | null>(null);

  const save = useMutation({
    mutationFn: () => api.fanout.set(svc.id, selected ?? targets.data?.map((t) => t.serverId) ?? []),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fanout-targets', svc.id] });
      toast('Fan-out targets saved — applied on the next deploy', 'success');
    },
    onError: () => toast('Could not save the fan-out targets', 'error'),
  });

  const current = selected ?? targets.data?.map((t) => t.serverId) ?? [];
  const candidates = (servers.data ?? []).filter((s) => s.id !== svc.serverId);
  const dirty =
    selected != null &&
    (selected.length !== (targets.data?.length ?? 0) ||
      selected.some((id) => !targets.data?.some((t) => t.serverId === id)));

  const toggle = (id: number) =>
    setSelected(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);

  if ((servers.data ?? []).filter((s) => s.id !== svc.serverId).length === 0 && (targets.data ?? []).length === 0) {
    return null;
  }

  return (
    <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
        <Layers size={15} className="text-slate-500" /> Run on additional nodes
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Each target node runs its own container of this release — the image is pulled there, or a
        Dockerfile repository is built from the same pinned commit. Point the domain's DNS at every
        node you select.
      </p>
      {targets.isLoading || servers.isLoading ? (
        <p className="text-xs text-slate-600">Loading nodes…</p>
      ) : (
        <div className="space-y-1.5">
          {candidates.map((node) => {
            const active = current.includes(node.id);
            const target = targets.data?.find((t) => t.serverId === node.id);
            return (
              <label key={node.id} className="flex items-center gap-2 rounded-lg border border-white/[0.05] px-3 py-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggle(node.id)}
                  className="accent-indigo-500"
                  aria-label={`Fan out to ${node.name}`}
                />
                {node.name}
                {target && (
                  <span className={cn('ml-auto font-mono text-[10px]', target.status === 'running' ? 'text-emerald-400' : 'text-rose-400')}>
                    {target.status}
                  </span>
                )}
              </label>
            );
          })}
          {candidates.length === 0 && <p className="text-xs text-slate-600">No additional nodes registered.</p>}
        </div>
      )}
      {selected != null && dirty && (
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save fan-out targets'}
        </Button>
      )}
    </div>
  );
}

// ── Resource limits ────────────────────────────────────────────────────────
function LimitsCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Limits only reach a container on the docker run path. PM2 services are
  // host processes (memory maps to a restart threshold, CPU not enforceable);
  // compose services take their limits from the stack's own YAML.
  const isDocker = svc.type === 'docker';
  // Initialized once from the service row — later refetches never fight user edits.
  const [cpu, setCpu] = useState(String(svc.cpuShares || ''));
  // Stored in millicores (500 = 0.5 cores); the field takes decimal cores.
  const [cpuCap, setCpuCap] = useState(svc.cpuLimitMilli ? String(svc.cpuLimitMilli / 1000) : '');
  const [mem, setMem] = useState(String(svc.memLimitMb || ''));

  const save = useMutation({
    mutationFn: () => {
      const capCores = cpuCap.trim() ? Number(cpuCap.replace(',', '.')) : null;
      return api.limits.setService(svc.id, {
        cpuShares: isDocker && cpu.trim() ? toInt(cpu, 0) : null,
        cpuLimitMilli: isDocker && capCores != null && Number.isFinite(capCores) && capCores > 0 ? Math.round(capCores * 1000) : null,
        memLimitMb: mem.trim() ? toInt(mem, 0) : null,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['live-stats-snapshot'] });
      toast(res.liveApplied ? 'Limits saved and applied to the running container' : 'Limits saved — applied on next deploy', 'success');
    },
    onError: () => toast('Could not save limits', 'error'),
  });

  if (svc.type === 'compose') {
    return (
      <Card>
        <CardBody>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
            <Cpu size={15} className="text-slate-500" /> Resource limits
          </div>
          <p className="text-xs text-slate-500">
            A compose stack manages its own containers — set resource limits under the service's{' '}
            <code className="font-mono">deploy.resources.limits</code> block in the stack YAML.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Cpu size={15} className="text-slate-500" /> Resource limits
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="flex flex-wrap items-end gap-4"
        >
          {isDocker && (
            <>
              <Field label="CPU limit cores (0 = no cap)">
                <Input value={cpuCap} onChange={(e) => setCpuCap(e.target.value)} inputMode="decimal" placeholder="e.g. 0.5" className="h-9 w-44 font-mono text-xs" />
              </Field>
              <Field label="CPU shares (weight under contention)">
                <Input value={cpu} onChange={(e) => setCpu(e.target.value)} inputMode="numeric" className="h-9 w-44 font-mono text-xs" />
              </Field>
            </>
          )}
          <Field label="Memory limit MiB (0 = unlimited)">
            <Input value={mem} onChange={(e) => setMem(e.target.value)} inputMode="numeric" className="h-9 w-44 font-mono text-xs" />
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save limits'}
          </Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          {isDocker ? (
            <>
              CPU limit maps to Docker's <code className="font-mono">--cpus</code> (a hard cap, e.g. 0.5 = half a core); shares map to{' '}
              <code className="font-mono">--cpu-shares</code> (a relative weight, default 1024 — they matter only when the host is
              contended); memory to <code className="font-mono">--memory</code> with swap pinned to the same value. Running containers
              get the new limits live where Docker allows it.
            </>
          ) : (
            <>
              PM2 processes run on the host — the memory limit maps to pm2's{' '}
              <code className="font-mono">max_memory_restart</code> (the process restarts gracefully above it, Docker-style hard
              caps do not apply). Applied on the next deploy.
            </>
          )}
        </p>
      </CardBody>
    </Card>
  );
}

// ── Horizontal scaling ─────────────────────────────────────────────────────
function ScalingCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [replicas, setReplicas] = useState(String(svc.replicas ?? 1));

  const save = useMutation({
    mutationFn: (count: number) => api.services.update(svc.id, { replicas: count }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast('Replicas saved — applied on next deploy', 'success');
    },
    onError: () => toast('Could not save replicas', 'error'),
  });

  if (svc.type !== 'docker') {
    return null;
  }

  const desired = Math.max(1, Math.min(Math.floor(Number(replicas)) || 1, 10));

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Layers size={15} className="text-slate-500" /> Scaling
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(desired);
          }}
          className="flex flex-wrap items-end gap-4"
        >
          <Field label="Replicas (1-10)">
            <Input
              value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              inputMode="numeric"
              className="h-9 w-44 font-mono text-xs"
            />
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={save.isPending || desired === (svc.replicas ?? 1)}>
            {save.isPending ? 'Saving…' : 'Save replicas'}
          </Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          Each replica is a full container of the deployed release on the service bridge; Traefik
          round-robins across them and health-checks each one (a dead replica stops receiving
          traffic instead of erroring). New replicas start on the next deploy; crashed ones are
          revived automatically.
        </p>
      </CardBody>
    </Card>
  );
}
