import { z } from 'zod';

// ── Cloud servers (G4.3): Hetzner Cloud first ──────────────────────────────
// `/v1/cloud/hetzner/*`, operator only. The panel creates a VM whose
// cloud-init installs Docker and starts the NineDeploy agent, then registers
// it as a node. The API token is stored encrypted and never returned.

/** PUT /v1/cloud/hetzner/token. A Cloud project token with Read & Write. */
export const hetznerTokenInput = z.object({ token: z.string().trim().min(32).max(128).regex(/^[A-Za-z0-9]+$/, 'not a Hetzner Cloud API token') });
export type HetznerTokenInput = z.infer<typeof hetznerTokenInput>;

/** GET /v1/cloud/hetzner. */
export const hetznerStatus = z.object({
  configured: z.boolean(),
  /** The token's last four characters, so the operator can tell which one is saved. */
  tokenHint: z.string().nullable(),
});
export type HetznerStatus = z.infer<typeof hetznerStatus>;

const slug = (max: number) => z.string().trim().min(2).max(max).regex(/^[a-z0-9][a-z0-9.-]*$/, 'letters, digits, dot and dash only');

/** Hetzner server names are hostnames: letters, digits and dashes, 63 characters at most. */
export const hetznerServerName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'letters, digits and inner dashes only');

/** POST /v1/cloud/hetzner/servers. */
export const hetznerServerCreate = z.object({
  name: hetznerServerName,
  location: slug(20),
  serverType: slug(30),
  image: slug(40),
  /** Hetzner SSH key ids added to root's authorized_keys. */
  sshKeyIds: z.array(z.number().int().positive()).max(10).default([]),
  agentPort: z.number().int().min(1024).max(65535).default(4600),
});
export type HetznerServerCreate = z.input<typeof hetznerServerCreate>;

/** GET /v1/cloud/hetzner/options: what a server can be created with. */
export const hetznerOptions = z.object({
  locations: z.array(z.object({ name: z.string(), city: z.string(), country: z.string() })),
  serverTypes: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      cores: z.number(),
      memoryGb: z.number(),
      diskGb: z.number(),
      architecture: z.string(),
      /** Locations that offer it. */
      locations: z.array(z.string()),
    }),
  ),
  /** System images of the distributions the agent bootstrap supports. */
  images: z.array(z.object({ name: z.string(), description: z.string(), architecture: z.string() })),
  sshKeys: z.array(z.object({ id: z.number(), name: z.string(), fingerprint: z.string() })),
});
export type HetznerOptions = z.infer<typeof hetznerOptions>;

/** A node the panel created on Hetzner Cloud. */
export const cloudServer = z.object({
  serverId: z.number().int(),
  name: z.string(),
  provider: z.literal('hetzner'),
  providerServerId: z.number().int(),
  location: z.string(),
  serverType: z.string(),
  image: z.string(),
  ipv4: z.string(),
  /** Hetzner's view (`running`, `initializing`, …); null when it could not be read, `deleted` when the VM is gone. */
  providerStatus: z.string().nullable(),
  /** The node row: `offline` until the agent first answers. */
  nodeStatus: z.string(),
  createdAt: z.string(),
});
export type CloudServer = z.infer<typeof cloudServer>;
