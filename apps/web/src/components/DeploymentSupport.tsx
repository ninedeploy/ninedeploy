import type { ServerListEntry } from '@ninedeploy/sdk';

/** Availability for plain Docker workloads; Compose and Swarm differ. */
export function DeploymentSupport({ node }: { node?: ServerListEntry }) {
  const features: Array<[string, boolean | undefined]> = [
    ['HTTP/TCP readiness', node ? node.features?.readinessProbe : true],
    ['Log drains', node ? node.features?.logDrains : true],
    ['Canary releases', !node],
    ['Autoscaling', !node],
    ['Scale to zero', !node],
    ['Container file browser', !node],
  ];
  return (
    <section className="mt-3 rounded-lg border border-white/10 p-3 text-xs" aria-label="Deployment support">
      <p className="mb-2 font-medium text-slate-300">Docker features on {node?.name ?? 'this panel host'}</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {features.map(([name, supported]) => (
          <div key={name} className="flex items-center justify-between gap-2">
            <dt className="text-slate-400">{name}</dt>
            <dd className={supported ? 'text-emerald-300' : 'text-slate-500'}>
              {supported === undefined ? 'Not reported' : supported ? 'Available' : 'Unavailable'}
            </dd>
          </div>
        ))}
      </dl>
      {node && <p className="mt-2 text-[11px] text-slate-500">Readiness and log drains require an updated agent. Canary, autoscaling, scale to zero and the file browser currently run on the panel host.</p>}
    </section>
  );
}
