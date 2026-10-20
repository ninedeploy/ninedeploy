import type { AutoscaleStatusView } from '@ninedeploy/schemas';
import { apiCall } from './apiCall.js';

/**
 * 0.16.10 autoscaling. The configuration itself is saved with the service
 * (`PATCH /v1/services/:id` with `autoscale`); this is what the autoscaler
 * sees and did last.
 */
export const autoscaleKeys = {
  status: (serviceId: number) => ['service-autoscale', serviceId] as const,
};

export const autoscaleApi = {
  /** Containers serving now, and with autoscaling on its bounds, last value, desired count, hold reason and last change. */
  status: (serviceId: number) => apiCall<AutoscaleStatusView>(`/v1/services/${serviceId}/autoscale`),
};
