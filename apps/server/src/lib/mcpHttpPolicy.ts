import type { DB } from '@ninedeploy/db';
import { DEFAULT_MCP_HTTP_POLICY, mcpHttpPolicy, type McpHttpPolicy } from '@ninedeploy/schemas';
import { getSettingJson, setSettingJson } from './settings.js';

/** R4: remote MCP's on/off and read-only switches (the operator's settings row). */
const KEY = 'mcp_http';

export async function getMcpHttpPolicy(db: DB): Promise<McpHttpPolicy> {
  const parsed = mcpHttpPolicy.safeParse(await getSettingJson(db, KEY, null));
  return parsed.success ? parsed.data : DEFAULT_MCP_HTTP_POLICY;
}

export async function setMcpHttpPolicy(db: DB, policy: McpHttpPolicy): Promise<void> {
  await setSettingJson(db, KEY, policy);
}
