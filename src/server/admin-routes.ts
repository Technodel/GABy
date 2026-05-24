import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAdmin } from './auth';
import { getAdapter } from './db';
import { getAllFeatureFlags, setFeatureFlag } from './feature-flags';
import { getAgentMetricsSummary, getRecentTurns } from './metrics';
import { userClientManager } from './user-client-manager';

const router = Router();

// All admin routes require admin auth
router.use(requireAdmin);

// ── Users ─────────────────────────────────────────────────────────────────────

router.get('/users', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const users = await db.all(`
    SELECT id, username, balance, wallet_balance, wallet_auto_spend, is_active, selected_mode, created_at, max_tokens_per_session
    FROM users ORDER BY created_at DESC
  `);
  res.json(users);
});

const CreateUserSchema = z.object({
  username: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(6).max(100),
  balance: z.number().min(0).default(0),
  max_tokens_per_session: z.number().int().nullable().optional(),
});

router.post('/users', async (req: Request, res: Response) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const { username, password, balance, max_tokens_per_session } = parsed.data;
  const hash = bcrypt.hashSync(password, 12);
  const db = await getAdapter();
  try {
    const result = await db.run(`
      INSERT INTO users (username, password_hash, balance, max_tokens_per_session)
      VALUES (?, ?, ?, ?)
    `, [username, hash, balance, max_tokens_per_session ?? null]);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create user' });
    }
  }
});

const UpdateUserSchema = z.object({
  balance_delta: z.number().optional(),
  balance_set: z.number().min(0).optional(),
  wallet_balance_set: z.number().min(0).optional(),
  password: z.string().min(4).max(100).optional(),
  is_active: z.boolean().optional(),
  max_tokens_per_session: z.number().int().nullable().optional(),
});

router.patch('/users/:id', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) { res.status(400).json({ error: 'Invalid user id' }); return; }

  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  const db = await getAdapter();

  if (typeof data.balance_delta === 'number') {
    await db.run('UPDATE users SET balance = MAX(0, balance + ?) WHERE id = ?', [data.balance_delta, userId]);
  }
  if (typeof data.balance_set === 'number') {
    await db.run('UPDATE users SET balance = ? WHERE id = ?', [data.balance_set, userId]);
  }
  if (typeof data.wallet_balance_set === 'number') {
    await db.run('UPDATE users SET wallet_balance = ? WHERE id = ?', [data.wallet_balance_set, userId]);
  }
  if (data.password) {
    const hash = bcrypt.hashSync(data.password, 12);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  }
  if (typeof data.is_active === 'boolean') {
    await db.run('UPDATE users SET is_active = ? WHERE id = ?', [data.is_active ? 1 : 0, userId]);
  }
  if (data.max_tokens_per_session !== undefined) {
    await db.run('UPDATE users SET max_tokens_per_session = ? WHERE id = ?', [data.max_tokens_per_session, userId]);
  }

  res.json({ success: true });
});

router.delete('/users/:id', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) { res.status(400).json({ error: 'Invalid user id' }); return; }
  (await getAdapter()).run('UPDATE users SET is_active = 0 WHERE id = ?', [userId]);
  res.json({ success: true });
});

// ── API Keys ───────────────────────────────────────────────────────────────────

router.get('/api-keys', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const keys = await db.all(`
    SELECT id, provider, mode, is_active, label, priority, model_id_override, key_value FROM api_keys ORDER BY priority ASC, id DESC
  `);
  res.json(keys);
});

const CreateKeySchema = z.object({
  provider: z.string().min(1).max(50),
  key_value: z.string().min(1).max(500),
  mode: z.enum(['free', 'fast', 'pro']),
  label: z.string().max(100).optional(),
  priority: z.number().int().min(1).optional(),
  model_id_override: z.string().max(150).optional(),
});

router.post('/api-keys', async (req: Request, res: Response) => {
  const parsed = CreateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const { provider, key_value, mode, label, priority, model_id_override } = parsed.data;
  const db = await getAdapter();
  // Only deactivate existing keys if this is priority 1 (primary)
  if ((priority ?? 1) === 1) {
    await db.run('UPDATE api_keys SET is_active = 0 WHERE mode = ? AND priority = 1', [mode]);
  }
  const result = await db.run(`
    INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)
  `, [provider, key_value, mode, label ?? null, priority ?? 1, model_id_override ?? null]);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/api-keys/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  (await getAdapter()).run('DELETE FROM api_keys WHERE id = ?', [id]);
  res.json({ success: true });
});

// ── Pricing ────────────────────────────────────────────────────────────────────

router.get('/pricing', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const modes = await db.all('SELECT * FROM pricing_modes ORDER BY id');
  res.json(modes);
});

const UpdatePricingSchema = z.object({
  markup_formula: z.string().max(200).optional(),
  model_id: z.string().min(1).max(150).optional(),
  // Token costs come from the model selection (auto-filled by ModelPicker), not user input
  input_token_base_cost: z.number().min(0).optional(),
  output_token_base_cost: z.number().min(0).optional(),
  global_max_tokens: z.number().int().nullable().optional(),
  display_name: z.string().max(50).optional(),
  description: z.string().max(200).optional(),
});

router.patch('/pricing/:mode', async (req: Request, res: Response) => {
  const mode = req.params.mode;
  if (!['free', 'fast', 'pro'].includes(mode)) {
    res.status(400).json({ error: 'Invalid mode' });
    return;
  }
  const parsed = UpdatePricingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  const db = await getAdapter();
  const fields: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  if (data.markup_formula !== undefined) { fields.push('markup_formula = ?'); values.push(data.markup_formula); }
  if (data.input_token_base_cost !== undefined) { fields.push('input_token_base_cost = ?'); values.push(data.input_token_base_cost); }
  if (data.output_token_base_cost !== undefined) { fields.push('output_token_base_cost = ?'); values.push(data.output_token_base_cost); }
  if (data.model_id !== undefined) { fields.push('model_id = ?'); values.push(data.model_id); }
  if (data.global_max_tokens !== undefined) { fields.push('global_max_tokens = ?'); values.push(data.global_max_tokens); }
  if (data.display_name !== undefined) { fields.push('display_name = ?'); values.push(data.display_name); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  values.push(mode);
  await db.run(`UPDATE pricing_modes SET ${fields.join(', ')} WHERE mode = ?`, values);
  res.json({ success: true });
});

// ── Usage Stats / Reports ──────────────────────────────────────────────────────

router.get('/usage-stats', async (req: Request, res: Response) => {
  const db = await getAdapter();
  const { from, to, user_id, mode } = req.query as Record<string, string>;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (from) { conditions.push('ul.timestamp >= ?'); params.push(from); }
  if (to)   { conditions.push('ul.timestamp <= ?'); params.push(to + ' 23:59:59'); }
  if (user_id) { conditions.push('ul.user_id = ?'); params.push(parseInt(user_id, 10)); }
  if (mode)    { conditions.push('ul.mode = ?'); params.push(mode); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const summary = await db.get(`
    SELECT
      COUNT(DISTINCT ul.user_id)            AS total_users,
      COUNT(*)                              AS total_sessions,
      COALESCE(SUM(ul.input_tokens), 0)     AS total_input_tokens,
      COALESCE(SUM(ul.output_tokens), 0)    AS total_output_tokens,
      COALESCE(SUM(ul.cache_write_tokens),0) AS total_cache_write,
      COALESCE(SUM(ul.cache_read_tokens), 0) AS total_cache_read,
      ROUND(SUM(ul.raw_cost), 6)            AS total_raw_cost,
      ROUND(SUM(ul.charged_cost), 6)        AS total_charged,
      ROUND(SUM(ul.charged_cost) - SUM(ul.raw_cost), 6) AS total_profit
    FROM usage_log ul ${where}
  `, params);

  // Per-user breakdown (collapsed across all modes)
  const perUser = await db.all(`
    SELECT
      u.id                                  AS user_id,
      u.username,
      u.display_name,
      COUNT(*)                              AS sessions,
      COALESCE(SUM(ul.input_tokens), 0)     AS input_tokens,
      COALESCE(SUM(ul.output_tokens), 0)    AS output_tokens,
      COALESCE(SUM(ul.cache_write_tokens),0) AS cache_write_tokens,
      COALESCE(SUM(ul.cache_read_tokens), 0) AS cache_read_tokens,
      ROUND(SUM(ul.raw_cost), 6)            AS raw_cost,
      ROUND(SUM(ul.charged_cost), 6)        AS charged,
      ROUND(SUM(ul.charged_cost) - SUM(ul.raw_cost), 6) AS profit,
      u.balance                             AS balance_left,
      u.wallet_balance                      AS wallet_balance
    FROM usage_log ul
    JOIN users u ON u.id = ul.user_id
    ${where}
    GROUP BY ul.user_id
    ORDER BY charged DESC
  `, params);

  // Per-mode breakdown (joined with pricing_modes to get model_id)
  const perMode = await db.all(`
    SELECT
      ul.mode,
      pm.display_name,
      pm.model_id,
      COUNT(*)                              AS sessions,
      COALESCE(SUM(ul.input_tokens), 0)     AS input_tokens,
      COALESCE(SUM(ul.output_tokens), 0)    AS output_tokens,
      COALESCE(SUM(ul.cache_write_tokens),0) AS cache_write_tokens,
      COALESCE(SUM(ul.cache_read_tokens), 0) AS cache_read_tokens,
      ROUND(SUM(ul.raw_cost), 6)            AS raw_cost,
      ROUND(SUM(ul.charged_cost), 6)        AS charged,
      ROUND(SUM(ul.charged_cost) - SUM(ul.raw_cost), 6) AS profit
    FROM usage_log ul
    LEFT JOIN pricing_modes pm ON pm.mode = ul.mode
    ${where}
    GROUP BY ul.mode
    ORDER BY charged DESC
  `, params);

  // Recent individual calls (last 50)
  const recentConditions = conditions.map(c => c.replace('ul.', '')); // strip alias for subquery
  const recentWhere = recentConditions.length > 0 ? `WHERE ${recentConditions.join(' AND ')}`.replace(/ul\./g, '') : '';
  const recent = await db.all(`
    SELECT
      ul.id,
      u.username,
      ul.mode,
      ul.input_tokens,
      ul.output_tokens,
      ul.cache_write_tokens,
      ul.cache_read_tokens,
      ROUND(ul.raw_cost, 6)      AS raw_cost,
      ROUND(ul.charged_cost, 6)  AS charged,
      ROUND(ul.charged_cost - ul.raw_cost, 6) AS profit,
      ul.timestamp
    FROM usage_log ul
    JOIN users u ON u.id = ul.user_id
    ${where}
    ORDER BY ul.timestamp DESC
    LIMIT 100
  `, params);

  // Daily trend (last 30 days or filtered range)
  const perDay = await db.all(`
    SELECT
      DATE(ul.timestamp)                     AS day,
      COUNT(*)                               AS sessions,
      COALESCE(SUM(ul.input_tokens), 0)      AS input_tokens,
      COALESCE(SUM(ul.output_tokens), 0)     AS output_tokens,
      ROUND(SUM(ul.raw_cost), 6)             AS raw_cost,
      ROUND(SUM(ul.charged_cost), 6)         AS charged,
      ROUND(SUM(ul.charged_cost) - SUM(ul.raw_cost), 6) AS profit
    FROM usage_log ul
    ${where || 'WHERE ul.timestamp >= DATE(\'now\', \'-30 days\')'}
    GROUP BY DATE(ul.timestamp)
    ORDER BY day DESC
    LIMIT 90
  `, params);

  res.json({ summary, perUser, perMode, recent, perDay });
});

// ── Settings ───────────────────────────────────────────────────────────────────

router.get('/settings', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const rows = await db.all<Array<{ key: string; value: string }>>('SELECT key, value FROM app_settings');
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

const SettingsSchema = z.object({
  allow_registration: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  dark_mode: z.boolean().optional(),
  prompt_caching_enabled: z.boolean().optional(),
  auto_backup_enabled: z.boolean().optional(),
  auto_backup_trigger: z.enum(['task', 'tokens', 'minutes']).optional(),
  auto_backup_interval: z.number().int().min(1).optional(),
  edit_format: z.enum(['tool-call', 'diff', 'whole', 'architect']).optional(),
  daily_token_limit: z.number().int().min(0).nullable().optional(),
});

router.patch('/settings', async (req: Request, res: Response) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  const db = await getAdapter();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) await db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, String(value)]);
  }
  res.json({ success: true });
});

const ChangePasswordSchema = z.object({
  new_password: z.string().min(6).max(100),
});

router.post('/settings/change-password', async (req: Request, res: Response) => {
  const parsed = ChangePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  // Admin password lives only in env — this updates the env var at runtime (VPS restart required for full persistence)
  // For a more persistent solution, store hashed admin password in app_settings
  const db = await getAdapter();
  const hash = bcrypt.hashSync(parsed.data.new_password, 12);
  await db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', ['admin_password_hash', hash]);
  res.json({ success: true, note: 'Password hash updated. Old SUNY_ADMIN_PASSWORD env var still works until restart.' });
});

// ── Contact Info ───────────────────────────────────────────────────────────────

router.get('/contact', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const info = await db.get('SELECT * FROM contact_info WHERE id = 1');
  res.json(info || {});
});

const ContactSchema = z.object({
  phone: z.string().max(30).optional(),
  email: z.string().email().max(100).optional(),
  website: z.string().max(100).optional(),
  whatsapp: z.string().max(30).optional(),
  support_message: z.string().max(300).optional(),
});

router.patch('/contact', async (req: Request, res: Response) => {
  const parsed = ContactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  const db = await getAdapter();
  const fields: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) { fields.push(`${key} = ?`); values.push(val); }
  }
  values.push(1);
  await db.run(`UPDATE contact_info SET ${fields.join(', ')} WHERE id = ?`, values);
  res.json({ success: true });
});

// ── Available AI models (from models.dev) ──────────────────────────────────────

let modelsCache: { ts: number; data: unknown[] } | null = null;
const MODELS_CACHE_TTL = 3600_000; // 1 hour

router.get('/models', async (_req: Request, res: Response) => {
  try {
    type ModelEntry = { id: string; provider: string; inputCost: number; outputCost: number; cacheReadCost: number | null; cacheWriteCost: number | null; contextTokens: number | null; hasApiKey: boolean };
    let baseList: Omit<ModelEntry, 'hasApiKey'>[];

    if (modelsCache && Date.now() - modelsCache.ts < MODELS_CACHE_TTL) {
      baseList = modelsCache.data as Omit<ModelEntry, 'hasApiKey'>[];
    } else {
      const resp = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`models.dev returned ${resp.status}`);
      const raw = await resp.json() as Record<string, { models?: Record<string, { id?: string; cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }; limit?: { context?: number; output?: number } }> }>;
      const list: Omit<ModelEntry, 'hasApiKey'>[] = [];
      for (const [provider, providerData] of Object.entries(raw)) {
        if (!providerData.models) continue;
        for (const [modelKey, m] of Object.entries(providerData.models)) {
          const id = m.id ?? modelKey;
          list.push({
            id,
            provider,
            inputCost: (m.cost?.input ?? 0) / 1_000_000,
            outputCost: (m.cost?.output ?? 0) / 1_000_000,
            cacheReadCost: m.cost?.cache_read != null ? m.cost.cache_read / 1_000_000 : null,
            cacheWriteCost: m.cost?.cache_write != null ? m.cost.cache_write / 1_000_000 : null,
            contextTokens: m.limit?.context ?? null,
          });
        }
      }
      list.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
      modelsCache = { ts: Date.now(), data: list };
      baseList = list;
    }

    // Live: which providers have at least one active key? (case-insensitive match)
    const activeDb = await getAdapter();
    const activeRows = await activeDb.all<Array<{ p: string }>>(
      'SELECT DISTINCT LOWER(provider) as p FROM api_keys WHERE is_active = 1'
    );
    const activeSet = new Set(activeRows.map(r => r.p));

    const result: ModelEntry[] = baseList.map(m => ({
      ...m,
      hasApiKey: activeSet.has(m.provider.toLowerCase()),
    }));

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch model list from models.dev' });
  }
});

// ── Feature Flags ─────────────────────────────────────────────────────────────

const FeatureFlagSchema = z.object({
  value: z.enum(['on', 'off']),
});

router.get('/feature-flags', (_req: Request, res: Response) => {
  const flags = getAllFeatureFlags();
  res.json(flags);
});

router.patch('/feature-flags/:key', (req: Request, res: Response) => {
  const { key } = req.params;
  if (!key.startsWith('ff_')) {
    res.status(400).json({ error: 'Feature flag keys must start with ff_' });
    return;
  }
  const parsed = FeatureFlagSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  setFeatureFlag(key, parsed.data.value);
  res.json({ success: true, key, value: parsed.data.value });
});

// ── Agent Metrics ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/metrics?days=7
 * Returns aggregated agent turn success rates, tool call averages, cost trends.
 */
router.get('/metrics', (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt((req.query.days as string) || '7', 10), 1), 90);
  const summary = getAgentMetricsSummary(days);
  res.json(summary);
});

/**
 * GET /api/admin/metrics/recent?limit=100
 * Returns individual recent turns for live monitoring.
 */
router.get('/metrics/recent', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '100', 10), 1), 500);
  res.json(getRecentTurns(limit));
});

/**
 * GET /api/admin/topup-requests?status=pending
 * List user-submitted top-up requests for admin review.
 */
router.get('/topup-requests', async (req: Request, res: Response) => {
  const status = (req.query.status as string) || 'pending';
  const allowed = ['pending', 'approved', 'rejected', 'all'];
  const where = allowed.includes(status) && status !== 'all' ? 'WHERE r.status = ?' : '';
  const params = status !== 'all' && allowed.includes(status) ? [status] : [];
  const db = await getAdapter();
  const rows = await db.all<Record<string, unknown>>(
    `SELECT r.id, r.user_id, u.username, r.amount, r.note, r.status, r.admin_notes,
            r.created_at, r.resolved_at
     FROM topup_requests r
     LEFT JOIN users u ON u.id = r.user_id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT 200`,
    params,
  );
  res.json(rows);
});

/**
 * PATCH /api/admin/topup-requests/:id
 * Approve (credits wallet) or reject a top-up request.
 * Body: { action: 'approve' | 'reject', adminNotes?: string }
 */
router.patch('/topup-requests/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const parsed = z.object({
    action: z.enum(['approve', 'reject']),
    adminNotes: z.string().max(500).optional().default(''),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid action' }); return; }
  const db = await getAdapter();
  const reqRow = await db.get<{ id: number; user_id: number; amount: number; status: string }>(
    'SELECT id, user_id, amount, status FROM topup_requests WHERE id = ?',
    [id],
  );
  if (!reqRow) { res.status(404).json({ error: 'Request not found' }); return; }
  if (reqRow.status !== 'pending') { res.status(400).json({ error: `Already ${reqRow.status}` }); return; }
  if (parsed.data.action === 'approve') {
    // Credit user's wallet (the bot's fuel tank) directly. We don't go through
    // transferToWallet here because the funds come from the admin / external
    // payment, not the user's main balance.
    await db.run(
      'UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?',
      [reqRow.amount, reqRow.user_id],
    );
    await db.run(
      "UPDATE topup_requests SET status = 'approved', admin_notes = ?, resolved_at = datetime('now') WHERE id = ?",
      [parsed.data.adminNotes, id],
    );
    const updated = await db.get<{ wallet_balance: number; balance: number }>(
      'SELECT wallet_balance, balance FROM users WHERE id = ?',
      [reqRow.user_id],
    );
    userClientManager.pushToUser(reqRow.user_id, 'suny:balance', {
      balance: updated?.balance ?? 0,
      wallet_balance: updated?.wallet_balance ?? 0,
    });
    userClientManager.pushToUser(reqRow.user_id, 'suny:topup_resolved', {
      requestId: id,
      status: 'approved',
      amount: reqRow.amount,
      adminNotes: parsed.data.adminNotes,
    });
  } else {
    await db.run(
      "UPDATE topup_requests SET status = 'rejected', admin_notes = ?, resolved_at = datetime('now') WHERE id = ?",
      [parsed.data.adminNotes, id],
    );
    userClientManager.pushToUser(reqRow.user_id, 'suny:topup_resolved', {
      requestId: id,
      status: 'rejected',
      amount: reqRow.amount,
      adminNotes: parsed.data.adminNotes,
    });
  }
  res.json({ success: true });
});

export default router;
