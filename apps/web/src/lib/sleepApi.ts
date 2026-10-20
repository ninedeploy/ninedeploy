import { apiCall } from './apiCall.js';

/**
 * 0.16.11 scale to zero. The idle window itself is saved with the service
 * (`PATCH /v1/services/:id` with `sleepAfterMinutes`); these put a service to
 * sleep, or wake it, by hand. Start and restart wake a sleeping service too.
 */
export const sleepApi = {
  /** Sleep now, even without `sleepAfterMinutes` (400 `cannot_sleep` says why not, 409 `sleep_failed`). */
  sleep: (serviceId: number) => apiCall<{ ok: boolean; asleep: boolean }>(`/v1/services/${serviceId}/sleep`, 'POST'),
  /** Start the containers and route the domains back (400 `not_asleep`, 409 `wake_failed`). */
  wake: (serviceId: number) => apiCall<{ ok: boolean; status: string }>(`/v1/services/${serviceId}/wake`, 'POST'),
};
