import type { NineDeployClient } from '@ninedeploy/sdk';

/**
 * G5.2: services whose edits go to the pending changes tray. The settings
 * cards all save through `api.services.update`; while a service is staged,
 * that call stages the edit instead (`installStaging`), so no card needs to
 * know about the tray. The tray card keeps this set in step with the server.
 */
const staged = new Set<number>();
type Listener = () => void;
const listeners = new Set<Listener>();

export function setServiceStaging(serviceId: number, on: boolean): void {
  const had = staged.has(serviceId);
  if (on) staged.add(serviceId);
  else staged.delete(serviceId);
  if (had !== on) for (const l of listeners) l();
}

export const isServiceStaged = (serviceId: number): boolean => staged.has(serviceId);

/** Called after an edit was staged instead of applied (the tray refreshes). */
export function onStaged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Route `services.update` to the tray for staged services. */
export function installStaging(api: NineDeployClient): void {
  // A partial client (a test double) has nothing to wrap.
  if (typeof api.services?.update !== 'function') return;
  const update = api.services.update.bind(api.services);
  api.services.update = (async (id: number, input: Parameters<NineDeployClient['services']['update']>[1]) => {
    if (!staged.has(id)) return update(id, input);
    await api.services.pending.stage(id, input);
    for (const l of listeners) l();
    // Cards read the saved row back: answer with the service as it still is.
    return api.services.get(id);
  }) as NineDeployClient['services']['update'];
}
