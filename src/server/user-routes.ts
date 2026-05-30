import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { requireAuth, AuthRequest, signToken, verifyToken } from './auth';
import { getDb } from './db';
import { hasSufficientBalance, getUserBalance, friendlySessionLimit, deductUsage, transferToWallet } from './billing';

import { userClientManager } from './user-client-manager';
import { loadProjectRules, saveProjectRules, deleteProjectRules } from './project-rules';
import { listCheckpoints, rollbackToCheckpoint } from './git-manager';
import { getBlueprintEntries } from './blueprint-memory';
import { buildChunkVectors, getChunkStats, clearChunkIndex } from './code-chunks';
import { indexProject } from './code-index';
import { evaluate } from 'mathjs';

const router = Router();

// â”€â”€ Public routes (no auth required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/contact', (_req: Request, res: Response) => {
  const info = getDb().prepare('SELECT phone, email, website, whatsapp, support_message FROM contact_info WHERE id = 1').get();
  res.json(info || {});
});

router.get('/plan-features-public', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const flags = db.prepare(
      `SELECT key, plan, enabled, label, description FROM plan_feature_flags ORDER BY key, plan`
    ).all() as Array<{ key: string; plan: string; enabled: number; label: string; description: string }>;
    const limitRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'regular_daily_message_limit'`).get() as { value: string } | undefined;
    const regularDailyLimit = limitRow ? parseInt(limitRow.value, 10) || null : null;
    res.json({ flags: flags.map(f => ({ ...f, enabled: f.enabled === 1 })), regular_daily_limit: regularDailyLimit });
  } catch {
    res.json({ flags: [], regular_daily_limit: null });
  }
});

router.get('/pricing-public', (_req: Request, res: Response) => {
  // Only expose user-facing fields — never expose base token costs, markup formulas, or model IDs.
  const modes = getDb().prepare(
    'SELECT mode, display_name, description, input_token_base_cost, output_token_base_cost, markup_formula FROM pricing_modes ORDER BY id'
  ).all() as Array<{
    mode: string; display_name: string; description: string;
    input_token_base_cost: number; output_token_base_cost: number;
    markup_formula: string;
  }>;
  const enriched = modes.map(m => {
    // Original provider price (what user would pay using the AI model directly)
    const originalInput1M = m.input_token_base_cost * 1_000_000;
    const originalOutput1M = m.output_token_base_cost * 1_000_000;

    // Compute display price per 1M tokens with markup applied — only the final
    // user-facing price is returned, never the raw base cost or formula.
    let priceInput1M = originalInput1M;
    let priceOutput1M = originalOutput1M;
    try {
      priceInput1M = evaluate(m.markup_formula, {
        cost: originalInput1M, input_tokens: 1_000_000, output_tokens: 0,
        cache_write_tokens: 0, cache_read_tokens: 0,
      }) as number;
      priceOutput1M = evaluate(m.markup_formula, {
        cost: originalOutput1M, input_tokens: 0, output_tokens: 1_000_000,
        cache_write_tokens: 0, cache_read_tokens: 0,
      }) as number;
    } catch { /* fallback to base */ }

    const finalInput = typeof priceInput1M === 'number' && !isNaN(priceInput1M) ? priceInput1M : originalInput1M;
    const finalOutput = typeof priceOutput1M === 'number' && !isNaN(priceOutput1M) ? priceOutput1M : originalOutput1M;

    // Compute effective input price assuming 80% cache hit rate.
    // Cache reads are billed to user at 0.60x input rate (see billing.ts).
    // Effective = 20% fresh tokens + 80% cached at 0.60x = markup × (0.20 + 0.80×0.60) = markup × 0.68
    // Add 5% tolerance to effective price shown to user for credibility and honesty
    const effectiveInput1M = finalInput * 0.68 * 1.05;

    // savings_pct: how much cheaper SUNy is vs going directly to the AI model.
    // Positive = cheaper. null = not cheaper (don't show badge).
    let savings_pct: number | null = null;
    if (originalInput1M > 0) {
      const pct = Math.round((1 - effectiveInput1M / originalInput1M) * 100);
      if (pct > 0) savings_pct = pct;
    }

    return {
      mode: m.mode,
      display_name: m.display_name,
      description: m.description,
      input_price_per_1m: effectiveInput1M,
      output_price_per_1m: finalOutput,
      original_input_price_per_1m: originalInput1M,
      original_output_price_per_1m: originalOutput1M,
      savings_pct, // null when no saving, or % when SUNy is cheaper
    };
  });
  res.json(enriched);
});


router.use(requireAuth);

// â”€â”€ Folder picker (bridge-first, native fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post('/pick-folder', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;

  try {
    if (req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
      res.status(400).json({ error: 'You must run SUNy locally to browse local folders from a remote server.' });
      return;
    }

    const { execFile } = await import('child_process');
    const runPicker = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
      execFile(file, args, { windowsHide: true }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout || '').trim());
      });
    });

    let selected = '';

    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$dialog.Description = 'Choose a folder for your project'",
        '$dialog.ShowNewFolderButton = $true',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
      ].join('; ');
      selected = await runPicker('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
    } else if (process.platform === 'darwin') {
      selected = await runPicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for your project")']);
    } else {
      const linuxPickers: Array<{ cmd: string; args: string[] }> = [
        { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Choose a folder for your project'] },
        { cmd: 'kdialog', args: ['--getexistingdirectory', '--title', 'Choose a folder for your project'] },
      ];
      for (const picker of linuxPickers) {
        try {
          selected = await runPicker(picker.cmd, picker.args);
          if (selected) break;
        } catch {
          // Try next picker.
        }
      }
    }

    if (!selected) {
      res.status(400).json({ error: 'No folder selected' });
      return;
    }

    res.json({ path: selected });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to pick folder' });
  }
});

// â”€â”€ User profile & balance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/me', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const db = getDb();
  const row = db.prepare(`
    SELECT id, username, display_name, balance, wallet_balance, wallet_auto_spend, selected_mode, max_tokens_per_session, is_active, role, bridge_ever_connected, plan
    FROM users WHERE id = ?
  `).get(user.id) as UserRow | undefined;

  if (!row) { res.status(404).json({ error: 'User not found' }); return; }

  const pricing = db.prepare('SELECT * FROM pricing_modes ORDER BY id').all();
  const settings = getDb().prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
  const settingsMap: Record<string, string> = {};
  for (const s of settings) settingsMap[s.key] = s.value;
  const getUserSetting = (key: string, fallback: string) => {
    const scoped = settingsMap[`user_${user.id}_${key}`];
    if (scoped !== undefined) return scoped;
    return settingsMap[key] ?? fallback;
  };

  // Get role from users table (default 'user' for backward compat)
  const roleRow = db.prepare("SELECT role FROM users WHERE id = ?").get(user.id) as { role?: string } | undefined;
  const role = roleRow?.role === 'admin' ? 'admin' : 'user';

  res.json({
    id: row.id,
    username: row.username,
    role,
    display_name: row.display_name ?? null,
    balance: row.balance,
    wallet_balance: row.wallet_balance,
    wallet_auto_spend: row.wallet_auto_spend === 1,
    selected_mode: row.selected_mode,
    max_tokens_per_session: row.max_tokens_per_session,
    session_limit_label: friendlySessionLimit(row.max_tokens_per_session),
    is_active: row.is_active === 1,
    auto_approve: getUserSetting('auto_approve', 'true') === 'true',
    memory_enabled: getUserSetting('memory_enabled', 'true') === 'true',
    cross_device_memory_enabled: getUserSetting('cross_device_memory_enabled', 'false') === 'true',
    chat_show_technical_details: getUserSetting('chat_show_technical_details', 'false') === 'true',
    task_interruption_behavior: getUserSetting('task_interruption_behavior', 'interrupt'),
    budget_gate_enabled: getUserSetting('budget_gate_enabled', 'false') === 'true',
    budget_per_run: parseFloat(getUserSetting('budget_per_run', '0')) || 0,
    forecast_enabled: getUserSetting('forecast_enabled', 'false') === 'true',
    forecast_markup_mode: getUserSetting('forecast_markup_mode', ''),
    modes: (() => {
      const list = (pricing as PricingRow[]).map(p => {
        const keyCount = (db.prepare('SELECT COUNT(*) as cnt FROM api_keys WHERE mode = ? AND is_active = 1').get(p.mode) as { cnt: number }).cnt;
        const originalInput1M = p.input_token_base_cost * 1_000_000;
        let finalInput = originalInput1M;
        try {
          finalInput = evaluate(p.markup_formula, { cost: originalInput1M, input_tokens: 1_000_000, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 }) as number;
        } catch {}
        const effectiveInput1M = finalInput * 0.68 * 1.05;
        let savings_pct: number | null = null;
        if (originalInput1M > 0) {
          const pct = Math.round((1 - effectiveInput1M / originalInput1M) * 100);
          if (pct > 0) savings_pct = pct;
        }

        return {
          mode: p.mode,
          display_name: p.display_name,
          description: p.description ?? '',
          // Never expose formula, token costs, or max_tokens as raw numbers
          session_limit_label: friendlySessionLimit(p.global_max_tokens),
          has_active_key: keyCount > 0,
          savings_pct,
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
    plan: (row as any).plan ?? 'regular',
    plan_features: (() => {
      const userPlan = (row as any).plan ?? 'regular';
      const features = db.prepare(
        `SELECT key, enabled FROM plan_feature_flags WHERE plan = ?`
      ).all(userPlan) as Array<{ key: string; enabled: number }>;
      const map: Record<string, boolean> = {};
      for (const f of features) map[f.key] = f.enabled === 1;
      return map;
    })(),
    upgrade_pending: !!(db.prepare(`SELECT id FROM plan_upgrade_requests WHERE user_id = ? AND status = 'pending'`).get(user.id)),
  });
});

// ── Usage stats ──────────────────────────────────────────────────────────────

router.get('/me/usage', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const db = getDb();
  const days = Math.min(parseInt((req.query.days as string) ?? '14', 10) || 14, 365);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const byDay = db.prepare(`
    SELECT date(timestamp) as day,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cache_read_tokens) as cache_read_tokens,
           SUM(charged_cost) as charged_cost
    FROM usage_log
    WHERE user_id = ? AND date(timestamp) >= ?
    GROUP BY day ORDER BY day ASC
  `).all(user.id, since) as Array<{ day: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; charged_cost: number }>;

  const byMode = db.prepare(`
    SELECT mode,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(charged_cost) as charged_cost
    FROM usage_log
    WHERE user_id = ? AND date(timestamp) >= ?
    GROUP BY mode ORDER BY charged_cost DESC
  `).all(user.id, since) as Array<{ mode: string; input_tokens: number; output_tokens: number; charged_cost: number }>;

  const byProject = db.prepare(`
    SELECT ul.project_id,
           COALESCE(p.name, CASE WHEN ul.project_id IS NULL THEN 'No Project' ELSE 'Project #' || ul.project_id END) as project_name,
           SUM(ul.input_tokens) as input_tokens,
           SUM(ul.output_tokens) as output_tokens,
           SUM(ul.charged_cost) as charged_cost
    FROM usage_log ul
    LEFT JOIN projects p ON p.id = ul.project_id
    WHERE ul.user_id = ? AND date(ul.timestamp) >= ?
    GROUP BY ul.project_id ORDER BY charged_cost DESC
    LIMIT 20
  `).all(user.id, since) as Array<{ project_id: number | null; project_name: string; input_tokens: number; output_tokens: number; charged_cost: number }>;

  const totals = db.prepare(`
    SELECT SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cache_read_tokens) as cache_read_tokens,
           SUM(charged_cost) as charged_cost
    FROM usage_log
    WHERE user_id = ? AND date(timestamp) >= ?
  `).get(user.id, since) as { input_tokens: number; output_tokens: number; cache_read_tokens: number; charged_cost: number } | undefined;

  res.json({
    by_day: byDay,
    by_mode: byMode,
    by_project: byProject,
    totals: totals ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, charged_cost: 0 },
  });
});

router.post('/upgrade-request', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const db = getDb();
  const row = db.prepare('SELECT username, plan FROM users WHERE id = ?').get(user.id) as { username: string; plan: string | null } | undefined;
  if (!row) { res.status(404).json({ error: 'User not found' }); return; }
  const currentPlan = row.plan ?? 'regular';
  if (currentPlan === 'pro') { res.status(400).json({ error: 'You are already on the PRO plan.' }); return; }
  const existing = db.prepare(`SELECT id FROM plan_upgrade_requests WHERE user_id = ? AND status = 'pending'`).get(user.id);
  if (existing) { res.json({ success: true, alreadyPending: true }); return; }
  const note = typeof (req.body as any).note === 'string' ? (req.body as any).note.trim().slice(0, 300) : '';
  db.prepare(`INSERT INTO plan_upgrade_requests (user_id, username, current_plan, requested_plan, note) VALUES (?, ?, ?, 'pro', ?)`).run(user.id, row.username, currentPlan, note);
  res.json({ success: true, alreadyPending: false });
});

// â”€â”€ Update display name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Projects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/projects', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  let projects: Array<{
    id: number;
    name: string;
    local_path: string;
    persona: string | null;
    auto_execute_override: number | null;
    default_tier: string | null;
    created_at: string;
  }>;
  try {
    projects = getDb().prepare('SELECT id, name, local_path, persona, auto_execute_override, default_tier, created_at FROM projects WHERE user_id = ?').all(user.id) as typeof projects;
  } catch {
    // Column may not exist on older DBs — fall back to query without it
    const rows = getDb().prepare('SELECT id, name, local_path, persona, created_at FROM projects WHERE user_id = ?').all(user.id) as Array<{
      id: number; name: string; local_path: string; persona: string | null; created_at: string;
    }>;
    projects = rows.map(r => ({ ...r, auto_execute_override: null, default_tier: null }));
  }
  res.json(projects.map(p => ({
    ...p,
    auto_execute_override: p.auto_execute_override === null ? null : p.auto_execute_override === 1,
  })));
});

router.get('/projects/spend', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const rows = getDb().prepare(`
    SELECT
      p.id as project_id,
      p.name,
      COALESCE(SUM(u.input_tokens + u.output_tokens), 0) as total_tokens,
      COALESCE(SUM(u.charged_cost), 0) as total_cost
    FROM projects p
    LEFT JOIN usage_log u ON u.project_id = p.id AND u.user_id = p.user_id
    WHERE p.user_id = ?
    GROUP BY p.id, p.name
    ORDER BY total_cost DESC, p.created_at DESC
  `).all(user.id) as { project_id: number; name: string; total_tokens: number; total_cost: number }[];
  res.json(rows);
});

function isAbsolutePath(p: string): boolean {
  // Windows: starts with drive letter e.g. C:\ or C:/
  // Windows UNC: \\server\share
  // Unix: starts with /
  return /^[A-Za-z]:[\\//]/.test(p) || /^\\\\/.test(p) || p.startsWith('/');
}

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  local_path: z.string().min(1).max(500),
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

  const db = getDb();
  const proj = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }

  try {
    const deleteProjectTx = db.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;

      for (const { name } of tables) {
        // Keep usage history so deleted projects still appear in time-filtered stats.
        if (name === 'projects' || name === 'usage_log') continue;
        const escapedName = name.replace(/"/g, '""');
        const columns = db.prepare(`PRAGMA table_info("${escapedName}")`).all() as Array<{ name: string }>;
        const columnNames = new Set(columns.map(c => c.name));

        if (columnNames.has('project_id')) {
          const sql = columnNames.has('user_id')
            ? `DELETE FROM "${escapedName}" WHERE project_id = ? AND user_id = ?`
            : `DELETE FROM "${escapedName}" WHERE project_id = ?`;
          db.prepare(sql).run(...(columnNames.has('user_id') ? [id, user.id] : [id]));
        }

        if (columnNames.has('source_project_id')) {
          const sql = columnNames.has('user_id')
            ? `DELETE FROM "${escapedName}" WHERE source_project_id = ? AND user_id = ?`
            : `DELETE FROM "${escapedName}" WHERE source_project_id = ?`;
          db.prepare(sql).run(...(columnNames.has('user_id') ? [id, user.id] : [id]));
        }
      }

      const result = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, user.id);
      if (result.changes === 0) {
        throw new Error('Project deletion did not remove any rows');
      }
    });

    deleteProjectTx();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete project' });
  }
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

/** Set project-level auto execute override (null = inherit global setting) */
router.patch('/projects/:id/auto-execute', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const parsed = z.object({ enabled: z.boolean().nullable() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  const raw = parsed.data.enabled;
  const dbValue = raw === null ? null : (raw ? 1 : 0);
  getDb().prepare('UPDATE projects SET auto_execute_override = ? WHERE id = ?').run(dbValue, id);
  res.json({ success: true, auto_execute_override: raw });
});

/** Set the default tier (free/fast/pro/auto) that this project should use. null = inherit user preference. */
router.patch('/projects/:id/default-tier', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const parsed = z.object({
    tier: z.enum(['free', 'fast', 'pro', 'auto']).nullable(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid tier' }); return; }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  getDb().prepare('UPDATE projects SET default_tier = ? WHERE id = ?').run(parsed.data.tier, id);
  res.json({ success: true, default_tier: parsed.data.tier });
});

// â”€â”€ Memories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ User settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const UserSettingsSchema = z.object({
  dark_mode: z.boolean().optional(),
  auto_approve: z.boolean().optional(),
  memory_enabled: z.boolean().optional(),
  cross_device_memory_enabled: z.boolean().optional(),
  chat_show_technical_details: z.boolean().optional(),
  auto_backup_enabled: z.boolean().optional(),
  auto_backup_trigger: z.enum(['task', 'tokens', 'minutes']).optional(),
  auto_backup_interval: z.number().int().min(1).optional(),
  max_tokens_per_session: z.number().int().positive().nullable().optional(),
  task_interruption_behavior: z.enum(['interrupt', 'queue']).optional(),
  budget_gate_enabled: z.boolean().optional(),
  budget_per_run: z.number().min(0).optional(),
  forecast_enabled: z.boolean().optional(),
  forecast_markup_mode: z.string().max(32).optional(),
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

// â”€â”€ Change password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Balance check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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



// â”€â”€ Wallet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TransferSchema = z.object({
  amount: z.number().positive(),
});

/** Transfer credits â†’ wallet (bot fuel tank). */
router.post('/wallet/transfer', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = TransferSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid amount' }); return; }
  try {
    const result = transferToWallet(user.id as number, parsed.data.amount);
    // Push both updated balances to the browser tab
    userClientManager.pushToUser(user.id as number, 'suny:balance', {
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

// â”€â”€ Top-up Requests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Users file a request; an admin reviews it in the admin dashboard and either
// approves (which calls the existing wallet_balance_set / transferToWallet path)
// or rejects with a note. No live payment processor yet — keeps things honest.

const TopupRequestSchema = z.object({
  amount: z.number().positive().max(10000),
  note: z.string().max(500).optional().default(''),
});

router.post('/billing/topup-request', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = TopupRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a valid amount (positive, â‰¤ 10000)' }); return; }
  // Throttle: reject if user already has 3+ pending requests.
  const pending = getDb().prepare("SELECT COUNT(*) as c FROM topup_requests WHERE user_id = ? AND status = 'pending'")
    .get(user.id) as { c: number };
  if (pending.c >= 3) {
    res.status(429).json({ error: 'You already have 3 pending top-up requests. Wait for an admin to process them first.' });
    return;
  }
  const result = getDb().prepare(
    'INSERT INTO topup_requests (user_id, amount, note) VALUES (?, ?, ?)',
  ).run(user.id, parsed.data.amount, parsed.data.note);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.get('/billing/topup-requests', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const rows = getDb().prepare(
    'SELECT id, amount, note, status, admin_notes, created_at, resolved_at FROM topup_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
  ).all(user.id);
  res.json(rows);
});

// â”€â”€ Project Rules (.suny-rules) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Usage Stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Return daily + mode + project token/cost summary for the authenticated user */
router.get('/me/usage', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const days = Math.min(90, Math.max(1, parseInt((req.query.days as string) || '30', 10)));
  const db = getDb();
  const byDay = db.prepare(`
    SELECT date(timestamp) as day,
           SUM(input_tokens)       as input_tokens,
           SUM(output_tokens)      as output_tokens,
           SUM(charged_cost)       as charged_cost
    FROM usage_log
    WHERE user_id = ? AND timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY day ORDER BY day ASC
  `).all(user.id, days) as { day: string; input_tokens: number; output_tokens: number; charged_cost: number }[];

  const byMode = db.prepare(`
    SELECT mode,
           SUM(input_tokens)  as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(charged_cost)  as charged_cost
    FROM usage_log
    WHERE user_id = ? AND timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY mode ORDER BY charged_cost DESC
  `).all(user.id, days) as { mode: string; input_tokens: number; output_tokens: number; charged_cost: number }[];

  const byProject = db.prepare(`
    SELECT
      u.project_id as project_id,
      CASE
        WHEN u.project_id IS NULL THEN 'Global / No project'
        WHEN p.name IS NOT NULL THEN p.name
        ELSE 'Deleted project #' || u.project_id
      END as project_name,
      COALESCE(SUM(u.input_tokens),0)  as input_tokens,
      COALESCE(SUM(u.output_tokens),0) as output_tokens,
      COALESCE(SUM(u.charged_cost),0)  as charged_cost
    FROM usage_log u
    LEFT JOIN projects p ON p.id = u.project_id AND p.user_id = u.user_id
    WHERE u.user_id = ? AND u.timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY u.project_id, project_name
    ORDER BY charged_cost DESC, project_name ASC
  `).all(user.id, days) as { project_id: number | null; project_name: string; input_tokens: number; output_tokens: number; charged_cost: number }[];

  const totals = db.prepare(`
    SELECT COALESCE(SUM(input_tokens),0)      as input_tokens,
           COALESCE(SUM(output_tokens),0)     as output_tokens,
           COALESCE(SUM(charged_cost),0)      as charged_cost
    FROM usage_log
    WHERE user_id = ? AND timestamp >= datetime('now', '-' || ? || ' days')
  `).get(user.id, days) as { input_tokens: number; output_tokens: number; charged_cost: number };

  res.json({ by_day: byDay, by_mode: byMode, by_project: byProject, totals });
});

// â”€â”€ Checkpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Cross-device project state (chat + memories) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MessageReportSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  rawCost: z.number().nonnegative(),
  chargedCost: z.number().nonnegative(),
  humanEstimateMinutes: z.number().int().nonnegative(),
  humanEstimateCost: z.number().nonnegative(),
});

router.get('/projects/:id/state', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }

  const db = getDb();
  const proj = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }

  const row = db.prepare(`
    SELECT messages_json, memories_json, updated_at
    FROM user_project_state
    WHERE user_id = ? AND project_id = ?
  `).get(user.id, projectId) as { messages_json: string; memories_json: string; updated_at: string } | undefined;

  if (!row) {
    res.json({ messages: [], memories: [], updated_at: null });
    return;
  }

  let messages: unknown[] = [];
  let memories: unknown[] = [];
  try { messages = JSON.parse(row.messages_json || '[]'); } catch { messages = []; }
  try { memories = JSON.parse(row.memories_json || '[]'); } catch { memories = []; }

  res.json({
    messages: Array.isArray(messages) ? messages : [],
    memories: Array.isArray(memories) ? memories : [],
    updated_at: row.updated_at,
  });
});

const ProjectStateSchema = z.object({
  messages: z.array(z.object({
    id: z.number(),
    type: z.enum(['user', 'suny', 'system']),
    content: z.string().max(20000),
    timestamp: z.number().int().nonnegative().optional(),
    report: MessageReportSchema.optional(),
  })).max(200),
  memories: z.array(z.object({
    id: z.string().max(80),
    projectId: z.number(),
    title: z.string().max(200),
    summary: z.string().max(4000),
    createdAt: z.number(),
    updatedAt: z.number(),
  })).max(500),
});

router.put('/projects/:id/state', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }

  const parsed = ProjectStateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid state payload' }); return; }

  const db = getDb();
  const proj = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }

  db.prepare(`
    INSERT INTO user_project_state (user_id, project_id, messages_json, memories_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, project_id)
    DO UPDATE SET messages_json = excluded.messages_json,
                  memories_json = excluded.memories_json,
                  updated_at = datetime('now')
  `).run(
    user.id,
    projectId,
    JSON.stringify(parsed.data.messages),
    JSON.stringify(parsed.data.memories),
  );

  res.json({ success: true });
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

// â”€â”€ File browser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Return a shallow 2-level file tree for a project via the bridge */
router.get('/projects/:id/files', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }

  try {
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list files' });
  }
});

// â”€â”€ Dev server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// In-memory map: userId â†’ { pid, url }
const devServers = new Map<number, { url: string }>();

/** Start the project's dev server (npm run dev / vite / python server) */
router.post('/projects/:id/dev-server/start', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }


  // Detect what starter command to use
  const fs = await import('fs');
  const path = await import('path');
  const pkgPath = path.join(proj.local_path, 'package.json');
  let startCmd = 'python3 -m http.server 8080';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.scripts?.dev) startCmd = 'npm run dev';
    else if (pkg.scripts?.start) startCmd = 'npm start';
    else if (pkg.scripts?.serve) startCmd = 'npm run serve';
  } catch { /* no package.json — use python fallback */ }

  try {
    res.json({ url: 'http://localhost:3000', command: startCmd });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start dev server' });
  }
});

/** Stop the project's dev server */
router.post('/projects/:id/dev-server/stop', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  devServers.delete(user.id as number);
  res.json({ success: true });
});

// â”€â”€ Pinned Files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/projects/:id/pinned-files', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  const rows = getDb().prepare('SELECT file_path, created_at FROM pinned_files WHERE user_id = ? AND project_id = ? ORDER BY created_at ASC')
    .all(user.id, projectId) as Array<{ file_path: string; created_at: string }>;
  res.json({ files: rows.map(r => r.file_path) });
});

router.post('/projects/:id/pinned-files', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const { file_path } = req.body as { file_path?: string };
  if (!file_path || typeof file_path !== 'string' || file_path.includes('..')) {
    res.status(400).json({ error: 'Invalid file_path' }); return;
  }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  getDb().prepare('INSERT OR IGNORE INTO pinned_files (user_id, project_id, file_path) VALUES (?, ?, ?)')
    .run(user.id, projectId, file_path);
  res.json({ ok: true });
});

router.delete('/projects/:id/pinned-files/:filePath', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const filePath = decodeURIComponent(req.params.filePath);
  if (!filePath || filePath.includes('..')) { res.status(400).json({ error: 'Invalid file path' }); return; }
  getDb().prepare('DELETE FROM pinned_files WHERE user_id = ? AND project_id = ? AND file_path = ?')
    .run(user.id, projectId, filePath);
  res.json({ ok: true });
});

// â”€â”€ Vector Context: chunk stats + re-index â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/projects/:id/vector-stats', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(await getChunkStats(projectId));
});

router.post('/projects/:id/reindex', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT id, local_path FROM projects WHERE id = ? AND user_id = ?')
    .get(projectId, user.id) as { id: number; local_path: string } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ ok: true, message: 'Re-indexing started in background' });
  // Fire-and-forget
  setImmediate(async () => {
    try {
      // Clear old index keys so next message re-indexes
      getDb().prepare("DELETE FROM app_settings WHERE key IN (?, ?)")
        .run(`indexed:${proj.local_path}`, `chunk_indexed:${proj.local_path}`);
      // Run symbol index first, then chunk vectors
      indexProject(proj.local_path);
      await clearChunkIndex(projectId);
      const stats = await buildChunkVectors(proj.local_path, projectId);
      getDb().prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, 'true')").run(`indexed:${proj.local_path}`);
      getDb().prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, 'true')").run(`chunk_indexed:${proj.local_path}`);
      console.log(`[reindex] Project ${projectId}: ${stats.chunksIndexed} chunks across ${stats.filesProcessed} files`);
      userClientManager.pushToUser(user.id as number, 'suny:vector_index_ready', {
        projectId, chunks: stats.chunksIndexed, files: stats.filesProcessed,
      });
    } catch (err) {
      console.warn('[reindex] Failed:', (err as Error).message);
    }
  });
});

// â”€â”€ Memory Snapshots (unified replacement for forks) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// A snapshot captures the *full mind-state* of a moment: conversation +
// (optionally) blueprint memory, behavioral rules, tier, and active skills.
// Restoring is selective — user picks Conversation / Memory / Code via flags.

interface SnapshotRow {
  uid: string;
  label: string;
  kind: string;
  project_id: number | null;
  checkpoint_id: number | null;
  messages_json: string;
  blueprint_json: string | null;
  behavioral_rules_json: string | null;
  tier: string | null;
  skills_json: string | null;
  message_count: number;
  created_at: string;
}

const SnapshotCreateSchema = z.object({
  project_id: z.number().int().nullable().optional(),
  label: z.string().max(100).default(''),
  messages: z.array(z.any()).max(500),
  capture_memory: z.boolean().optional().default(false),
  tier: z.string().max(20).optional(),
  skills: z.array(z.string()).max(50).optional(),
});

const SnapshotRestoreSchema = z.object({
  restore_conversation: z.boolean().optional().default(true),
  restore_memory: z.boolean().optional().default(false),
  restore_code: z.boolean().optional().default(false),
});

function rowToSnapshot(r: SnapshotRow) {
  return {
    id: r.uid,
    label: r.label,
    kind: r.kind,
    project_id: r.project_id,
    checkpoint_id: r.checkpoint_id,
    savedAt: new Date(r.created_at).getTime(),
    message_count: r.message_count,
    has_memory: !!r.blueprint_json || !!r.behavioral_rules_json || !!r.tier,
    tier: r.tier,
    messages: (() => { try { return JSON.parse(r.messages_json); } catch { return []; } })(),
  };
}

/** List snapshots for this user, optionally filtered by project */
router.get('/snapshots', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt((req.query.project_id as string) || '', 10);
  const db = getDb();
  let rows: SnapshotRow[];
  if (!isNaN(projectId)) {
    rows = db.prepare(
      `SELECT uid, label, kind, project_id, checkpoint_id, messages_json,
              blueprint_json, behavioral_rules_json, tier, skills_json,
              message_count, created_at
       FROM memory_snapshots WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC`,
    ).all(user.id, projectId) as SnapshotRow[];
  } else {
    rows = db.prepare(
      `SELECT uid, label, kind, project_id, checkpoint_id, messages_json,
              blueprint_json, behavioral_rules_json, tier, skills_json,
              message_count, created_at
       FROM memory_snapshots WHERE user_id = ? ORDER BY created_at DESC`,
    ).all(user.id) as SnapshotRow[];
  }
  res.json(rows.map(rowToSnapshot));
});

/** Create a snapshot (manual save from chat header) */
router.post('/snapshots', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = SnapshotCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid snapshot data' }); return; }
  const uid = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const db = getDb();

  let blueprintJson: string | null = null;
  let rulesJson: string | null = null;
  if (parsed.data.capture_memory) {
    try {
      const entries = await getBlueprintEntries({
        userId: user.id as number,
        projectId: parsed.data.project_id ?? undefined,
        limit: 50,
      });
      blueprintJson = JSON.stringify(entries);
    } catch { /* best-effort */ }
    try {
      const rules = db.prepare(
        `SELECT id, category, rule_text, trigger_context, confidence, application_count
         FROM behavioral_rules WHERE user_id = ? AND (project_id IS NULL OR project_id = ?)
         ORDER BY confidence DESC LIMIT 100`,
      ).all(user.id, parsed.data.project_id ?? null);
      rulesJson = JSON.stringify(rules);
    } catch { /* best-effort */ }
  }

  db.prepare(
    `INSERT INTO memory_snapshots
       (uid, user_id, project_id, label, kind, messages_json,
        blueprint_json, behavioral_rules_json, tier, skills_json, message_count)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid,
    user.id,
    parsed.data.project_id ?? null,
    parsed.data.label,
    JSON.stringify(parsed.data.messages),
    blueprintJson,
    rulesJson,
    parsed.data.tier ?? null,
    parsed.data.skills ? JSON.stringify(parsed.data.skills) : null,
    parsed.data.messages.length,
  );
  res.json({ success: true, id: uid });
});

/** Restore a snapshot (selective: conversation / memory / code) */
router.post('/snapshots/:uid/restore', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const uid = req.params.uid;
  const parsed = SnapshotRestoreSchema.safeParse(req.body || {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid restore options' }); return; }
  const db = getDb();
  const snap = db.prepare(
    `SELECT * FROM memory_snapshots WHERE uid = ? AND user_id = ?`,
  ).get(uid, user.id) as SnapshotRow | undefined;
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return; }

  const result: {
    messages?: unknown[];
    memory_restored?: boolean;
    code_restored?: boolean;
    code_checkpoint_id?: number | null;
  } = {};

  if (parsed.data.restore_conversation) {
    try { result.messages = JSON.parse(snap.messages_json); } catch { result.messages = []; }
  }

  if (parsed.data.restore_memory && snap.blueprint_json) {
    // Memory restore is informational here — the agent-loop will read from the
    // frozen snapshot when projects.frozen_snapshot_uid is set. We don't
    // overwrite blueprint_entries / behavioral_rules tables on restore (would
    // destroy ongoing learning). Use the Freeze Brain toggle to apply the
    // snapshot's memory at request time instead.
    result.memory_restored = true;
  }

  if (parsed.data.restore_code) {
    // Code rollback is intentionally NOT auto-executed here — git operations
    // run through the bridge, which the client invokes via the existing
    // checkpoint-rollback endpoint. Surface the checkpoint_id so the UI can
    // chain the call.
    result.code_restored = false;
    result.code_checkpoint_id = snap.checkpoint_id;
  }

  res.json({ success: true, ...result });
});

/** Delete a snapshot */
router.delete('/snapshots/:uid', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const uid = req.params.uid;
  const db = getDb();
  const snap = db.prepare(
    'SELECT id FROM memory_snapshots WHERE uid = ? AND user_id = ?',
  ).get(uid, user.id);
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return; }
  db.prepare('DELETE FROM memory_snapshots WHERE uid = ? AND user_id = ?').run(uid, user.id);
  res.json({ success: true });
});

// â”€â”€ Freeze Brain (per-project) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Get current freeze status for a project */
router.get('/projects/:id/freeze', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const db = getDb();
  const proj = db.prepare(
    'SELECT frozen_snapshot_uid FROM projects WHERE id = ? AND user_id = ?',
  ).get(projectId, user.id) as { frozen_snapshot_uid: string | null } | undefined;
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  if (!proj.frozen_snapshot_uid) { res.json({ frozen: false }); return; }
  const snap = db.prepare(
    'SELECT uid, label, created_at, tier FROM memory_snapshots WHERE uid = ? AND user_id = ?',
  ).get(proj.frozen_snapshot_uid, user.id) as { uid: string; label: string; created_at: string; tier: string | null } | undefined;
  res.json({ frozen: !!snap, snapshot: snap ?? null });
});

/** Pin agent behavior to a snapshot */
router.post('/projects/:id/freeze', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  const { snapshot_uid } = req.body || {};
  if (isNaN(projectId) || typeof snapshot_uid !== 'string') {
    res.status(400).json({ error: 'project id and snapshot_uid required' }); return;
  }
  const db = getDb();
  const snap = db.prepare(
    'SELECT uid FROM memory_snapshots WHERE uid = ? AND user_id = ?',
  ).get(snapshot_uid, user.id);
  if (!snap) { res.status(404).json({ error: 'Snapshot not found' }); return; }
  const r = db.prepare(
    'UPDATE projects SET frozen_snapshot_uid = ? WHERE id = ? AND user_id = ?',
  ).run(snapshot_uid, projectId, user.id);
  if (r.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ success: true });
});

/** Unfreeze (resume live behavior) */
router.post('/projects/:id/unfreeze', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const db = getDb();
  const r = db.prepare(
    'UPDATE projects SET frozen_snapshot_uid = NULL WHERE id = ? AND user_id = ?',
  ).run(projectId, user.id);
  if (r.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json({ success: true });
});

// â”€â”€ Blueprint Memory Graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Return the design-decision timeline for a project */
router.get('/projects/:id/blueprint', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  const entries = getBlueprintEntries({ userId: user.id as number, projectId, limit: 50 });
  res.json({ entries });
});

// ── User Memories CRUD ────────────────────────────────────────────────────────

/** List all saved memories for the current user */
router.get('/memories', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, content, project_id, created_at FROM user_memories WHERE user_id = ? ORDER BY created_at DESC`
  ).all(user.id) as Array<{ id: number; content: string; project_id: number | null; created_at: string }>;
  res.json({ memories: rows });
});

/** Delete a specific memory by id */
router.delete('/memories/:id', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const memId = parseInt(req.params.id, 10);
  if (isNaN(memId)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const db = getDb();
  const r = db.prepare('DELETE FROM user_memories WHERE id = ? AND user_id = ?').run(memId, user.id);
  if (r.changes === 0) { res.status(404).json({ error: 'Memory not found' }); return; }
  res.json({ success: true });
});

// ── Codebase Health ──────────────────────────────────────────────────────────

/** GET /api/projects/:id/health — last N health log entries for a project */
router.get('/projects/:id/health', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }
  const proj = getDb().prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
  if (!proj) { res.status(404).json({ error: 'Project not found' }); return; }
  const { getHealthHistory, getLatestHealthScore } = require('./health-scorer');
  const history = getHealthHistory(projectId, 30);
  const latest = getLatestHealthScore(projectId);
  res.json({ history, latest });
});

/** Delete all memories for the current user (optional project filter) */
router.delete('/memories', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = req.query.project_id ? parseInt(req.query.project_id as string, 10) : null;
  const db = getDb();
  if (projectId) {
    db.prepare('DELETE FROM user_memories WHERE user_id = ? AND project_id = ?').run(user.id, projectId);
  } else {
    db.prepare('DELETE FROM user_memories WHERE user_id = ?').run(user.id);
  }
  res.json({ success: true });
});

export default router;
