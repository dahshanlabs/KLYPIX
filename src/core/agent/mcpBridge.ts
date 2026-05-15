/**
 * MCP Bridge — Renderer-side interface between the agent and MCP servers.
 *
 * Queries MCP tools from Main process via IPC, merges them with local tools,
 * and routes MCP tool execution through IPC → Main → MCP server.
 *
 * The agent sees MCP tools as regular tools — no special handling needed.
 * MCP tools are prefixed with server name: "servername__toolname"
 */

const electron = (window as any).electron;

/**
 * Strip properties from MCP tool schemas that Gemini doesn't support.
 * Gemini rejects: $schema, additionalProperties, $ref, default (in some cases).
 * Recursively cleans nested objects.
 */
function cleanSchema(schema: Record<string, any>): Record<string, any> {
  if (!schema || typeof schema !== 'object') return schema;

  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    // Skip properties Gemini doesn't understand
    if (key === '$schema' || key === 'additionalProperties' || key === '$ref' || key === '$id') continue;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      cleaned[key] = cleanSchema(value);
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map(v => typeof v === 'object' && v !== null ? cleanSchema(v) : v);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export interface MCPToolDefinition {
  name: string;
  originalName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, any>;
}

/**
 * Fetch all available MCP tools from connected servers.
 * Returns tool definitions compatible with the agent's tool registry format.
 */
export async function getMCPTools(): Promise<Array<{
  name: string;
  description: string;
  input_schema: Record<string, any>;
}>> {
  if (!electron?.mcp) return [];

  try {
    const result = await electron.mcp.listTools();
    if (!result.success || !result.tools) return [];

    return result.tools.map((tool: MCPToolDefinition) => ({
      name: tool.name,
      description: `[MCP:${tool.serverName}] ${tool.description}`,
      input_schema: cleanSchema(tool.inputSchema),
    }));
  } catch (err) {
    console.warn('[MCPBridge] Failed to fetch MCP tools:', err);
    return [];
  }
}

/**
 * Execute an MCP tool via IPC → Main process → MCP server.
 * Called by toolExecutor when it detects an MCP-prefixed tool name.
 */
export async function executeMCPTool(
  toolName: string,
  args: Record<string, any>,
): Promise<string> {
  if (!electron?.mcp) throw new Error('MCP not available');

  // Parse server name from prefixed tool name: "servername__toolname"
  const separatorIdx = toolName.indexOf('__');
  if (separatorIdx < 0) throw new Error(`Invalid MCP tool name: ${toolName} (expected "server__tool")`);

  const serverName = toolName.substring(0, separatorIdx);
  const originalToolName = toolName.substring(separatorIdx + 2);

  const result = await electron.mcp.executeTool({
    serverName,
    toolName: originalToolName,
    args,
  });

  if (!result.success) {
    throw new Error(result.error || `MCP tool "${toolName}" failed`);
  }

  return result.result || JSON.stringify(result);
}

/**
 * Check if a tool name is an MCP tool (prefixed with "servername__").
 */
export function isMCPTool(toolName: string): boolean {
  return toolName.includes('__');
}

/**
 * Get status of all MCP servers.
 */
export async function getMCPServerStatus(): Promise<Array<{
  name: string;
  status: string;
  toolCount: number;
  error?: string;
}>> {
  if (!electron?.mcp) return [];

  try {
    const result = await electron.mcp.getServers();
    return result.success ? result.servers : [];
  } catch {
    return [];
  }
}

/**
 * Connect to a specific MCP server.
 */
export async function connectMCPServer(config: any): Promise<boolean> {
  if (!electron?.mcp) return false;
  const result = await electron.mcp.connectServer(config);
  return result.success;
}

/**
 * Disconnect from a specific MCP server.
 */
export async function disconnectMCPServer(name: string): Promise<boolean> {
  if (!electron?.mcp) return false;
  const result = await electron.mcp.disconnectServer(name);
  return result.success;
}
