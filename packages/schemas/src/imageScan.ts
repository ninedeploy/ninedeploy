import { z } from 'zod';

// ── Image vulnerability scanning (G5.1) ────────────────────────────────────
// Trivy runs in a throwaway container on the panel host and reads the image
// from `docker save` on its stdin (no Docker socket). A deploy scans its new
// image before it gets traffic; a schedule rescans what runs. Opt-in.

export const imageScanSeverity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
export type ImageScanSeverity = z.infer<typeof imageScanSeverity>;

/** `off`: report only. `critical` / `high`: a deploy whose image has such findings fails before it gets traffic. */
export const imageScanGate = z.enum(['off', 'critical', 'high']);
export type ImageScanGate = z.infer<typeof imageScanGate>;

export const imageScanPolicy = z.object({
  enabled: z.boolean(),
  gate: imageScanGate,
  /** The gate counts only findings with a fixed version available (an unfixable CVE cannot be acted on). */
  gateFixableOnly: z.boolean(),
  /** Rescan running images this often, in hours; 0 turns the schedule off. */
  rescanHours: z.number().int().min(0).max(24 * 30),
});
export type ImageScanPolicy = z.infer<typeof imageScanPolicy>;

export const imageScanPolicyPatch = imageScanPolicy.partial();
export type ImageScanPolicyPatch = z.infer<typeof imageScanPolicyPatch>;

export const DEFAULT_IMAGE_SCAN_POLICY: ImageScanPolicy = { enabled: false, gate: 'off', gateFixableOnly: true, rescanHours: 24 };

/** At most this many findings are kept per scan, most severe first; `findingsTruncated` says when more exist. */
export const IMAGE_SCAN_FINDINGS_MAX = 300;

export const imageScanFinding = z.object({
  id: z.string(),
  severity: imageScanSeverity,
  pkg: z.string(),
  installed: z.string(),
  fixed: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  /** The scanned layer or file it was found in (OS packages, a lockfile, a binary). */
  target: z.string(),
});
export type ImageScanFinding = z.infer<typeof imageScanFinding>;

const severityCounts = z.object({
  critical: z.number().int().min(0),
  high: z.number().int().min(0),
  medium: z.number().int().min(0),
  low: z.number().int().min(0),
  unknown: z.number().int().min(0),
});
export type ImageScanCounts = z.infer<typeof severityCounts>;

export const imageScanResult = z.object({
  serviceId: z.number().int(),
  /** The local image id that was scanned. */
  imageId: z.string(),
  scannedAt: z.string(),
  trigger: z.enum(['deploy', 'schedule', 'manual']),
  deploymentId: z.number().int().nullable(),
  status: z.enum(['ok', 'error']),
  /** Why the scan could not finish (status `error`). */
  error: z.string().nullable(),
  /** The image's OS as Trivy saw it, e.g. "debian 12.15". */
  os: z.string().nullable(),
  counts: severityCounts,
  /** The same counts, only findings with a fixed version available. */
  fixable: severityCounts,
  findings: z.array(imageScanFinding).max(IMAGE_SCAN_FINDINGS_MAX),
  findingsTruncated: z.boolean(),
  /** The deploy gate refused this image (deploy scans only). */
  blocked: z.boolean(),
  /** A compose stack: each distinct image scanned, with the compose services that run it. Counts and findings cover them all. */
  images: z.array(z.object({ services: z.array(z.string()), imageId: z.string(), os: z.string().nullable() })).optional(),
});
export type ImageScanResult = z.infer<typeof imageScanResult>;
