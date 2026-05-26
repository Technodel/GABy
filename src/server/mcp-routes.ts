/**
 * SUNy MCP Routes â€” user-facing API endpoints for MCP server management.
 *
 * POST /api/mcp/connect   â€” connect to an MCP server
 * POST /api/mcp/disconnect â€” disconnect an MCP server
 * GET  /api/mcp/servers   â€” list all servers and their status
 * GET  /api/mcp/tools     â€” list all discovered MCP tools
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from './auth';
import { mcpManager } from './mcp-manager';

const router = Router();

// All MCP routes require auth
router.use(requireAuth);

// â”€â”€ Connect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ConnectSchema = z.object({
  name: z.string().min(1).max(64),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});

router.post('/mcp/connect', async (req: Request, res: Response) => {
  const parsed = ConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid MCP server configuration',
      details: parsed.error.flatten(),
    });
    return;
  }

  // Validate transport-specific requirements
  const { transport, command, url } = parsed.data;
  if (transport === 'stdio' && !command) {
    res.status(400).json({ error: 'stdio transport requires a command' });
    return;
  }
  if ((transport === 'sse' || transport === 'http') && !url) {
    res.status(400).json({ error: `${transport} transport requires a url` });
    return;
  }

  try {
    await mcpManager.connect(parsed.data);
    const status = mcpManager.getStatus(parsed.data.name);
    res.json({
      success: true,
      name: parsed.data.name,
      status,
    });
  } catch (err) {
    res.status(500).json({
      error: `Failed to connect to MCP server "${parsed.data.name}"`,
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// â”€â”€ Disconnect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const DisconnectSchema = z.object({
  name: z.string().min(1),
});

router.post('/mcp/disconnect', async (req: Request, res: Response) => {
  const parsed = DisconnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Server name required' });
    return;
  }

  try {
    await mcpManager.disconnect(parsed.data.name);
    res.json({ success: true, name: parsed.data.name, status: 'disconnected' });
  } catch (err) {
    res.status(500).json({
      error: `Failed to disconnect "${parsed.data.name}"`,
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// â”€â”€ List servers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/mcp/servers', (_req: Request, res: Response) => {
  const servers = mcpManager.getAllStatuses();
  res.json({
    servers,
    total: servers.length,
    connected: servers.filter((s) => s.status === 'connected').length,
  });
});

// â”€â”€ List tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/mcp/tools', (_req: Request, res: Response) => {
  const servers = mcpManager.getAllStatuses();
  const toolList = servers.flatMap((s) => ({
    server: s.name,
    serverStatus: s.status,
    // Tools detail â€” we'd need a richer query, but this gives an overview
    toolCount: s.toolCount,
  }));

  res.json({
    totalToolCount: mcpManager.availableToolCount,
    servers: toolList,
  });
});

export default router;
