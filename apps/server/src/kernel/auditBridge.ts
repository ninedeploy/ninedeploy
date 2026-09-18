import type { AppEvent } from '../lib/events.js';
import type { DomainEvents, IEventBus } from './types.js';

/**
 * Bridge the real application event stream into the kernel's event bus.
 *
 * Why this exists
 * ---------------
 * NineDeploy carried two unrelated event buses:
 *
 *   • `lib/events.ts` — the REAL one. `audit()` publishes to it on every
 *     meaningful state change, and the `/v1/events` WebSocket serves it to the
 *     dashboard.
 *   • `kernel/eventBus.ts` — the typed one plugins subscribe to. **Nothing
 *     ever emitted into it.** The three built-in plugins that ship enabled
 *     listened for `deployment.status_changed`, `service.health_changed` and
 *     `backup.completed`; no code anywhere emitted any of those names, so the
 *     plugins ran on every install and did precisely nothing.
 *
 * Rather than sprinkle `kernel.events.emit(...)` calls through 51 route modules
 * and the deploy engine — which would drift the moment someone adds a route —
 * this subscribes ONCE to the audit stream that already sees everything, and
 * translates it.
 *
 * Every bridged event is published twice on purpose:
 *   1. as `audit.recorded`, the raw firehose, so a plugin can observe anything
 *      without this module needing to know about it, and
 *   2. as a typed domain event, when the action maps unambiguously.
 *
 * What this deliberately does NOT do: deliver notifications. `audit()` already
 * calls `lib/notifier.notifyEvent`, which owns channel delivery, retries and
 * the delivery log. The kernel's notifications plugin re-emits
 * `notification.queued` as an EXTENSION POINT for other plugins — wiring it
 * back into the notifier would send every alert twice.
 */

/** The typed event (if any) an audit action corresponds to. */
export interface MappedEvent {
  name: keyof DomainEvents;
  payload: DomainEvents[keyof DomainEvents];
}

/** First path segment of an audit entity, e.g. "web #3" -> "web". */
function entityName(entity: string | null): string {
  return (entity ?? '').split('#')[0]?.trim() ?? '';
}

/** Trailing `#<number>` in an audit entity, when present. */
function entityId(entity: string | null): number | undefined {
  const m = /#(\d+)/.exec(entity ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Translate one audit action into the typed domain event plugins listen for.
 *
 * Returns `null` for actions with no unambiguous mapping — those still reach
 * plugins through `audit.recorded`. Kept pure and exported so the mapping is
 * testable without a running kernel.
 */
export function mapAuditToDomainEvent(event: AppEvent): MappedEvent | null {
  const { action, entity } = event;

  // Deploy lifecycle. The routes record deploy.trigger / deploy.rollback /
  // deploy.cancel; `engine/pipeline.ts` records the OUTCOME — deploy.success /
  // deploy.failed / deploy.cancelled — as `"<service name> #<deployment id>"`,
  // which is what `entityName`/`entityId` below decompose. Any future
  // `deploy.*` action maps here automatically.
  if (action.startsWith('deploy.')) {
    return {
      name: 'deployment.status_changed',
      payload: {
        status: action.slice('deploy.'.length),
        serviceName: entityName(entity),
        ...(entityId(entity) === undefined ? {} : { deploymentId: entityId(entity) }),
      },
    } as MappedEvent;
  }

  // Service lifecycle that maps onto a health-ish transition.
  if (action === 'service.stop' || action === 'service.start' || action === 'service.restart') {
    return {
      name: 'service.health_changed',
      payload: {
        status: action.slice('service.'.length),
        ...(entityId(entity) === undefined ? {} : { serviceId: entityId(entity) }),
      },
    } as MappedEvent;
  }

  // r242: the runtime reconcile records a service it could not revive. This
  // is the one failure transition, and the only `service.health_changed` the
  // notifications plugin raises an alert for.
  if (action === 'alert.service_down') {
    return {
      name: 'service.health_changed',
      payload: {
        status: 'dead',
        ...(entityId(entity) === undefined ? {} : { serviceId: entityId(entity) }),
      },
    } as MappedEvent;
  }

  if (action === 'backup.create') {
    return { name: 'backup.completed', payload: {} } as MappedEvent;
  }

  if (action === 'alert.fired' || action === 'alert.recovered') {
    return {
      name: 'alert.triggered',
      payload: {
        title: action === 'alert.fired' ? 'Alert firing' : 'Alert recovered',
        message: entity ?? '',
        level: action === 'alert.fired' ? 'error' : 'info',
      },
    } as MappedEvent;
  }

  return null;
}

/**
 * Subscribe the kernel bus to the audit stream. Returns the unsubscribe
 * function so `plugins/kernel.ts` can detach on shutdown.
 *
 * `subscribe` is passed in rather than imported so the bridge can be tested
 * against a stub instead of the process-wide singleton.
 */
export function bridgeAuditEvents(
  subscribe: (cb: (event: AppEvent) => void) => () => void,
  events: IEventBus,
): () => void {
  return subscribe((event) => {
    // The raw firehose. A plugin that wants "everything" subscribes here
    // instead of asking for a new mapping.
    events.emit('audit.recorded', {
      action: event.action,
      entity: event.entity,
      actorUserId: event.actorUserId,
      ts: event.ts,
    });
    const mapped = mapAuditToDomainEvent(event);
    // The bus already isolates listener errors, so a badly-behaved plugin
    // cannot break the audit path this rides on.
    if (mapped) events.emit(mapped.name, mapped.payload as never);
  });
}
