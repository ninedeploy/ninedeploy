import { useQuery } from '@tanstack/react-query';
import type { CapabilityStatus, ServiceCapabilityId } from '@ninedeploy/sdk';
import { api } from './api.js';

/**
 * C1: what a service can use, from `GET /v1/services/:id/capabilities` — the
 * same evaluation the routes refuse with. Cards decide whether to show their
 * controls from it instead of repeating the rules.
 */
export function useServiceCapabilities(serviceId: number) {
  return useQuery({ queryKey: ['capabilities', serviceId], queryFn: () => api.services.capabilities(serviceId), retry: false, staleTime: 30_000 });
}

/** True once loaded and the feature is not refused for this service. */
export function capabilityUsable(
  data: { capabilities: Partial<Record<ServiceCapabilityId, { status: CapabilityStatus }>> } | undefined,
  id: ServiceCapabilityId,
): boolean {
  const status = data?.capabilities[id]?.status;
  return status !== undefined && status !== 'unavailable';
}
