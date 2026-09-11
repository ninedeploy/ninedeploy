import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, GitPullRequest, Layers, Server, Settings, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { toInt } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Field, Input, Select, Skeleton, Switch } from '../../components/ui.js';
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
      // Omit empty optional fields so a PATCH never clears values the form left blank.
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
          installCmd: orUndef(f.installCmd),
          buildCmd: orUndef(f.buildCmd),
          startCmd: orUndef(f.startCmd),
          dockerfilePath: orUndef(f.dockerfilePath),
          outputDir: orUndef(f.outputDir),
          // Non-admins never see these fields, so they must not send them
          // either: an omitted key leaves whatever an admin stored intact.
          preDeployCmd: isAdmin ? orUndef(f.preDeployCmd) : undefined,
          postDeployCmd: isAdmin ? orUndef(f.postDeployCmd) : undefined,
          preStopCmd: isAdmin ? orUndef(f.preStopCmd) : undefined,
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
        previewDomainPattern: pattern || undefined,
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
      </CardBody>
    </Card>
  );
}

// ── Resource limits ────────────────────────────────────────────────────────
function LimitsCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Initialized once from the service row — later refetches never fight user edits.
  const [cpu, setCpu] = useState(String(svc.cpuShares || ''));
  const [mem, setMem] = useState(String(svc.memLimitMb || ''));

  const save = useMutation({
    mutationFn: () =>
      api.limits.setService(svc.id, {
        cpuShares: cpu.trim() ? toInt(cpu, 0) : null,
        memLimitMb: mem.trim() ? toInt(mem, 0) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['live-stats-snapshot'] });
      toast('Limits saved — applied on next deploy', 'success');
    },
    onError: () => toast('Could not save limits', 'error'),
  });

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
          <Field label="CPU shares (0 = unlimited)">
            <Input value={cpu} onChange={(e) => setCpu(e.target.value)} inputMode="numeric" className="h-9 w-44 font-mono text-xs" />
          </Field>
          <Field label="Memory limit MiB (0 = unlimited)">
            <Input value={mem} onChange={(e) => setMem(e.target.value)} inputMode="numeric" className="h-9 w-44 font-mono text-xs" />
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save limits'}
          </Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          CPU shares map to Docker's <code className="font-mono">--cpu-shares</code> (max 262144); memory to <code className="font-mono">--memory</code>. Applied on the next deploy.
        </p>
      </CardBody>
    </Card>
  );
}
