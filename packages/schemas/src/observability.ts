import { z } from 'zod';

export const METRIC_HISTORY_MAX_DAYS = 90;
export const observabilitySettings = z.object({
  retentionDays: z.number().int().min(1).max(METRIC_HISTORY_MAX_DAYS).default(1),
  prometheusEnabled: z.boolean().default(false),
  otlpEndpoint: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2048).refine((v) => !/^https?:\/\/[^/?#]*@/i.test(v) && !v.includes('#'),
    'Use an HTTP(S) endpoint without credentials or a fragment')]).default(''),
  otlpAuthorization: z.string().max(4096).regex(/^[^\r\n]*$/).default(''),
  logQueueMaxMb: z.number().int().min(1).max(256).default(16),
});
export const observabilityPatch = z.object({
  retentionDays: observabilitySettings.shape.retentionDays.removeDefault().optional(),
  prometheusEnabled: observabilitySettings.shape.prometheusEnabled.removeDefault().optional(),
  otlpEndpoint: observabilitySettings.shape.otlpEndpoint.removeDefault().optional(),
  otlpAuthorization: observabilitySettings.shape.otlpAuthorization.removeDefault().optional(),
  logQueueMaxMb: observabilitySettings.shape.logQueueMaxMb.removeDefault().optional(),
}).strict();
export type ObservabilitySettings = z.infer<typeof observabilitySettings>;
export type ObservabilityPatch = z.infer<typeof observabilityPatch>;
export type ObservabilityView = Omit<ObservabilitySettings, 'otlpAuthorization'> & {
  hasOtlpAuthorization: boolean;
};
export interface LogQueueStatus {
  pendingBatches: number;
  pendingEntries: number;
  payloadBytes: number;
  blockedBatches: number;
  pausedSources: number;
  oldestAt: string | null;
}

export interface ObservabilityExportResult { ok: boolean; status: number; samples: number; error: string | null }
export interface ObservabilityExportStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  result: ObservabilityExportResult | null;
}
export interface ObservabilityResponse { settings: ObservabilityView; exportStatus: ObservabilityExportStatus }
