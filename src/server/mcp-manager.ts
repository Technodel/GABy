/**
 * SUNy MCP Manager â€” connects to MCP servers and exposes their tools
 * as Vercel AI SDK tool() instances for streamText().
 *
 * Architecture: Singleton. All MCP servers are managed centrally.
 * Tools are merged into the ToolSet in agent-loop.ts.
 *
 * Three transports: Stdio (local processes), SSE (Server-Sent Events),
 * Streamable HTTP (standard HTTP requests).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { tool, jsonSchema, type ToolSet } from 'ai';

// -- Types -------------------------------------------------------------------

export type MCPTransportType = 'stdio' | 'sse' | 'http';

export interface MCPServerConfig {
  name: string;
  transport: MCPTransportType;
  /** For stdio: the command to run (e.g. "npx") */
  command?: string;
  /** For stdio: arguments after the command */
  args?: string[];
  /** For sse/http: the endpoint URL */
  url?: string;
  /** Custom HTTP headers (e.g. auth tokens) */
  headers?: Record<string, string>;
  /** Environment variables (stdio only) */
  env?: Record<string, string>;
  /** Working directory (stdio only) */
  cwd?: string;
  /** Request timeout in ms. Default: 600000 (10 min) */
  timeout?: number;
}

export type MCPServerStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

interface RegisteredMcpTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  serverName: string;
}

interface McpServerInstance {
  config: MCPServerConfig;
  client: Client | null;
  status: MCPServerStatus;
  error?: string;
  tools: RegisteredMcpTool[];
}

// -- Helpers ------------------------------------------------------------------

/** Format MCP CallToolResult content blocks into a single string */
function formatMcpResult(result: unknown): string {
  const data = result as {
    content?: Array<{
      type: string;
      text?: string;
      resource?: { text?: string; blob?: string; mimeType?: string };
      mimeType?: string;
      data?: string;
    }>;
    isError?: boolean;
  };

  if (data.isError) {
    const textParts = (data.content || [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text);
    return `[MCP Error]\n${textParts.join('\n') || '(no error details)'}`;
  }

  const parts: string[] = [];
  for (const block of data.content || []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text || '');
        break;
      case 'resource':
        if (block.resource?.text) parts.push(block.resource.text);
        else if (block.resource?.blob)
          parts.push(`[Binary resource: ${block.resource.mimeType || 'unknown'}]`);
        else parts.push('[Empty resource]');
        break;
      case 'image':
        parts.push(`[Image: ${block.mimeType || 'unknown format'}]`);
        break;
      case 'audio':
        parts.push(`[Audio: ${block.mimeType || 'unknown format'}]`);
        break;
      default:
        parts.push(`[${block.type} content]`);
    }
  }
  return parts.join('\n');
}

/** Trim tool names to valid JS identifiers (avoid collisions) */
function normalizeToolName(serverName: string, toolName: string): string {
  const clean = toolName.replace(/[^a-zA-Z0-9_]/g, '_');
  // Prefix with server name to avoid collisions between servers
  return `${serverName}_${clean}`;
}

// -- Singleton Manager --------------------------------------------------------

class McpManager {
  private servers = new Map<string, McpServerInstance>();
  private toolMap = new Map<string, RegisteredMcpTool>(); // normalizedName -> tool

  // -- Connection management --------------------------------------------------

  async connect(config: MCPServerConfig): Promise<void> {
    const existing = this.servers.get(config.name);
    if (existing && existing.status === 'connected') {
      throw new Error(`Server "${config.name}" is already connected`);
    }

    const instance: McpServerInstance = {
      config,
      client: null,
      status: 'connecting',
      tools: [],
    };
    this.servers.set(config.name, instance);

    try {
      const mcpClient = new Client(
        { name: 'suny-mcp-client', version: '1.0.0' },
        { capabilities: {} },
      );

      let transport;
      switch (config.transport) {
        case 'stdio': {
          if (!config.command) throw new Error('stdio transport requires a command');
          transport = new StdioClientTransport({
            command: config.command,
            args: config.args || [],
            env: (config.env ? { ...process.env, ...config.env } : process.env) as Record<string, string>,
            cwd: config.cwd,
            stderr: 'pipe',
          });
          break;
        }
        case 'sse': {
          if (!config.url) throw new Error('sse transport requires a url');
          transport = new SSEClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          });
          break;
        }
        case 'http': {
          if (!config.url) throw new Error('http transport requires a url');
          transport = new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          });
          break;
        }
        default:
          throw new Error(`Unknown transport: ${config.transport}`);
      }

      const timeout = config.timeout ?? 600_000;
      await mcpClient.connect(transport, { timeout });

      // Register error handler
      mcpClient.onerror = (error) => {
        console.error(`[MCP] Error on "${config.name}":`, error);
        instance.status = 'error';
        instance.error = error instanceof Error ? error.message : String(error);
      };

      instance.client = mcpClient;

      // Discover tools
      const toolNames = await this.discoverTools(config.name, mcpClient);
      instance.tools = toolNames;
      instance.status = 'connected';
      instance.error = undefined;
    } catch (err) {
      instance.status = 'error';
      instance.error = err instanceof Error ? err.message : String(err);
      instance.client = null;
      throw err;
    }
  }

  async disconnect(name: string): Promise<void> {
    const instance = this.servers.get(name);
    if (!instance) return;

    // Remove all tools from this server
    for (const [normName, reg] of this.toolMap.entries()) {
      if (reg.serverName === name) this.toolMap.delete(normName);
    }

    if (instance.client) {
      try {
        await instance.client.close();
      } catch { /* ignore close errors */ }
    }

    this.servers.delete(name);
  }

  disconnectAll(): void {
    for (const name of this.servers.keys()) {
      this.disconnect(name);
    }
  }

  // -- Tool discovery ---------------------------------------------------------

  private async discoverTools(
    serverName: string,
    mcpClient: Client,
  ): Promise<RegisteredMcpTool[]> {
    let result;
    try {
      result = await mcpClient.request(
        { method: 'tools/list', params: {} },
        ListToolsResultSchema,
      );
    } catch {
      // tools/list not supported â€” server might be prompt-only
      return [];
    }

    const tools: RegisteredMcpTool[] = [];
    for (const mcpTool of (result as { tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }).tools || []) {
      if (!mcpTool.name) continue;

      const normalizedName = normalizeToolName(serverName, mcpTool.name);
      const reg: RegisteredMcpTool = {
        name: normalizedName,
        description: mcpTool.description || `MCP tool from ${serverName}`,
        schema: mcpTool.inputSchema || { type: 'object', properties: {} },
        serverName,
      };

      // Register in global tool map
      this.toolMap.set(normalizedName, reg);
      tools.push(reg);
    }

    return tools;
  }

  // -- Status queries ---------------------------------------------------------

  getStatus(name: string): MCPServerStatus | undefined {
    return this.servers.get(name)?.status;
  }

  getAllStatuses(): Array<{
    name: string;
    status: MCPServerStatus;
    toolCount: number;
    error?: string;
  }> {
    return Array.from(this.servers.entries()).map(([name, inst]) => ({
      name,
      status: inst.status,
      toolCount: inst.tools.length,
      error: inst.error,
    }));
  }

  getConnectedServers(): string[] {
    return Array.from(this.servers.entries())
      .filter(([, inst]) => inst.status === 'connected')
      .map(([name]) => name);
  }

  // -- ToolSet generation -----------------------------------------------------

  /**
   * Returns a Vercel AI SDK ToolSet from all connected MCP servers.
   * Each tool's execute() calls the MCP server and formats the result.
   */
  getTools(): ToolSet {
    const toolSet: ToolSet = {};

    for (const [, instance] of this.servers) {
      if (instance.status !== 'connected' || !instance.client) continue;
      const client = instance.client;

      for (const reg of instance.tools) {
        const originalToolName = reg.name.replace(`${instance.config.name}_`, '');
        toolSet[reg.name] = tool({
          description: `${reg.description} (MCP: ${instance.config.name})`,
          inputSchema: reg.schema as any,
          execute: async (args: Record<string, unknown>) => {
            try {
              const result = await client.request(
                {
                  method: 'tools/call',
                  params: { name: originalToolName, arguments: args },
                },
                CallToolResultSchema,
              );
              return formatMcpResult(result);
            } catch (err) {
              return `[MCP Error on "${instance.config.name}/${originalToolName}"]: ${
                err instanceof Error ? err.message : String(err)
              }`;
            }
          },
        });
      }
    }

    return toolSet;
  }

  /** Count of currently available MCP tools */
  get availableToolCount(): number {
    return this.toolMap.size;
  }
}

// -- Singleton export ---------------------------------------------------------

export const mcpManager = new McpManager();
