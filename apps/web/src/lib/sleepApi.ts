import { apiCall } from './apiCall.js';
import type { ServiceLifecycleResult, ServiceSleepStatus } from '@ninedeploy/sdk';

/**
 * 0.16.11 scale to zero. The idle window itself is saved with the service
 * (`PATCH /v1/services/:id` with `sleepAfterMinutes`); these put a service to
 * sleep, or wake it, by hand. Start and restart wake a sleeping service too.
 */
export const sleepApi = {
  status: (serviceId: number) => apiCall<ServiceSleepStatus>(`/v1/services/${serviceId}/sleep`),
  /** Sleep now, even without `sleepAfterMinutes` (400 `cannot_sleep` says why not, 409 `sleep_failed`). */
  sleep: (serviceId: number) => apiCall<{ ok: boolean; asleep: boolean }>(`/v1/services/${serviceId}/sleep`, 'POST'),
  /** Local wake completes; node wake accepts a durable Start with pending lifecycle state. */
  wake: (serviceId: number) => apiCall<ServiceLifecycleResult>(`/v1/services/${serviceId}/wake`, 'POST'),
};
