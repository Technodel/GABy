import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAdmin } from './auth';
import { getAdapter, getDb } from './db';
import { getAllFeatureFlags, setFeatureFlag, getPlanFeatureFlags, setPlanFeatureFlag } from './feature-flags';
import { getAgentMetricsSummary, getRecentTurns } from './metrics';
import { userClientManager } from './user-client-manager';
import { validateMarkupFormula } from './billing';

const router = Router();

// All admin routes require admin auth
router.use(requireAdmin);

// â”€â”€ Users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/users', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const users = await db.all(`
    SELECT id, username, balance, wallet_balance, wallet_auto_spend, is_active, selected_mode, created_at, max_tokens_per_session, last_visit, plan
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
  plan: z.enum(['regular', 'pro']).optional(),
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
  if (data.plan) {
    await db.run('UPDATE users SET plan = ? WHERE id = ?', [data.plan, userId]);
  }

  res.json({ success: true });
});

// ── Plan Feature Flags ──────────────────────────────────────────────────────

router.get('/plan-features', (_req: Request, res: Response) => {
  res.json(getPlanFeatureFlags());
});

router.patch('/plan-features/:key/:plan', (req: Request, res: Response) => {
  const { key, plan } = req.params;
  if (!['regular', 'pro'].includes(plan)) { res.status(400).json({ error: 'Invalid plan' }); return; }
  const { enabled } = req.body as { enabled: boolean };
  if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be boolean' }); return; }
  setPlanFeatureFlag(key, plan, enabled);
  res.json({ success: true });
});

router.post('/plan-features', (req: Request, res: Response) => {
  const { key, label, description, proEnabled, regularEnabled } = req.body as {
    key: string; label: string; description: string; proEnabled: boolean; regularEnabled: boolean;
  };
  if (!key || !label) { res.status(400).json({ error: 'key and label are required' }); return; }
  const safeKey = key.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const db = getDb();
  for (const plan of ['pro', 'regular'] as const) {
    const enabled = plan === 'pro' ? (proEnabled ?? true) : (regularEnabled ?? false);
    db.prepare(
      `INSERT INTO plan_feature_flags (key, plan, enabled, label, description)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key, plan) DO UPDATE SET label = excluded.label, description = excluded.description, enabled = excluded.enabled, updated_at = datetime('now')`
    ).run(safeKey, plan, enabled ? 1 : 0, label, description ?? '');
  }
  res.json({ success: true, key: safeKey });
});

router.delete('/plan-features/:key', (req: Request, res: Response) => {
  const { key } = req.params;
  const db = getDb();
  db.prepare('DELETE FROM plan_feature_flags WHERE key = ?').run(key);
  res.json({ success: true });
});

router.delete('/users/:id', async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) { res.status(400).json({ error: 'Invalid user id' }); return; }
  (await getAdapter()).run('UPDATE users SET is_active = 0 WHERE id = ?', [userId]);
  res.json({ success: true });
});

// â”€â”€ API Keys â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/api-keys', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const keys = await db.all(`
    SELECT id, provider, mode, is_active, label, priority, model_id_override, key_value, base_cost_prompt, base_cost_completion, sale_price_prompt, sale_price_completion FROM api_keys ORDER BY priority ASC, id DESC
  `);
  res.json(keys);
});

const CreateKeySchema = z.object({
  provider: z.string().min(1).max(50),
  key_value: z.string().min(1).max(500),
  mode: z.enum(['free', 'fast', 'smart', 'pro']),
  label: z.string().max(100).optional(),
  priority: z.number().int().min(1).optional(),
  model_id_override: z.string().max(150).optional(),
  base_cost_prompt: z.number().min(0).optional(),
  base_cost_completion: z.number().min(0).optional(),
  sale_price_prompt: z.number().min(0).optional(),
  sale_price_completion: z.number().min(0).optional(),
});

router.post('/api-keys', async (req: Request, res: Response) => {
  const parsed = CreateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const { provider, key_value, mode, label, priority, model_id_override, base_cost_prompt, base_cost_completion, sale_price_prompt, sale_price_completion } = parsed.data;
  const db = await getAdapter();
  // Only deactivate existing keys if this is priority 1 (primary)
  if ((priority ?? 1) === 1) {
    await db.run('UPDATE api_keys SET is_active = 0 WHERE mode = ? AND priority = 1', [mode]);
  }
  const result = await db.run(`
    INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override, base_cost_prompt, base_cost_completion, sale_price_prompt, sale_price_completion) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `, [provider, key_value, mode, label ?? null, priority ?? 1, model_id_override ?? null, base_cost_prompt ?? 0, base_cost_completion ?? 0, sale_price_prompt ?? 0, sale_price_completion ?? 0]);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.patch('/api-keys/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  
  const PatchSchema = z.object({
    base_cost_prompt: z.number().min(0).optional(),
    base_cost_completion: z.number().min(0).optional(),
    sale_price_prompt: z.number().min(0).optional(),
    sale_price_completion: z.number().min(0).optional(),
  });
  
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() }); return; }
  
  const updates: string[] = [];
  const vals: any[] = [];
  
  if (parsed.data.base_cost_prompt !== undefined) { updates.push('base_cost_prompt = ?'); vals.push(parsed.data.base_cost_prompt); }
  if (parsed.data.base_cost_completion !== undefined) { updates.push('base_cost_completion = ?'); vals.push(parsed.data.base_cost_completion); }
  if (parsed.data.sale_price_prompt !== undefined) { updates.push('sale_price_prompt = ?'); vals.push(parsed.data.sale_price_prompt); }
  if (parsed.data.sale_price_completion !== undefined) { updates.push('sale_price_completion = ?'); vals.push(parsed.data.sale_price_completion); }
  
  if (updates.length > 0) {
    vals.push(id);
    await (await getAdapter()).run(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`, vals);
  }
  res.json({ success: true });
});

router.delete('/api-keys/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  (await getAdapter()).run('DELETE FROM api_keys WHERE id = ?', [id]);
  res.json({ success: true });
});

// â”€â”€ Pricing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  if (!['free', 'fast', 'pro', 'smart'].includes(mode)) {
    res.status(400).json({ error: 'Invalid mode' });
    return;
  }
  const parsed = UpdatePricingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  if (data.markup_formula !== undefined) {
    const formulaError = validateMarkupFormula(data.markup_formula);
    if (formulaError) {
      res.status(400).json({ error: formulaError });
      return;
    }
  }
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

// â”€â”€ Usage Stats / Reports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      ROUND(SUM(ul.charged_cost) - SUM(ul.raw_cost), 6) AS total_profit,
      COALESCE((SELECT SUM(cached_tokens) FROM user_cache_counters), 0) AS total_cached_saved
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
      u.wallet_balance                      AS wallet_balance,
      COALESCE(ucc.cached_tokens, 0)        AS cached_tokens_saved
    FROM usage_log ul
    JOIN users u ON u.id = ul.user_id
    LEFT JOIN user_cache_counters ucc ON ucc.user_id = u.id
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

// â”€â”€ Cached Tokens per User â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/cached-tokens', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const rows = await db.all(`
    SELECT ucc.user_id, u.username, u.display_name, ucc.cached_tokens, ucc.updated_at
    FROM user_cache_counters ucc
    JOIN users u ON u.id = ucc.user_id
    ORDER BY ucc.cached_tokens DESC
  `);
  res.json(rows);
});

router.post('/cached-tokens/:userId/reset', async (req: Request, res: Response) => {
  const db = await getAdapter();
  const userId = parseInt(req.params.userId, 10);
  if (!userId) return res.status(400).json({ error: 'Invalid user_id' });
  await db.run('UPDATE user_cache_counters SET cached_tokens = 0, updated_at = datetime(\'now\') WHERE user_id = ?', [userId]);
  res.json({ ok: true });
});

// â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Contact Info â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Available AI models (from models.dev) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Feature Flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Agent Metrics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// ── Plan Upgrade Requests ────────────────────────────────────────────────────

router.get('/upgrade-requests', async (req: Request, res: Response) => {
  const status = (req.query.status as string) || 'pending';
  const allowed = ['pending', 'approved', 'rejected', 'all'];
  const where = allowed.includes(status) && status !== 'all' ? 'WHERE status = ?' : '';
  const params = status !== 'all' && allowed.includes(status) ? [status] : [];
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT id, user_id, username, current_plan, requested_plan, status, note, requested_at, reviewed_at
     FROM plan_upgrade_requests ${where} ORDER BY requested_at DESC LIMIT 200`,
    params,
  );
  res.json(rows);
});

router.patch('/upgrade-requests/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const parsed = z.object({ action: z.enum(['approve', 'reject']) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid action' }); return; }
  const db = await getAdapter();
  const row = await db.get<{ id: number; user_id: number; requested_plan: string; status: string }>(
    'SELECT id, user_id, requested_plan, status FROM plan_upgrade_requests WHERE id = ?', [id],
  );
  if (!row) { res.status(404).json({ error: 'Request not found' }); return; }
  if (row.status !== 'pending') { res.status(400).json({ error: `Already ${row.status}` }); return; }
  const newStatus = parsed.data.action === 'approve' ? 'approved' : 'rejected';
  await db.run(
    `UPDATE plan_upgrade_requests SET status = ?, reviewed_at = datetime('now') WHERE id = ?`,
    [newStatus, id],
  );
  if (parsed.data.action === 'approve') {
    await db.run('UPDATE users SET plan = ? WHERE id = ?', [row.requested_plan, row.user_id]);
  }
  res.json({ success: true });
});

// ── SUNy Widget Config (Technodel Chatbot) ──────────────────────────────────

router.get('/suny-widget', async (_req: Request, res: Response) => {
  const db = await getAdapter();
  const row = await db.get<{
    bot_name: string; logo_url: string; enabled: number;
    system_prompt: string | null; deepseek_key: string | null;
    groq_key: string | null; openrouter_key: string | null;
    serper_key: string | null; suny_page_url: string; updated_at: string;
  }>('SELECT * FROM suny_widget_config WHERE id = 1');

  if (!row) {
    res.json({
      bot_name: 'SUNy', logo_url: '/SLOGO.png', enabled: true,
      system_prompt: null, deepseek_key: '', groq_key: '', openrouter_key: '', serper_key: '', suny_page_url: 'https://suny.technodel.tech',
    });
    return;
  }
  // Mask keys for display (show last 6 chars only)
  const mask = (k: string | null) => k ? `${'*'.repeat(Math.max(0, k.length - 6))}${k.slice(-6)}` : '';
  res.json({
    bot_name: row.bot_name,
    logo_url: row.logo_url,
    enabled: row.enabled === 1,
    system_prompt: row.system_prompt,
    deepseek_key: mask(row.deepseek_key),
    groq_key: mask(row.groq_key),
    openrouter_key: mask(row.openrouter_key),
    serper_key: mask(row.serper_key),
    suny_page_url: row.suny_page_url,
    updated_at: row.updated_at,
    has_deepseek: !!row.deepseek_key,
    has_groq: !!row.groq_key,
    has_openrouter: !!row.openrouter_key,
    has_serper: !!row.serper_key,
  });
});

const WidgetConfigSchema = z.object({
  bot_name: z.string().min(1).max(50).optional(),
  logo_url: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  system_prompt: z.string().max(5000).nullable().optional(),
  deepseek_key: z.string().max(200).nullable().optional(),
  groq_key: z.string().max(200).nullable().optional(),
  openrouter_key: z.string().max(200).nullable().optional(),
  serper_key: z.string().max(200).nullable().optional(),
  suny_page_url: z.string().url().max(200).optional(),
});

router.put('/suny-widget', async (req: Request, res: Response) => {
  const parsed = WidgetConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;
  const db = await getAdapter();

  // Ensure the row exists
  const existing = await db.get('SELECT id FROM suny_widget_config WHERE id = 1');
  if (!existing) {
    await db.run(
      `INSERT INTO suny_widget_config (id, bot_name, logo_url, enabled) VALUES (1, 'SUNy', '/SLOGO.png', 1)`
    );
  }

  const fields: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (data.bot_name !== undefined) { fields.push('bot_name = ?'); values.push(data.bot_name); }
  if (data.logo_url !== undefined) { fields.push('logo_url = ?'); values.push(data.logo_url); }
  if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }
  if (data.system_prompt !== undefined) { fields.push('system_prompt = ?'); values.push(data.system_prompt); }
  if (data.suny_page_url !== undefined) { fields.push('suny_page_url = ?'); values.push(data.suny_page_url); }

  // Only update key if it's not masked (doesn't start with ***)
  if (data.deepseek_key !== undefined && data.deepseek_key !== null && !data.deepseek_key.startsWith('***')) {
    fields.push('deepseek_key = ?'); values.push(data.deepseek_key || null);
  }
  if (data.groq_key !== undefined && data.groq_key !== null && !data.groq_key.startsWith('***')) {
    fields.push('groq_key = ?'); values.push(data.groq_key || null);
  }
  if (data.openrouter_key !== undefined && data.openrouter_key !== null && !data.openrouter_key.startsWith('***')) {
    fields.push('openrouter_key = ?'); values.push(data.openrouter_key || null);
  }
  if (data.serper_key !== undefined && data.serper_key !== null && !data.serper_key.startsWith('***')) {
    fields.push('serper_key = ?'); values.push(data.serper_key || null);
  }

  values.push(1);
  await db.run(`UPDATE suny_widget_config SET ${fields.join(', ')} WHERE id = ?`, values);
  res.json({ success: true });
});

export default router;
