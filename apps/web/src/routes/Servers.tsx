import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Copy,
  FileText,
  HardDrive,
  Key,
  Lock,
  Plus,
  Radio,
  RefreshCw,
  Server as ServerIcon,
  Sparkles,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Link } from 'react-router';
import type { ServerBootstrapResult, ServerSshTestResult } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorCard, Field, Input, Modal, PageHeader, Skeleton, cn } from '../components/ui.js';
import { formatRelative, useCopy } from '../lib/format.js';
import { agentDockerRunCommand } from '@ninedeploy/schemas';
import { useAuth } from '../lib/auth.js';
import { EnrolmentTokenCard, useEnrolmentToken } from '../components/EnrolmentTokenCard.js';

/**
 * Remote server registry (admin). Supports zero-touch SSH auto-onboarding,
 * zero-touch auto-discovery announcements, or manual token pairing.
 */
export function Servers() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [addMode, setAddMode] = useState<'ssh' | 'manual'>('ssh');
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);

  // Manual pairing state
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('4600');
  const [revealed, setRevealed] = useState<{ token: string; tokenSha256: string; agentCommand: string } | null>(null);
  const { copied, copy } = useCopy();
  const { copied: autoCopied, copy: autoCopy } = useCopy();
  const [cmdTab, setCmdTab] = useState<'docker' | 'npx'>('docker');

  // SSH Onboarding Form State
  const [sshName, setSshName] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [authType, setAuthType] = useState<'key' | 'password'>('key');
  const [sshKey, setSshKey] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [installDocker, setInstallDocker] = useState(true);
  const [agentPort, setAgentPort] = useState('4600');

  // SSH Test Probe Feedback State
  const [probeResult, setProbeResult] = useState<ServerSshTestResult | null>(null);

  // Live Bootstrap Stepper & Log Modal State
  const [bootstrapRunning, setBootstrapRunning] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<ServerBootstrapResult | null>(null);
  const [activeLogServer, setActiveLogServer] = useState<{ id: number; name: string } | null>(null);

  const list = useQuery({ queryKey: ['servers'], queryFn: () => api.servers.list() });

  const create = useMutation({
    mutationFn: () => api.servers.create({ name, host, port: Number(port) || 4600 }),
    onSuccess: (res) => {
      setRevealed({ token: res.token, tokenSha256: res.tokenSha256, agentCommand: res.agentCommand });
      setOpen(false);
      setName('');
      setHost('');
      setPort('4600');
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast('Server registered — copy the agent token now', 'success');
    },
    onError: () => toast('Could not register the server', 'error'),
  });

  const sshTestMutation = useMutation({
    mutationFn: () =>
      api.servers.sshTest({
        host: sshHost,
        sshPort: Number(sshPort) || 22,
        sshUser: sshUser || 'root',
        authType,
        sshKey: authType === 'key' ? sshKey : undefined,
        sshPassword: authType === 'password' ? sshPassword : undefined,
      }),
    onSuccess: (res) => {
      setProbeResult(res);
      if (res.ok) {
        toast(`SSH probe successful (${res.latencyMs}ms)`, 'success');
      } else {
        toast(res.message, 'error');
      }
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'SSH probe failed';
      setProbeResult({ ok: false, message: msg });
      toast(msg, 'error');
    },
  });

  const sshBootstrapMutation = useMutation({
    mutationFn: () =>
      api.servers.sshBootstrap({
        name: sshName,
        host: sshHost,
        sshPort: Number(sshPort) || 22,
        sshUser: sshUser || 'root',
        authType,
        sshKey: authType === 'key' ? sshKey : undefined,
        sshPassword: authType === 'password' ? sshPassword : undefined,
        installDocker,
        agentPort: Number(agentPort) || 4600,
      }),
    onMutate: () => {
      setBootstrapRunning(true);
      setBootstrapResult(null);
    },
    onSuccess: (res) => {
      setBootstrapRunning(false);
      setBootstrapResult(res);
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast(`Server "${sshName}" successfully onboarded!`, 'success');
    },
    onError: (err) => {
      setBootstrapRunning(false);
      const msg = err instanceof Error ? err.message : 'Bootstrap failed';
      setBootstrapResult({
        ok: false,
        error: msg,
        steps: [
          {
            step: 'error',
            status: 'failed',
            message: msg,
            timestamp: new Date().toISOString(),
          },
        ],
        logs: [`[FATAL] ${msg}`],
      });
      toast(msg, 'error');
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.servers.remove(id, { force: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast('Server removed', 'success');
    },
    onError: () => toast('Could not remove the server', 'error'),
  });

  const test = useMutation({
    mutationFn: (id: number) => api.servers.test(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast('Agent reachable — marked online', 'success');
    },
    onError: () => toast('Agent unreachable', 'error'),
  });

  const approve = useMutation({
    mutationFn: (id: number) => api.servers.approve(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast('Server approved and connected to cluster', 'success');
    },
    onError: (err) => toast(`Approval failed: ${err instanceof Error ? err.message : 'unreachable'}`, 'error'),
  });

  const reject = useMutation({
    mutationFn: (id: number) => api.servers.reject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast('Server rejected', 'success');
    },
    onError: () => toast('Could not reject server', 'error'),
  });

  const serverLogsQuery = useQuery({
    queryKey: ['server-logs', activeLogServer?.id],
    queryFn: () => api.servers.bootstrapLogs(activeLogServer!.id),
    enabled: activeLogServer != null,
  });

  const pendingServers = list.data?.filter((s) => s.status === 'pending') ?? [];
  const registeredServers = list.data?.filter((s) => s.status !== 'pending') ?? [];

  const masterOrigin = window.location.origin;
  // r175: one builder for every agent command (@ninedeploy/schemas).
  // r359: /announce refuses without the enrolment secret, which the card
  // under the command shows. The command on screen keeps a placeholder (it is
  // a secret); the copied one carries the real token when there is one.
  const enrolment = useEnrolmentToken(isOperator);
  const buildAutoJoin = (enrolmentToken: string) =>
    agentDockerRunCommand({ hostPort: 4600, imageTag: 'latest', masterUrl: masterOrigin, enrolmentToken });
  const autoJoinCommand = buildAutoJoin('<enrolment-token>');
  const autoJoinCopy = buildAutoJoin(enrolment.data?.token ?? '<enrolment-token>');

  // The server returns the exact command for the node it just registered
  // (pinned to the core's release). `@ninedeploy/server` is not published to
  // npm, so the second tab runs the agent from a source checkout instead.
  const dockerCommand = revealed ? revealed.agentCommand : '';
  const npxCommand = revealed
    ? `NINEDEPLOY_AGENT=1 NINEDEPLOY_AGENT_TOKEN=${revealed.tokenSha256} NINEDEPLOY_AGENT_PORT=4600 node apps/server/dist/agent.js`
    : '';
  const activeCommand = cmdTab === 'docker' ? dockerCommand : npxCommand;

  const handleResetSshForm = () => {
    setSshName('');
    setSshHost('');
    setSshPort('22');
    setSshUser('root');
    setAuthType('key');
    setSshKey('');
    setSshPassword('');
    setProbeResult(null);
    setOpen(false);
  };

  const totalNodes = (registeredServers.length || 0) + 1; // +1 Master
  const onlineNodes = registeredServers.filter((s) => s.status === 'online').length + 1;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        icon={<ServerIcon size={18} />}
        title="Servers & Cluster"
        subtitle="Remote edge nodes with SSH auto-onboarding. Nodes serve Docker network management today — deploying a service to one is not implemented yet."
      />

      {/* Cluster Capacity Overview */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-4 bg-slate-900/60 border-white/[0.08]">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Cluster Nodes</span>
            <ServerIcon size={15} className="text-indigo-400" />
          </div>
          <div className="text-xl font-bold text-slate-100 flex items-baseline gap-2">
            {totalNodes} <span className="text-xs font-normal text-slate-400">({onlineNodes} healthy)</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            1 Primary Master + {registeredServers.length} Edge Nodes
          </div>
        </Card>

        <Card className="p-4 bg-slate-900/60 border-white/[0.08]">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Edge Infrastructure</span>
            <HardDrive size={15} className="text-blue-400" />
          </div>
          <div className="text-xl font-bold text-slate-100 flex items-baseline gap-2">
            {registeredServers.length} <span className="text-xs font-normal text-slate-400">registered</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            SSH Automated & Auto-Discovery
          </div>
        </Card>

        <Card className="p-4 bg-slate-900/60 border-white/[0.08]">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Cluster Health</span>
            <CheckCircle2 size={15} className="text-emerald-400" />
          </div>
          <div className="text-xl font-bold text-emerald-400 flex items-baseline gap-2">
            {Math.round((onlineNodes / totalNodes) * 100)}%
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            Traefik Auto-Proxy & Mesh Active
          </div>
        </Card>
      </div>

      {/* Auto-Join Quick Instructions Banner */}
      <Card className="border-indigo-500/20 bg-indigo-500/[0.03]">
        <div className="p-5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <Sparkles className="text-indigo-400" size={16} />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                Zero-Touch Auto-Join Command
              </h3>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void autoCopy(autoJoinCopy)}
              className="text-xs h-7"
            >
              <Copy size={12} className="mr-1" />
              {autoCopied ? 'Copied Auto-Join Command!' : 'Copy Auto-Join Command'}
            </Button>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Run this single command on any remote VPS / edge server. It will automatically announce itself to this NineDeploy instance and show up below for 1-click approval:
          </p>
          <code className="block break-all rounded-lg bg-black/40 p-3 font-mono text-[11px] text-indigo-200/90 ring-1 ring-white/5">
            {autoJoinCommand}
          </code>
          <p className="mt-2 text-[11px] text-slate-500">
            <code className="text-indigo-300">&lt;enrolment-token&gt;</code> is the enrolment token below — the copy
            button fills it in. Without one, announcing nodes are refused.
          </p>
          {isOperator && <EnrolmentTokenCard />}
        </div>
      </Card>

      {/* Discovery & Pending Approval Section */}
      {pendingServers.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/[0.04]">
          <div className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <Radio className="text-amber-400 animate-pulse" size={18} />
              <h3 className="text-sm font-semibold text-amber-200">
                Discovered Nodes Pending Approval ({pendingServers.length})
              </h3>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              The following remote servers announced themselves and are requesting to join the cluster. Verify the host address before approving:
            </p>
            <div className="space-y-3">
              {pendingServers.map((s) => (
                <div key={s.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-slate-900/80 p-3.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-100">{s.name}</span>
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
                        Pending Approval
                      </span>
                    </div>
                    <p className="font-mono text-xs text-slate-400 mt-0.5">
                      {s.host}:{s.port}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => approve.mutate(s.id)}
                      disabled={approve.isPending}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      <CheckCircle2 size={14} className="mr-1" />
                      {approve.isPending ? 'Verifying…' : 'Approve & Connect'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => reject.mutate(s.id)}
                      disabled={reject.isPending}
                    >
                      <XCircle size={14} className="mr-1" />
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {revealed && (
        <Card className="border-amber-500/30">
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-amber-200">
                Copy these now — the agent token is shown only once. Run this on the target host:
              </p>
              <div className="flex rounded-lg bg-black/40 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setCmdTab('docker')}
                  className={cn('rounded px-2.5 py-1 transition', cmdTab === 'docker' ? 'bg-indigo-500 text-white font-medium' : 'text-slate-400 hover:text-slate-200')}
                >
                  Docker (Recommended)
                </button>
                <button
                  type="button"
                  onClick={() => setCmdTab('npx')}
                  className={cn('rounded px-2.5 py-1 transition', cmdTab === 'npx' ? 'bg-indigo-500 text-white font-medium' : 'text-slate-400 hover:text-slate-200')}
                >
                  Node (source checkout)
                </button>
              </div>
            </div>

            <code className="block break-all rounded bg-black/40 p-3 font-mono text-[11px] text-amber-100 ring-1 ring-white/5">
              {activeCommand}
            </code>

            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copy(activeCommand)}>
                {copied ? 'Copied!' : 'Copy command'}
              </Button>
              <button type="button" onClick={() => setRevealed(null)} className="text-xs text-amber-200/70 hover:underline">
                Done
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Add Server Onboarding Wizard Card */}
      {open && (
        <Card className="p-5">
          <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAddMode('ssh')}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition',
                  addMode === 'ssh' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white',
                )}
              >
                <Terminal size={14} />
                SSH Zero-Touch Onboarding
              </button>
              <button
                type="button"
                onClick={() => setAddMode('manual')}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition',
                  addMode === 'manual' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white',
                )}
              >
                <HardDrive size={14} />
                Manual Token Registration
              </button>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Close Form
            </button>
          </div>

          {addMode === 'ssh' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (sshName.trim() && sshHost.trim()) {
                  sshBootstrapMutation.mutate();
                }
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Node Name">
                  <Input
                    value={sshName}
                    onChange={(e) => setSshName(e.target.value)}
                    placeholder="production-vps-1"
                    className="h-9 text-xs"
                    required
                  />
                </Field>
                <Field label="Server Host / IP">
                  <Input
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="195.201.45.10"
                    className="h-9 font-mono text-xs"
                    required
                  />
                </Field>
                <Field label="SSH Port">
                  <Input
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    placeholder="22"
                    className="h-9 font-mono text-xs"
                  />
                </Field>
                <Field label="SSH Username">
                  <Input
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="root"
                    className="h-9 font-mono text-xs"
                  />
                </Field>
              </div>

              {/* Authentication Type Selector */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-300">Authentication Method</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setAuthType('key')}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-lg border p-2.5 text-xs font-medium transition',
                      authType === 'key'
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                        : 'border-white/10 text-slate-400 hover:border-white/20',
                    )}
                  >
                    <Key size={14} />
                    SSH Private Key
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthType('password')}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-lg border p-2.5 text-xs font-medium transition',
                      authType === 'password'
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                        : 'border-white/10 text-slate-400 hover:border-white/20',
                    )}
                  >
                    <Lock size={14} />
                    SSH Password
                  </button>
                </div>
              </div>

              {authType === 'key' ? (
                <Field label="SSH Private Key">
                  <textarea
                    value={sshKey}
                    onChange={(e) => setSshKey(e.target.value)}
                    rows={4}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                    className="w-full rounded-lg border border-white/10 bg-black/40 p-2.5 font-mono text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                  />
                </Field>
              ) : (
                <Field label="SSH Password">
                  <Input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="h-9 text-xs"
                  />
                </Field>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Agent Port (Inbound)">
                  <Input
                    value={agentPort}
                    onChange={(e) => setAgentPort(e.target.value)}
                    placeholder="4600"
                    className="h-9 font-mono text-xs"
                  />
                </Field>
                <div className="flex items-center gap-2 pt-6">
                  <input
                    type="checkbox"
                    id="install-docker-checkbox"
                    checked={installDocker}
                    onChange={(e) => setInstallDocker(e.target.checked)}
                    className="h-4 w-4 rounded border-white/20 bg-black/40 text-indigo-600 focus:ring-0"
                  />
                  <label htmlFor="install-docker-checkbox" className="text-xs text-slate-300 select-none">
                    Install Docker if missing (<code className="text-indigo-300">get.docker.com</code>)
                  </label>
                </div>
              </div>

              {/* Probe Result Banner */}
              {probeResult && (
                <div
                  className={cn(
                    'rounded-lg border p-3 text-xs',
                    probeResult.ok
                      ? 'border-emerald-500/30 bg-emerald-500/[0.04] text-emerald-300'
                      : 'border-rose-500/30 bg-rose-500/[0.04] text-rose-300',
                  )}
                >
                  <div className="flex items-center gap-2 font-medium">
                    {probeResult.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                    <span>{probeResult.message}</span>
                  </div>
                  {probeResult.ok && (
                    <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-slate-400">
                      <span>OS: <strong className="text-slate-200">{probeResult.os}</strong></span>
                      <span>Docker: <strong className="text-slate-200">{probeResult.dockerInstalled ? probeResult.dockerVersion : 'Not Installed'}</strong></span>
                      <span>Latency: <strong className="text-slate-200">{probeResult.latencyMs}ms</strong></span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => sshTestMutation.mutate()}
                  disabled={!sshHost.trim() || sshTestMutation.isPending}
                >
                  {sshTestMutation.isPending ? <RefreshCw size={14} className="animate-spin mr-1" /> : <Sparkles size={14} className="mr-1" />}
                  Test SSH Connection
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!sshName.trim() || !sshHost.trim() || sshBootstrapMutation.isPending}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white"
                  >
                    <Terminal size={14} className="mr-1" />
                    Start Automated Onboarding
                  </Button>
                  <button type="button" onClick={handleResetSshForm} className="text-xs text-slate-500 hover:underline">
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() && host.trim()) create.mutate();
              }}
              className="grid grid-cols-1 gap-3 sm:grid-cols-3"
            >
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="edge-1" autoComplete="off" spellCheck={false} className="h-9" />
              </Field>
              <Field label="Host">
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5" autoComplete="off" spellCheck={false} className="h-9 font-mono text-xs" />
              </Field>
              <Field label="Agent port">
                <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" autoComplete="off" className="h-9 font-mono text-xs" />
              </Field>
              <div className="sm:col-span-3 flex gap-2">
                <Button type="submit" size="sm" disabled={!name.trim() || !host.trim() || create.isPending}>
                  {create.isPending ? 'Registering…' : 'Register server'}
                </Button>
                <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500 hover:underline">Cancel</button>
              </div>
            </form>
          )}
        </Card>
      )}

      {/* Connected Servers List Table */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Connected Nodes ({registeredServers.length})</h2>
        <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>
          <Plus size={14} /> {open ? 'Hide form' : 'Add server'}
        </Button>
      </div>

      {list.isLoading ? (
        <Card className="p-5"><Skeleton className="h-10 w-full" /></Card>
      ) : list.isError ? (
        <ErrorCard title="Couldn't load servers" error={list.error} onRetry={() => list.refetch()} />
      ) : registeredServers.length === 0 ? (
        <Card><EmptyState icon={<HardDrive size={26} />} title="No remote servers" hint="Everything deploys on this host. Use SSH Onboarding or run the auto-join command on a node." /></Card>
      ) : (
        <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 font-medium">Server</th>
              <th className="px-5 py-3 font-medium">Address</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {registeredServers.map((s) => (
              <tr key={s.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                <td className="px-5 py-3 font-medium text-slate-200">{s.name}</td>
                <td className="px-5 py-3 font-mono text-xs text-slate-400">{s.host}:{s.port}</td>
                <td className="px-5 py-3">
                  <span className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ring-1 ring-inset',
                    s.status === 'online' ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20' : s.status === 'error' ? 'bg-rose-500/15 text-rose-300 ring-rose-500/20' : 'bg-slate-500/15 text-slate-400 ring-slate-500/20',
                  )}>
                    {s.status}
                    {s.lastSeenAt && <span className="text-[10px] opacity-70">· {formatRelative(s.lastSeenAt)}</span>}
                  </span>
                </td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      to="/monitoring"
                      className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-medium"
                      title="View live metrics"
                    >
                      <Activity size={13} />
                      metrics
                    </Link>
                    <button
                      type="button"
                      onClick={() => setActiveLogServer({ id: s.id, name: s.name })}
                      className="text-xs text-slate-500 hover:text-indigo-300 flex items-center gap-1"
                      title="View bootstrap logs"
                    >
                      <FileText size={13} />
                      logs
                    </button>
                    <button type="button" onClick={() => test.mutate(s.id)} className="text-xs text-slate-500 hover:text-indigo-300" title="Test connectivity">
                      test
                    </button>
                    <button type="button" onClick={() => setPendingDelete({ id: s.id, name: s.name })} className="text-slate-600 transition hover:text-rose-400" title="Remove server">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Real-Time Bootstrap Console Modal */}
      {(bootstrapRunning || bootstrapResult != null) && (
        <Modal
          onClose={() => {
            if (!bootstrapRunning) {
              setBootstrapResult(null);
              handleResetSshForm();
            }
          }}
          title="Zero-Touch Server Onboarding"
        >
          <div className="space-y-4">
            <p className="text-xs text-slate-400">
              Automated provisioning pipeline for node <strong className="text-slate-200">{sshName}</strong> ({sshHost}):
            </p>

            {/* Stepper Progress */}
            {bootstrapResult?.steps && (
              <div className="space-y-2 border border-white/10 rounded-lg p-3 bg-black/20">
                {bootstrapResult.steps.map((st, idx) => (
                  <div key={idx} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      {st.status === 'success' ? (
                        <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                      ) : st.status === 'failed' ? (
                        <XCircle size={14} className="text-rose-400 shrink-0" />
                      ) : (
                        <RefreshCw size={14} className="text-indigo-400 animate-spin shrink-0" />
                      )}
                      <span className={cn(st.status === 'failed' ? 'text-rose-300' : 'text-slate-200')}>
                        {st.message}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-500">{st.step}</span>
                  </div>
                ))}
              </div>
            )}

            {bootstrapRunning && (
              <div className="flex items-center gap-2 p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-xs text-indigo-300">
                <RefreshCw size={15} className="animate-spin shrink-0" />
                <span>Bootstrapping remote server over SSH, installing Docker and NineDeploy Agent…</span>
              </div>
            )}

            {/* Live Terminal Log Viewer */}
            {bootstrapResult?.logs && bootstrapResult.logs.length > 0 && (
              <div className="rounded-lg border border-white/10 bg-black/90 p-3 font-mono text-[11px] text-slate-300 max-h-56 overflow-y-auto space-y-1">
                {bootstrapResult.logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all leading-tight">{l}</div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={bootstrapRunning}
                onClick={() => {
                  setBootstrapResult(null);
                  handleResetSshForm();
                }}
              >
                {bootstrapResult?.ok ? 'Done' : 'Dismiss'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Historical Bootstrap Logs Modal */}
      {activeLogServer != null && (
        <Modal
          onClose={() => setActiveLogServer(null)}
          title={`Bootstrap Logs: ${activeLogServer?.name || ''}`}
        >
          <div className="space-y-3">
            {serverLogsQuery.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : serverLogsQuery.data?.logs && serverLogsQuery.data.logs.length > 0 ? (
              <div className="rounded-lg border border-white/10 bg-black/90 p-3 font-mono text-[11px] text-slate-300 max-h-80 overflow-y-auto space-y-1">
                {serverLogsQuery.data.logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all leading-tight">{l}</div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">No bootstrap execution logs recorded for this node.</p>
            )}
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => setActiveLogServer(null)}>
                Close Logs
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Remove server"
        message={`Remove "${pendingDelete?.name}"? Services already deployed there keep running but can no longer be managed from here.`}
        confirmLabel="Remove"
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
