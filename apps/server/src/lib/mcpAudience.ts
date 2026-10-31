import { randomToken, secretEquals } from './crypto.js';

/**
 * R4: where an OAuth access token issued for remote MCP is accepted. Its raw
 * value starts with `ndmcp_`; `resolveUser` refuses it unless the caller
 * asks for the `mcp` audience, which only two places do:
 *  - `POST /v1/mcp` itself;
 *  - `authenticate`, for the in-process API requests a tool call makes,
 *    which carry `x-nd-mcp-internal` with this process's secret. A request
 *    from outside cannot know it, so the token stays useless against the API.
 */
export const MCP_TOKEN_PREFIX = 'ndmcp_';
export const MCP_INTERNAL_HEADER = 'x-nd-mcp-internal';
const SECRET = randomToken(32);

export const mcpInternalHeaders = (): Record<string, string> => ({ [MCP_INTERNAL_HEADER]: SECRET });

export function isMcpInternal(headers: Record<string, string | string[] | undefined>): boolean {
  const v = headers[MCP_INTERNAL_HEADER];
  return typeof v === 'string' && secretEquals(v, SECRET);
}
