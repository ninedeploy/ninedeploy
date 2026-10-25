import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';

/**
 * Cancelling a running deploy used to flip its row to `cancelled` and nothing
 * else: the pipeline noticed at its next checkpoint, and the checkpoints sit
 * BETWEEN steps. A cancel during `docker build` waited for the build (up to the
 * 30-minute exec timeout), a cancel during a local healthcheck waited for the
 * whole health deadline — and the worker holds every queued deploy of the
 * service until the old pipeline exits (r272), so the queue looked dead.
 *
 * Each pipeline run executes inside a scope keyed by its deployment id. Every
 * child exec.ts starts inside that scope is tracked, and
 * {@link abortDeployment} tree-kills the ones running at that moment. Children
 * started AFTER the abort are left alone on purpose: they are the failure
 * path's cleanup (`docker rm` of the candidate, the rollback probe), which
 * must run to completion. Polling loops check {@link deployAborted}.
 */
interface DeployScope {
  deploymentId: number;
  aborted: boolean;
  /** Running children and how each must be killed (exec.ts kills the process group). */
  children: Map<ChildProcess, Kill>;
  /** Fires on abort: cuts an in-flight agent request, which the agent answers by killing the op. */
  controller: AbortController;
}

/**
 * Node ops a cancel may cut mid-way. The agent kills their child when the
 * panel's request goes away (agent.ts `/agent/exec`); everything else — the
 * container lifecycle, file writes, compose bring-up — runs to completion so
 * a half-applied state change never outlives the request that made it.
 */
export const CANCELLABLE_AGENT_OPS: ReadonlySet<string> = new Set([
  'docker.build',
  'build.nixpacks',
  'build.railpack',
  'docker.pull',
  'docker.composePull',
  'docker.push',
  'git.fetch',
]);

/** Advertised in `agent.ping` by an agent that kills a {@link CANCELLABLE_AGENT_OPS} op whose request was dropped. */
export const AGENT_CAP_OP_CANCEL = 'op.cancel';

type Kill = (child: ChildProcess, signal: NodeJS.Signals) => void;

const storage = new AsyncLocalStorage<DeployScope>();
const scopes = new Map<number, DeployScope>();

/** Grace between SIGTERM and SIGKILL for an aborted deploy's children. */
const ABORT_KILL_GRACE_MS = 5_000;

export function runInDeployScope<T>(deploymentId: number, fn: () => Promise<T>): Promise<T> {
  const scope: DeployScope = { deploymentId, aborted: false, children: new Map(), controller: new AbortController() };
  scopes.set(deploymentId, scope);
  return storage.run(scope, fn).finally(() => {
    if (scopes.get(deploymentId) === scope) scopes.delete(deploymentId);
  });
}

/** True once the running deploy this code belongs to was cancelled. */
export function deployAborted(): boolean {
  return storage.getStore()?.aborted === true;
}

/**
 * The running deploy's abort signal, for a request it starts now — undefined
 * outside a deploy and once it was aborted (the failure path's own requests
 * must not be cut, like children started after the abort).
 */
export function deployAbortSignal(): AbortSignal | undefined {
  const scope = storage.getStore();
  return scope && !scope.aborted ? scope.controller.signal : undefined;
}

/**
 * Run `fn` outside the deploy's scope: the failure path's probe of the
 * PREVIOUS runtime must not be cut short by the cancel that got it there.
 */
export function outsideDeployScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.exit(fn);
}

/** exec.ts: register a child started by the current deploy. */
export function trackDeployChild(child: ChildProcess, kill: Kill): void {
  const scope = storage.getStore();
  if (!scope || scope.aborted) return;
  scope.children.set(child, kill);
  child.once('close', () => scope.children.delete(child));
  child.once('error', () => scope.children.delete(child));
}

/**
 * Stop the steps a running deploy is executing right now. Returns false when
 * no pipeline of that id runs in this process (a queued row, or a run that
 * already ended).
 */
export function abortDeployment(deploymentId: number): boolean {
  const scope = scopes.get(deploymentId);
  if (!scope) return false;
  scope.aborted = true;
  for (const [child, kill] of scope.children) {
    kill(child, 'SIGTERM');
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) kill(child, 'SIGKILL');
    }, ABORT_KILL_GRACE_MS);
    t.unref();
  }
  scope.children.clear();
  scope.controller.abort(new Error('Deployment cancelled'));
  return true;
}
