import { z } from 'zod';

// ── Remote MCP over Streamable HTTP (R4) ───────────────────────────────────
// The panel serves the MCP tools at /v1/mcp to clients that present an API
// token (Bearer). Off until an operator turns it on.

export const mcpHttpPolicy = z
  .object({
    enabled: z.boolean(),
    /** Only the non-mutating, non-secret tool allowlist, for every caller (as NINEDEPLOY_MCP_READONLY=1 does for stdio). */
    readOnly: z.boolean(),
  })
  .strict();
export type McpHttpPolicy = z.infer<typeof mcpHttpPolicy>;

export const mcpHttpPolicyPatch = mcpHttpPolicy.partial().strict();
export type McpHttpPolicyPatch = z.infer<typeof mcpHttpPolicyPatch>;

export const DEFAULT_MCP_HTTP_POLICY: McpHttpPolicy = { enabled: false, readOnly: false };

/** `GET`/`PUT /v1/mcp/policy`: the policy and the path clients connect to. */
export const mcpHttpPolicyView = z.object({ policy: mcpHttpPolicy, path: z.literal('/v1/mcp') });
export type McpHttpPolicyView = z.infer<typeof mcpHttpPolicyView>;
