/**
 * SUNy MCP Marketplace â€” Discover, share, and install MCP server configurations.
 *
 * A registry of community-contributed MCP server definitions that users
 * can browse, install, and share. Each entry includes:
 *   - Server name and description
 *   - Transport type and configuration
 *   - Tags/categories for discovery
 *   - User ratings and install count
 *   - Security review status
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface MarketplaceEntry {
  id: number;
  name: string;
  display_name: string;
  description: string;
  author: string;
  author_url: string | null;
  homepage: string | null;
  icon_url: string | null;
  transport: string; // 'stdio' | 'sse' | 'http'
  config_example: string; // JSON string of example config
  tags: string; // comma-separated
  category: string;
  install_count: number;
  rating: number;
  review_status: 'pending' | 'approved' | 'rejected';
  is_official: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserInstalledMcp {
  id: number;
  user_id: number;
  marketplace_id: number | null;
  name: string;
  display_name: string;
  transport: string;
  config_json: string; // the full MCPServerConfig JSON
  is_active: boolean;
  notes: string;
  installed_at: string;
}

export type MarketplaceCategory =
  | 'database'
  | 'search'
  | 'filesystem'
  | 'api'
  | 'devops'
  | 'communication'
  | 'analytics'
  | 'media'
  | 'ai'
  | 'utility'
  | 'other';

// â”€â”€ Database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_marketplace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      author_url TEXT,
      homepage TEXT,
      icon_url TEXT,
      transport TEXT NOT NULL CHECK(transport IN ('stdio', 'sse', 'http')),
      config_example TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'utility',
      install_count INTEGER NOT NULL DEFAULT 0,
      rating REAL NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'pending',
      is_official INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_installed_mcp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      marketplace_id INTEGER,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      transport TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT NOT NULL DEFAULT '',
      installed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_marketplace_category
      ON mcp_marketplace(category);
    CREATE INDEX IF NOT EXISTS idx_mcp_marketplace_tags
      ON mcp_marketplace(tags);
    CREATE INDEX IF NOT EXISTS idx_user_installed_mcp_user
      ON user_installed_mcp(user_id);
  `);
}

// â”€â”€ Marketplace CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function seedMarketplaceEntries(): void {
  ensureTable();
  const db = getDb();

  const entries: Array<{
    name: string; displayName: string; description: string;
    author: string; transport: string; config: Record<string, unknown>;
    tags: string; category: string; isOfficial: boolean;
  }> = [
    {
      name: 'local-filesystem',
      displayName: 'Local Filesystem',
      description: 'Read, write, and search files on the local machine. Essential for any project work.',
      author: 'SUNy Core',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      tags: 'files,file-system,local,storage',
      category: 'filesystem',
      isOfficial: true,
    },
    {
      name: 'github',
      displayName: 'GitHub API',
      description: 'Interact with GitHub â€” repos, issues, PRs, code search, and more via the GitHub API.',
      author: 'SUNy Core',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      tags: 'github,git,version-control,issues,prs',
      category: 'api',
      isOfficial: true,
    },
    {
      name: 'postgres',
      displayName: 'PostgreSQL Database',
      description: 'Query and explore PostgreSQL databases. Read-only mode supported.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
      tags: 'database,postgres,sql,query',
      category: 'database',
      isOfficial: false,
    },
    {
      name: 'sqlite',
      displayName: 'SQLite Explorer',
      description: 'Browse and query SQLite databases directly from the agent.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite'] },
      tags: 'database,sqlite,sql,query',
      category: 'database',
      isOfficial: false,
    },
    {
      name: 'web-search',
      displayName: 'Web Search',
      description: 'Search the web using Brave Search or Google Custom Search API.',
      author: 'SUNy Core',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
      tags: 'search,web,internet,browser',
      category: 'search',
      isOfficial: true,
    },
    {
      name: 'docker',
      displayName: 'Docker Manager',
      description: 'Manage Docker containers, images, and compose stacks from the agent.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-docker'] },
      tags: 'docker,containers,devops,infrastructure',
      category: 'devops',
      isOfficial: false,
    },
    {
      name: 'slack',
      displayName: 'Slack Messenger',
      description: 'Send messages to Slack channels, read messages, and manage workspace.',
      author: 'MCP Community',
      transport: 'sse',
      config: { url: 'http://localhost:3002/sse' },
      tags: 'slack,communication,messaging,team',
      category: 'communication',
      isOfficial: false,
    },
    {
      name: 'memory',
      displayName: 'Memory Server',
      description: 'Persistent knowledge graph memory. Store, retrieve, and link information across sessions.',
      author: 'SUNy Core',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      tags: 'memory,knowledge,graph,persistence',
      category: 'ai',
      isOfficial: true,
    },
    {
      name: 'playwright',
      displayName: 'Playwright Browser',
      description: 'Automate browsers â€” navigate, screenshot, fill forms, extract data from web pages.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-playwright'] },
      tags: 'browser,automation,screenshot,testing,playwright',
      category: 'media',
      isOfficial: false,
    },
    {
      name: 'puppeteer',
      displayName: 'Puppeteer Browser',
      description: 'Headless Chrome/Chromium automation for web scraping and testing.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
      tags: 'browser,automation,scraping,testing',
      category: 'media',
      isOfficial: false,
    },
    {
      name: 'sequential-thinking',
      displayName: 'Sequential Thinking',
      description: 'A tool for thinking through complex problems step-by-step with branching exploration.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
      tags: 'thinking,reasoning,problem-solving,planning',
      category: 'ai',
      isOfficial: false,
    },
    {
      name: 'everything',
      displayName: 'Everything Server',
      description: 'MCP test server with every type of tool, resource, and prompt â€” useful for testing.',
      author: 'MCP Team',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
      tags: 'testing,development,debug,demo',
      category: 'utility',
      isOfficial: true,
    },
    {
      name: 'cloudflare',
      displayName: 'Cloudflare API',
      description: 'Manage Cloudflare Workers, KV, R2, D1, Durable Objects, and DNS from the agent.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-cloudflare'] },
      tags: 'cloudflare,workers,cdn,dns,serverless',
      category: 'devops',
      isOfficial: false,
    },
    {
      name: 'redis',
      displayName: 'Redis Explorer',
      description: 'Connect to Redis instances, query keys, and manage cache from the agent.',
      author: 'MCP Community',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis'] },
      tags: 'redis,cache,database,key-value',
      category: 'database',
      isOfficial: false,
    },
  ];

  for (const entry of entries) {
    const existing = db.prepare('SELECT id FROM mcp_marketplace WHERE name = ?').get(entry.name);
    if (!existing) {
      db.prepare(`
        INSERT INTO mcp_marketplace (name, display_name, description, author, transport, config_example, tags, category, is_official, review_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')
      `).run(
        entry.name,
        entry.displayName,
        entry.description,
        entry.author,
        entry.transport,
        JSON.stringify(entry.config),
        entry.tags,
        entry.category,
        entry.isOfficial ? 1 : 0,
      );
    }
  }
}

// â”€â”€ Queries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function listMarketplaceEntries(
  options?: {
    category?: string;
    search?: string;
    limit?: number;
    offset?: number;
  },
): { entries: MarketplaceEntry[]; total: number } {
  ensureTable();
  const db = getDb();

  let where = "WHERE review_status = 'approved'";
  const params: unknown[] = [];

  if (options?.category && options.category !== 'all') {
    where += ' AND category = ?';
    params.push(options.category);
  }

  if (options?.search) {
    where += ' AND (display_name LIKE ? OR description LIKE ? OR tags LIKE ?)';
    const searchTerm = `%${options.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM mcp_marketplace ${where}`).get(...params) as { c: number }).c;

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const entries = db.prepare(
    `SELECT * FROM mcp_marketplace ${where} ORDER BY is_official DESC, install_count DESC, rating DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as MarketplaceEntry[];

  return { entries, total };
}

export function getMarketplaceEntry(id: number): MarketplaceEntry | null {
  ensureTable();
  const db = getDb();
  return db.prepare('SELECT * FROM mcp_marketplace WHERE id = ?').get(id) as MarketplaceEntry | null;
}

export function getMarketplaceEntryByName(name: string): MarketplaceEntry | null {
  ensureTable();
  const db = getDb();
  return db.prepare('SELECT * FROM mcp_marketplace WHERE name = ?').get(name) as MarketplaceEntry | null;
}

export function getCategories(): { category: string; count: number }[] {
  ensureTable();
  const db = getDb();
  return db.prepare(
    "SELECT category, COUNT(*) as count FROM mcp_marketplace WHERE review_status = 'approved' GROUP BY category ORDER BY count DESC"
  ).all() as { category: string; count: number }[];
}

export function incrementInstallCount(marketplaceId: number): void {
  const db = getDb();
  db.prepare('UPDATE mcp_marketplace SET install_count = install_count + 1 WHERE id = ?').run(marketplaceId);
}

// â”€â”€ User installed MCP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function installMarketplaceMcp(
  userId: number,
  marketplaceId: number,
  customConfig?: Record<string, unknown>,
): UserInstalledMcp | null {
  ensureTable();
  const db = getDb();

  const entry = getMarketplaceEntry(marketplaceId);
  if (!entry) return null;

  const config = customConfig ?? JSON.parse(entry.config_example);

  const result = db.prepare(`
    INSERT INTO user_installed_mcp (user_id, marketplace_id, name, display_name, transport, config_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    marketplaceId,
    entry.name,
    entry.display_name,
    entry.transport,
    JSON.stringify(config),
  );

  incrementInstallCount(marketplaceId);

  return db.prepare('SELECT * FROM user_installed_mcp WHERE id = ?').get(result.lastInsertRowid) as UserInstalledMcp;
}

export function addCustomMcp(
  userId: number,
  name: string,
  displayName: string,
  transport: string,
  config: Record<string, unknown>,
  notes?: string,
): UserInstalledMcp {
  ensureTable();
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO user_installed_mcp (user_id, name, display_name, transport, config_json, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, name, displayName, transport, JSON.stringify(config), notes || '');

  return db.prepare('SELECT * FROM user_installed_mcp WHERE id = ?').get(result.lastInsertRowid) as UserInstalledMcp;
}

export function listUserInstalledMcp(userId: number): UserInstalledMcp[] {
  ensureTable();
  const db = getDb();
  return db.prepare(
    'SELECT * FROM user_installed_mcp WHERE user_id = ? ORDER BY is_active DESC, installed_at DESC'
  ).all(userId) as UserInstalledMcp[];
}

export function toggleUserMcp(id: number, userId: number, isActive: boolean): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare(
    'UPDATE user_installed_mcp SET is_active = ? WHERE id = ? AND user_id = ?'
  ).run(isActive ? 1 : 0, id, userId);
  return result.changes > 0;
}

export function uninstallUserMcp(id: number, userId: number): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM user_installed_mcp WHERE id = ? AND user_id = ?'
  ).run(id, userId);
  return result.changes > 0;
}

// â”€â”€ Tool factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createMarketplaceTools(userId: number) {
  return {
    mcp_marketplace_search: tool({
      description: 'Search the MCP Marketplace for available servers. Filter by category or search term.',
      inputSchema: z.object({
        search: z.string().optional().describe('Search term to filter servers'),
        category: z.string().optional().describe('Category to filter by (database, search, filesystem, api, devops, communication, analytics, media, ai, utility, other)'),
        limit: z.number().optional().describe('Maximum results to return (default: 10)'),
      }),
      execute: async ({ search, category, limit }) => {
        const result = listMarketplaceEntries({ search, category: category || 'all', limit: limit ?? 10 });
        if (result.entries.length === 0) return 'No MCP servers found matching your criteria.';

        return result.entries.map(e =>
          `[${e.category}] ${e.display_name} â€” ${e.description.slice(0, 100)}` +
          `\n  Transport: ${e.transport} | Author: ${e.author} | Rating: ${e.rating}/5 | Installs: ${e.install_count}` +
          `\n  Install: \`mcp-marketplace install ${e.id}\``
        ).join('\n\n');
      },
    }),

    mcp_marketplace_install: tool({
      description: 'Install an MCP server from the marketplace by its ID.',
      inputSchema: z.object({
        marketplaceId: z.number().describe('The marketplace entry ID to install'),
      }),
      execute: async ({ marketplaceId }) => {
        const entry = getMarketplaceEntry(marketplaceId);
        if (!entry) return `Marketplace entry #${marketplaceId} not found.`;

        const installed = installMarketplaceMcp(userId, marketplaceId);
        if (!installed) return `Failed to install "${entry.display_name}".`;

        return [
          `âœ… Installed "${entry.display_name}" from marketplace!`,
          `Transport: ${entry.transport}`,
          `Config: ${entry.config_example}`,
          `Connect it via \`/mcp connect ${installed.name}\` to start using its tools.`,
        ].join('\n');
      },
    }),

    mcp_marketplace_list_installed: tool({
      description: 'List all MCP servers currently installed for your user.',
      inputSchema: z.object({}),
      execute: async () => {
        const installed = listUserInstalledMcp(userId);
        if (installed.length === 0) return 'No MCP servers installed. Browse the marketplace with `mcp_marketplace_search`.';

        return installed.map(i =>
          `${i.is_active ? 'ðŸŸ¢' : 'â­•'} ${i.display_name} (${i.transport})` +
          `\n  Installed: ${i.installed_at}`
        ).join('\n\n');
      },
    }),

    mcp_marketplace_uninstall: tool({
      description: 'Uninstall an installed MCP server by its name.',
      inputSchema: z.object({
        name: z.string().describe('The name of the installed MCP server to uninstall'),
      }),
      execute: async ({ name }) => {
        const db = getDb();
        const installed = db.prepare(
          'SELECT id FROM user_installed_mcp WHERE user_id = ? AND name = ?'
        ).get(userId, name) as { id: number } | undefined;

        if (!installed) return `No installed MCP server found with name "${name}".`;
        uninstallUserMcp(installed.id, userId);
        return `âœ… Uninstalled "${name}".`;
      },
    }),
  };
}

// â”€â”€ MCP marketplace API routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { Router } from 'express';
import { requireAuth } from './auth';

export function createMarketplaceRouter(): Router {
  const router = Router();

  // List marketplace entries
  router.get('/mcp/marketplace', requireAuth, (req, res) => {
    const { category, search, limit, offset } = req.query;
    const result = listMarketplaceEntries({
      category: category as string | undefined,
      search: search as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });
    res.json(result);
  });

  // Get categories
  router.get('/mcp/marketplace/categories', requireAuth, (_req, res) => {
    const categories = getCategories();
    res.json({ categories });
  });

  // Get single entry
  router.get('/mcp/marketplace/:id', requireAuth, (req, res) => {
    const entry = getMarketplaceEntry(parseInt(req.params.id, 10));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  });

  // Install from marketplace
  router.post('/mcp/marketplace/:id/install', requireAuth, (req, res) => {
    const user = req as unknown as { userId: number };
    const installed = installMarketplaceMcp(user.userId, parseInt(req.params.id, 10));
    if (!installed) return res.status(400).json({ error: 'Install failed' });
    res.json(installed);
  });

  // List user installed
  router.get('/mcp/installed', requireAuth, (req, res) => {
    const user = req as unknown as { userId: number };
    const installed = listUserInstalledMcp(user.userId);
    res.json(installed);
  });

  // Add custom MCP
  router.post('/mcp/installed', requireAuth, (req, res) => {
    const user = req as unknown as { userId: number };
    const { name, displayName, transport, config, notes } = req.body;
    try {
      const installed = addCustomMcp(user.userId, name, displayName, transport, config, notes);
      res.json(installed);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Uninstall
  router.delete('/mcp/installed/:id', requireAuth, (req, res) => {
    const user = req as unknown as { userId: number };
    const ok = uninstallUserMcp(parseInt(req.params.id, 10), user.userId);
    res.json({ success: ok });
  });

  // Toggle active
  router.patch('/mcp/installed/:id/toggle', requireAuth, (req, res) => {
    const user = req as unknown as { userId: number };
    const { isActive } = req.body;
    const ok = toggleUserMcp(parseInt(req.params.id, 10), user.userId, isActive);
    res.json({ success: ok });
  });

  return router;
}
