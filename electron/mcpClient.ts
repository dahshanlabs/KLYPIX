/**
 * MCP Client Manager — Manages MCP server connections in the Electron Main process.
 *
 * Spawns MCP servers as subprocesses (stdio transport), discovers their tools,
 * and relays tool execution requests from the renderer agent via IPC.
 *
 * Architecture:
 *   Renderer (agent) → IPC → Main (mcpClient) → stdio → MCP Server
 *
 * Configuration stored in: %APPDATA%/klypix/mcp-servers.json
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────

export interface MCPServerConfig {
  /** Unique server name */
  name: string;
  /** Command to spawn the server */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Whether to auto-connect on app start */
  autoConnect: boolean;
  /** Whether this server is enabled */
  enabled: boolean;
}

export interface MCPToolInfo {
  /** Tool name (prefixed with server name: "servername__toolname") */
  name: string;
  /** Original tool name from the MCP server */
  originalName: string;
  /** Which MCP server provides this tool */
  serverName: string;
  /** Tool description */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, any>;
}

interface ConnectedServer {
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: MCPToolInfo[];
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  error?: string;
}

// ── MCP Client Manager ───────────────────────────────────────────────

export class MCPClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private configPath: string;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.configPath = path.join(userDataPath, 'mcp-servers.json');
    this.ensureConfigFile();
  }

  /**
   * Initialize: load config and auto-connect enabled servers.
   */
  async initialize(): Promise<void> {
    const configs = this.loadConfigs();
    console.log(`[MCP] Found ${configs.length} configured servers`);

    // Auto-connect enabled servers (don't block app startup — run in background)
    for (const config of configs) {
      if (config.enabled && config.autoConnect) {
        // Don't await — connect in background so app starts fast
        this.connectServer(config).catch(err => {
          console.error(`[MCP] Failed to auto-connect "${config.name}":`, err.message);
        });
      }
    }
  }

  /**
   * Connect to an MCP server (spawn process, discover tools).
   */
  async connectServer(config: MCPServerConfig): Promise<MCPToolInfo[]> {
    // Disconnect existing connection if any
    if (this.servers.has(config.name)) {
      await this.disconnectServer(config.name);
    }

    console.log(`[MCP] Connecting to "${config.name}": ${config.command} ${config.args.join(' ')}`);

    const entry: ConnectedServer = {
      config,
      client: null as any,
      transport: null as any,
      tools: [],
      status: 'connecting',
    };
    this.servers.set(config.name, entry);

    try {
      // Skip servers with empty required env vars (e.g., no API key set)
      if (config.env) {
        for (const [key, val] of Object.entries(config.env)) {
          if (!val) {
            console.log(`[MCP] Skipping "${config.name}" — ${key} not configured`);
            entry.status = 'disconnected';
            entry.error = `${key} not set`;
            return [];
          }
        }
      }

      // Create stdio transport (spawns the server as a child process)
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
      });

      // Create MCP client
      const client = new Client({
        name: 'klypix-agent',
        version: '1.0.0',
      });

      // Connect
      await client.connect(transport);

      entry.client = client;
      entry.transport = transport;
      entry.status = 'connected';

      // Discover tools
      entry.tools = await this.discoverTools(config.name, client);
      console.log(`[MCP] "${config.name}" connected — ${entry.tools.length} tools available`);

      return entry.tools;
    } catch (err: any) {
      entry.status = 'error';
      entry.error = err.message;
      console.error(`[MCP] "${config.name}" connection failed:`, err.message);
      throw err;
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;

    try {
      await entry.client?.close();
    } catch (err) {
      console.warn(`[MCP] Error closing "${name}":`, err);
    }

    entry.status = 'disconnected';
    this.servers.delete(name);
    console.log(`[MCP] "${name}" disconnected`);
  }

  /**
   * Discover all tools from a connected MCP server.
   */
  private async discoverTools(serverName: string, client: Client): Promise<MCPToolInfo[]> {
    try {
      const result = await client.listTools();
      return (result.tools || []).map((tool: any) => ({
        name: `${serverName}__${tool.name}`,
        originalName: tool.name,
        serverName,
        description: tool.description || '',
        inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] },
      }));
    } catch (err: any) {
      console.error(`[MCP] Tool discovery failed for "${serverName}":`, err.message);
      return [];
    }
  }

  /**
   * Execute a tool on an MCP server.
   */
  async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>,
  ): Promise<string> {
    const entry = this.servers.get(serverName);
    if (!entry) throw new Error(`MCP server "${serverName}" not connected`);
    if (entry.status !== 'connected') throw new Error(`MCP server "${serverName}" is ${entry.status}`);

    try {
      const result = await entry.client.callTool({
        name: toolName,
        arguments: args,
      });

      // Convert MCP result content to string
      if (result.content && Array.isArray(result.content)) {
        return result.content
          .map((c: any) => {
            if (c.type === 'text') return c.text;
            if (c.type === 'image') return `[Image: ${c.mimeType}]`;
            if (c.type === 'resource') return JSON.stringify(c);
            return JSON.stringify(c);
          })
          .join('\n');
      }

      return JSON.stringify(result);
    } catch (err: any) {
      throw new Error(`MCP tool "${toolName}" on "${serverName}" failed: ${err.message}`);
    }
  }

  /**
   * Get all tools from all connected servers.
   */
  getAllTools(): MCPToolInfo[] {
    const tools: MCPToolInfo[] = [];
    for (const entry of this.servers.values()) {
      if (entry.status === 'connected') {
        tools.push(...entry.tools);
      }
    }
    return tools;
  }

  /**
   * Get status of all configured servers.
   */
  getServerStatus(): Array<{
    name: string;
    status: string;
    toolCount: number;
    error?: string;
  }> {
    const configs = this.loadConfigs();
    return configs.map(config => {
      const entry = this.servers.get(config.name);
      return {
        name: config.name,
        status: entry?.status || 'disconnected',
        toolCount: entry?.tools.length || 0,
        error: entry?.error,
      };
    });
  }

  // ── Configuration Management ────────────────────────────────────────

  /**
   * Load MCP server configurations from disk.
   */
  loadConfigs(): MCPServerConfig[] {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const data = JSON.parse(raw);
      return data.servers || [];
    } catch {
      return [];
    }
  }

  /**
   * Save MCP server configurations to disk.
   */
  saveConfigs(configs: MCPServerConfig[]): void {
    const data = { servers: configs };
    fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Add a new server configuration.
   */
  addServer(config: MCPServerConfig): void {
    const configs = this.loadConfigs();
    const existing = configs.findIndex(c => c.name === config.name);
    if (existing >= 0) {
      configs[existing] = config;
    } else {
      configs.push(config);
    }
    this.saveConfigs(configs);
  }

  /**
   * Remove a server configuration and disconnect.
   */
  async removeServer(name: string): Promise<void> {
    await this.disconnectServer(name);
    const configs = this.loadConfigs().filter(c => c.name !== name);
    this.saveConfigs(configs);
  }

  /**
   * Create default config file with suggested MCP servers (all disabled by default).
   */
  private ensureConfigFile(): void {
    if (fs.existsSync(this.configPath)) return;

    const desktopPath = path.join(process.env.USERPROFILE || 'C:\\Users', 'Desktop');
    const documentsPath = path.join(process.env.USERPROFILE || 'C:\\Users', 'Documents');

    const defaults: MCPServerConfig[] = [
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', desktopPath, documentsPath],
        autoConnect: true,
        enabled: true,
      },
      {
        name: 'brave-search',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        env: { BRAVE_API_KEY: '' },
        autoConnect: false,
        enabled: false,
      },
      {
        name: 'tavily',
        command: 'npx',
        args: ['-y', 'tavily-mcp'],
        env: { TAVILY_API_KEY: '' },
        autoConnect: false,
        enabled: false,
      },
      {
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
        autoConnect: false,
        enabled: false,
      },
      {
        name: 'sqlite',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sqlite'],
        autoConnect: false,
        enabled: false,
      },
    ];

    this.saveConfigs(defaults);
    console.log(`[MCP] Created default config at: ${this.configPath}`);
  }

  /**
   * Shutdown: disconnect all servers cleanly.
   */
  async shutdown(): Promise<void> {
    for (const [name] of this.servers) {
      await this.disconnectServer(name);
    }
  }

  /**
   * Get the config file path (for UI display).
   */
  getConfigPath(): string {
    return this.configPath;
  }
}
