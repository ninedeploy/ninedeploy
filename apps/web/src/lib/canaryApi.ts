import type { CanaryStatusView } from '@ninedeploy/schemas';
import { apiCall } from './apiCall.js';

/**
 * 0.16.9 canary releases. The configuration itself is saved with the service
 * (`PATCH /v1/services/:id` with `canary`); these are the calls for a canary
 * in progress. Stopping one is the ordinary deploy cancel.
 */
export const canaryKeys = {
  status: (serviceId: number) => ['service-canary', serviceId] as const,
};

export const canaryApi = {
  /** The canary of the service's deploy in progress, or `{ active: false }`. */
  status: (serviceId: number) => apiCall<CanaryStatusView>(`/v1/services/${serviceId}/canary`),
  /** Skip the remaining steps and send all traffic to the new release now (400 `no_canary` when none runs). */
  promote: (serviceId: number, deploymentId: number) =>
    apiCall<{ ok: true }>(`/v1/services/${serviceId}/deploys/${deploymentId}/canary/promote`, 'POST'),
};
