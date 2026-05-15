import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { requireAuth, AuthRequest } from './auth';
import { getDb } from './db';
import { hasSufficientBalance, getUserBalance, friendlySessionLimit, deductUsage, transferToWallet } from './billing';
import { isBridgeConnected } from './bridge-manager';
import { userClientManager } from './user-client-manager';
import { loadProjectRules, saveProjectRules, deleteProjectRules } from './project-rules';
import { listCheckpoints, rollbackToCheckpoint } from './git-manager';

const router = Router();
router.use(requireAuth);

// ── User profile & balance ─────────────────────────────────────────────────────

router.get('/me', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const db = getDb();
  const row = db.prepare(`
    SELECT id, username, display_name, balance, wallet_balance, wallet_auto_spend, selected_mode, max_tokens_per_session, is_active
    FROM users WHERE id = ?
  `).get(user.id) as UserRow | undefined;

  if (!row) { res.status(404).json({ error: 'User not found' }); return; }

  const pricing = db.prepare('SELECT * FROM pricing_modes ORDER BY id').all();
  const settings = getDb().prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
  const settingsMap: Record<string, string> = {};
  for (const s of settings) settingsMap[s.key] = s.value;

  res.json({
    id: row.id,
    username: row.username,
    display_name: row.display_name ?? null,
    balance: row.balance,
    wallet_balance: row.wallet_balance,
    wallet_auto_spend: row.wallet_auto_spend === 1,
    selected_mode: row.selected_mode,
    session_limit_label: friendlySessionLimit(row.max_tokens_per_session),
    is_active: row.is_active === 1,
    auto_approve: settingsMap.auto_approve === 'true',
    modes: (() => {
      const list = (pricing as PricingRow[]).map(p => {
        const keyCount = (db.prepare('SELECT COUNT(*) as cnt FROM api_keys WHERE mode = ? AND is_active = 1').get(p.mode) as { cnt: number }).cnt;
        return {
          mode: p.mode,
          display_name: p.display_name,
          description: p.description ?? '',
          // Never expose formula, token costs, or max_tokens as raw numbers
          session_limit_label: friendlySessionLimit(p.global_max_tokens),
          has_active_key: keyCount > 0,
        };
      });
      // AUTO mode: virtual entry — routes to the best real mode per message
      list.push({
        mode: 'auto',
        display_name: '🤖 Auto',
        description: 'Smartly picks the right model for each message — fast for code, powerful for analysis',
        session_limit_label: 'Adaptive',
        has_active_key: list.some(m => m.has_active_key),
      });
      return list;
    })(),
    bridge_connected: isBridgeConnected(user.id as number),
  });
});

// ── Update display name ────────────────────────────────────────────────────────────────────────

router.patch('/me/name', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const raw = (req.body as { display_name?: unknown }).display_name;
  const name = typeof raw === 'string' ? raw.trim().slice(0, 50) || null : null;
  getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user.id);
  res.json({ success: true });
});

router.patch('/me/mode', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const schema = z.object({ mode: z.enum(['free', 'fast', 'pro', 'auto']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid mode' }); return; }
  getDb().prepare('UPDATE users SET selected_mode = ? WHERE id = ?').run(parsed.data.mode, user.id);
  res.json({ success: true });
});

// ── Projects ───────────────────────────────────────────────────────────────────

router.get('/projects', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projects = getDb().prepare('SELECT id, name, local_path, persona, created_at FROM projects WHERE user_id = ?').all(user.id);
  res.json(projects);
});

function isAbsolutePath(p: string): boolean {
  // Windows: starts with drive letter e.g. C:\ or C:/
  // Unix: starts with /
  return /^[A-Za-z]:[\\//]/.test(p) || p.startsWith('/');
}

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  local_path: z.string().min(1).max(500).refine(
    isAbsolutePath,
    { message: 'Please enter the full path to your project folder, like D:\\Projects\\MyApp' }
  ),
});

router.post('/projects', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const result = getDb().prepare('INSERT INTO projects (user_id, name, local_path) VALUES (?, ?, ?)').run(
    user.id, parsed.data.name, parsed.data.local_path
  );
  res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/projects/:id', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  getDb().prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, user.id);
  res.json({ success: true });
});

/** Set or clear the AI persona for a project */
router.patch('/projects/:id/persona', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const parsed = z.object({ persona: z.string().max(2000).nullable() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  getDb().prepare('UPDATE projects SET persona = ? WHERE id = ?').run(parsed.data.persona?.trim() || null, id);
  res.json({ success: true });
});

// ── Memories ───────────────────────────────────────────────────────────────────

router.get('/memories', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const memories = getDb().prepare(`
    SELECT id, content, created_at FROM user_memories WHERE user_id = ? ORDER BY created_at DESC
  `).all(user.id);
  res.json(memories);
});

const AddMemorySchema = z.object({
  content: z.string().min(1).max(500),
});

router.post('/memories', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = AddMemorySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const result = getDb().prepare('INSERT INTO user_memories (user_id, content) VALUES (?, ?)').run(user.id, parsed.data.content);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/memories/:id', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  getDb().prepare('DELETE FROM user_memories WHERE id = ? AND user_id = ?').run(id, user.id);
  res.json({ success: true });
});

router.delete('/memories', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  getDb().prepare('DELETE FROM user_memories WHERE user_id = ?').run(user.id);
  res.json({ success: true });
});

// ── User settings ──────────────────────────────────────────────────────────────

const UserSettingsSchema = z.object({
  dark_mode: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  memory_enabled: z.boolean().optional(),
  auto_backup_enabled: z.boolean().optional(),
  auto_backup_trigger: z.enum(['task', 'tokens', 'minutes']).optional(),
  auto_backup_interval: z.number().int().min(1).optional(),
  max_tokens_per_session: z.number().int().positive().nullable().optional(),
});

router.patch('/settings', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = UserSettingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const db = getDb();
  const update = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  for (const [key, val] of Object.entries(parsed.data)) {
    if (val !== undefined && key !== 'max_tokens_per_session') {
      update.run(`user_${user.id}_${key}`, String(val));
    }
  }
  // max_tokens_per_session lives on the users table
  if (parsed.data.max_tokens_per_session !== undefined) {
    db.prepare('UPDATE users SET max_tokens_per_session = ? WHERE id = ?')
      .run(parsed.data.max_tokens_per_session, user.id);
  }
  res.json({ success: true });
});

// ── Change password ────────────────────────────────────────────────────────────

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6).max(100),
});

router.post('/change-password', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = ChangePasswordSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'New password must be at least 6 characters.' }); return; }
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string } | undefined;
  if (!row) { res.status(404).json({ error: 'User not found' }); return; }
  if (!bcrypt.compareSync(parsed.data.current_password, row.password_hash)) {
    res.status(400).json({ error: 'Current password is incorrect.' }); return;
  }
  const newHash = bcrypt.hashSync(parsed.data.new_password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  res.json({ success: true });
});

// ── Public contact info (for Contact Us page) ──────────────────────────────────

router.get('/contact', (_req: Request, res: Response) => {
  const info = getDb().prepare('SELECT phone, email, website, whatsapp, support_message FROM contact_info WHERE id = 1').get();
  res.json(info || {});
});

// ── Public pricing (for landing page, no auth required) ───────────────────────

router.get('/pricing-public', (_req: Request, res: Response) => {
  const modes = getDb().prepare(
    'SELECT mode, display_name, description, input_token_base_cost, output_token_base_cost FROM pricing_modes ORDER BY id'
  ).all();
  res.json(modes);
});

// ── Balance check ──────────────────────────────────────────────────────────────

router.get('/balance', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const balance = getUserBalance(user.id as number);
  res.json({ balance });
});

interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  balance: number;
  wallet_balance: number;
  wallet_auto_spend: number;
  selected_mode: string;
  max_tokens_per_session: number | null;
  is_active: number;
}

interface PricingRow {
  mode: string;
  display_name: string;
  description: string;
  global_max_tokens: number | null;
}

// ── Bridge token (for BridgeSetup page) ───────────────────────────────────────
// Returns the same JWT already in the cookie so the bridge CLI can use it.
// Since it's httpOnly, the frontend can't read the cookie directly.
router.get('/bridge-token', (req: Request, res: Response) => {
  const token = req.cookies?.gaby_token;
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
  res.json({ token });
});

// ── Wallet ─────────────────────────────────────────────────────────────────────

const TransferSchema = z.object({
  amount: z.number().positive(),
});

/** Transfer credits → wallet (bot fuel tank). */
router.post('/wallet/transfer', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = TransferSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid amount' }); return; }
  try {
    const result = transferToWallet(user.id as number, parsed.data.amount);
    // Push both updated balances to the browser tab
    userClientManager.pushToUser(user.id as number, 'gaby:balance', {
      balance: result.newBalance,
      wallet_balance: result.newWalletBalance,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Transfer failed' });
  }
});

/** Toggle wallet auto-spend (drain main balance when wallet is empty). */
router.patch('/wallet/auto-spend', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  getDb().prepare('UPDATE users SET wallet_auto_spend = ? WHERE id = ?')
    .run(parsed.data.enabled ? 1 : 0, user.id);
  res.json({ success: true });
});

// ── Project Rules (.gaby-rules) ─────────────────────────────────────────────

/** Get rules for a project (returns null if none set) */
router.get('/projects/:id/rules', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  const rules = loadProjectRules(proj.local_path);
  res.json({ rules });
});

/** Save or update rules for a project */
router.put('/projects/:id/rules', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const parsed = z.object({ content: z.string().max(8192) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const proj = getDb().prepare('SELECT local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  try {
    saveProjectRules(proj.local_path, parsed.data.content);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save rules' });
  }
});

/** Delete rules for a project */
router.delete('/projects/:id/rules', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  deleteProjectRules(proj.local_path);
  res.json({ success: true });
});

// ── Usage Stats ──────────────────────────────────────────────────────────────

/** Return daily + mode-level token/cost summary for the authenticated user */
router.get('/me/usage', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const days = Math.min(90, Math.max(1, parseInt((req.query.days as string) || '30', 10)));
  const db = getDb();
  const byDay = db.prepare(`
    SELECT date(created_at) as day,
           SUM(input_tokens)       as input_tokens,
           SUM(output_tokens)      as output_tokens,
           SUM(cache_read_tokens)  as cache_read_tokens,
           SUM(charged_cost)       as charged_cost
    FROM usage_log
    WHERE user_id = ? AND created_at >= date('now', '-' || ? || ' days')
    GROUP BY day ORDER BY day ASC
  `).all(user.id, days) as { day: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; charged_cost: number }[];

  const byMode = db.prepare(`
    SELECT mode,
           SUM(input_tokens)  as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(charged_cost)  as charged_cost
    FROM usage_log WHERE user_id = ?
    GROUP BY mode ORDER BY charged_cost DESC
  `).all(user.id) as { mode: string; input_tokens: number; output_tokens: number; charged_cost: number }[];

  const totals = db.prepare(`
    SELECT COALESCE(SUM(input_tokens),0)      as input_tokens,
           COALESCE(SUM(output_tokens),0)     as output_tokens,
           COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
           COALESCE(SUM(charged_cost),0)      as charged_cost
    FROM usage_log WHERE user_id = ?
  `).get(user.id) as { input_tokens: number; output_tokens: number; cache_read_tokens: number; charged_cost: number };

  res.json({ by_day: byDay, by_mode: byMode, totals });
});

// ── Checkpoints ───────────────────────────────────────────────────────────────

/** List recent checkpoint commits for a project */
router.get('/projects/:id/checkpoints', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  try {
    const checkpoints = await listCheckpoints(user.id as number, proj.local_path);
    res.json({ checkpoints });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list checkpoints' });
  }
});

/** Roll back a project to a checkpoint by SHA */
router.post('/projects/:id/checkpoints/rollback', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const parsed = z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/i) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid SHA' }); return; }
  const proj = getDb().prepare('SELECT local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  try {
    await rollbackToCheckpoint(user.id as number, proj.local_path, parsed.data.sha);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Rollback failed' });
  }
});

export default router;
