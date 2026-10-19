import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { toInt } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Field, Input, Select } from '../../components/ui.js';

/** The capabilities the server accepts (`runtimeCapability` in @ninedeploy/schemas), with what each is for. */
export const CAPABILITIES: Array<{ id: string; hint: string }> = [
  { id: 'NET_ADMIN', hint: 'VPN clients, routing, iptables inside the container' },
  { id: 'NET_RAW', hint: 'ping, packet capture' },
  { id: 'SYS_PTRACE', hint: 'debuggers and profilers' },
  { id: 'SYS_NICE', hint: 'realtime priorities (audio, game servers)' },
  { id: 'SYS_RESOURCE', hint: 'raise resource limits' },
  { id: 'IPC_LOCK', hint: 'mlock (Elasticsearch, Vault)' },
  { id: 'SYS_TIME', hint: 'set the clock (NTP servers)' },
];

type Options = NonNullable<Service['runtimeOptions']>;

/** "--gpus all · --shm-size 1024m …" for the read-only view. */
export function describeRuntimeOptions(o: Options | null | undefined): string[] {
  if (!o) return [];
  const out: string[] = [];
  if (o.gpus != null) out.push(o.gpus === 'all' ? 'All GPUs' : `${o.gpus} GPU${o.gpus === 1 ? '' : 's'}`);
  if (o.shmSizeMb != null) out.push(`${o.shmSizeMb} MiB shared memory`);
  if (o.init) out.push('init process');
  if (o.ulimitNofile != null) out.push(`${o.ulimitNofile} open files`);
  for (const cap of o.capAdd ?? []) out.push(cap);
  return out;
}

/**
 * 0.16.1 advanced container options (Coolify's "custom Docker options", as
 * structured fields): GPUs, /dev/shm size, an init process, the open-file
 * limit and a short allowlist of capabilities. Operators edit them; everyone
 * else sees what is set. Docker services only, and only on a panel that
 * reports the field.
 */
export function ContainerOptionsCard({ svc }: { svc: Service }) {
  const { user } = useAuth();
  const operator = user?.isOperator === true;
  const qc = useQueryClient();
  const { toast } = useToast();
  const stored = svc.runtimeOptions ?? null;
  // Initialised once from the service row, like the limits card.
  const [gpus, setGpus] = useState(stored?.gpus != null ? String(stored.gpus) : '');
  const [shm, setShm] = useState(stored?.shmSizeMb != null ? String(stored.shmSizeMb) : '');
  const [init, setInit] = useState(stored?.init === true);
  const [nofile, setNofile] = useState(stored?.ulimitNofile != null ? String(stored.ulimitNofile) : '');
  const [caps, setCaps] = useState<string[]>(stored?.capAdd ?? []);

  const save = useMutation({
    mutationFn: () =>
      api.services.update(svc.id, {
        runtimeOptions: {
          gpus: gpus === '' ? null : gpus === 'all' ? 'all' : toInt(gpus, 1),
          shmSizeMb: shm.trim() ? toInt(shm, 64) : null,
          init,
          ulimitNofile: nofile.trim() ? toInt(nofile, 1024) : null,
          capAdd: caps as NonNullable<Options['capAdd']>,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      toast('Container options saved — applied on the next deploy', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not save the container options', 'error'),
  });

  if (svc.type !== 'docker' || svc.runtimeOptions === undefined) return null;
  const summary = describeRuntimeOptions(stored);

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
          <SlidersHorizontal size={15} className="text-slate-500" /> Container options
        </div>
        <p className="mb-4 text-xs text-slate-500">
          GPUs, shared memory and extra capabilities for this service&apos;s container, applied on the next deploy on the panel
          host, or on a node whose agent is 0.16.6 or newer (not on Swarm). {operator ? 'Only operators can change them.' : 'Set by an operator.'}
        </p>
        {!operator ? (
          <p className="text-xs text-slate-300">{summary.length > 0 ? summary.join(' · ') : 'Docker defaults.'}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="grid grid-cols-1 gap-4 md:grid-cols-4"
          >
            <Field label="GPUs" hint="Needs the NVIDIA container toolkit on the host">
              <Select value={gpus} onChange={(e) => setGpus(e.target.value)} className="h-9" aria-label="GPUs">
                <option value="">None</option>
                <option value="all">All</option>
                {[1, 2, 3, 4, 8].map((n) => (
                  <option key={n} value={String(n)}>{n}</option>
                ))}
              </Select>
            </Field>
            <Field label="Shared memory (MiB)" hint="Docker's default is 64">
              <Input value={shm} onChange={(e) => setShm(e.target.value)} inputMode="numeric" placeholder="64" className="h-9 font-mono text-xs" aria-label="Shared memory (MiB)" />
            </Field>
            <Field label="Open files limit" hint="ulimit nofile, 1024 or more">
              <Input value={nofile} onChange={(e) => setNofile(e.target.value)} inputMode="numeric" placeholder="default" className="h-9 font-mono text-xs" aria-label="Open files limit" />
            </Field>
            <label className="flex cursor-pointer items-center gap-2 self-center text-xs text-slate-300">
              <input type="checkbox" checked={init} onChange={(e) => setInit(e.target.checked)} className="accent-indigo-500" />
              Run an init process (reaps zombies)
            </label>
            <fieldset className="col-span-full">
              <legend className="mb-1.5 text-xs font-medium text-slate-400">Extra capabilities</legend>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {CAPABILITIES.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-start gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={caps.includes(c.id)}
                      onChange={(e) => setCaps((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <span>
                      <span className="font-mono">{c.id}</span> <span className="text-slate-500">— {c.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="col-span-full">
              <Button type="submit" size="sm" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save container options'}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
