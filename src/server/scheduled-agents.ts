/**
 * SUNy Scheduled Agents â€” Cron-based task scheduling.
 *
 * Allows users to schedule agent runs at specific times/intervals.
 * Examples:
 *   - "Run code review on this project every Monday at 9am"
 *   - "Scan for dependency updates daily at midnight"
 *   - "Generate a progress report every Friday at 5pm"
 */

import { getDb } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ScheduleFrequency = 'once' | 'hourly' | 'daily' | 'weekly' | 'custom_cron';

export interface ScheduledAgent {
  id: number;
  user_id: number;
  project_id: number | null;
  name: string;
  description: string;
  prompt: string;
  frequency: ScheduleFrequency;
  cron_expression: string | null;
  mode: string;
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  total_runs: number;
  success_runs: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduledAgentLog {
  id: number;
  agent_id: number;
  status: 'running' | 'success' | 'failed';
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result_summary: string | null;
  error_message: string | null;
}

// â”€â”€ Database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      frequency TEXT NOT NULL CHECK(frequency IN ('once', 'hourly', 'daily', 'weekly', 'custom_cron')),
      cron_expression TEXT,
      mode TEXT NOT NULL DEFAULT 'fast',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      total_runs INTEGER NOT NULL DEFAULT 0,
      success_runs INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS scheduled_agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER,
      result_summary TEXT,
      error_message TEXT,
      FOREIGN KEY (agent_id) REFERENCES scheduled_agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_run
      ON scheduled_agents(is_active, next_run_at);
  `);
}

// â”€â”€ CRUD operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createScheduledAgent(params: {
  userId: number;
  projectId?: number;
  name: string;
  description?: string;
  prompt: string;
  frequency: ScheduleFrequency;
  cronExpression?: string;
  mode?: string;
}): ScheduledAgent {
  ensureTable();
  const db = getDb();

  // Calculate next run time
  const nextRun = calculateNextRun(params.frequency, params.cronExpression);

  const result = db.prepare(`
    INSERT INTO scheduled_agents (user_id, project_id, name, description, prompt, frequency, cron_expression, mode, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.userId,
    params.projectId ?? null,
    params.name,
    params.description || '',
    params.prompt,
    params.frequency,
    params.cronExpression || null,
    params.mode || 'fast',
    nextRun,
  );

  return db.prepare('SELECT * FROM scheduled_agents WHERE id = ?').get(result.lastInsertRowid) as ScheduledAgent;
}

export function updateScheduledAgent(
  id: number,
  updates: Partial<{
    name: string;
    description: string;
    prompt: string;
    frequency: ScheduleFrequency;
    cronExpression: string;
    mode: string;
    isActive: boolean;
  }>,
): ScheduledAgent | null {
  ensureTable();
  const db = getDb();

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.frequency !== undefined) {
    fields.push('frequency = ?'); values.push(updates.frequency);
    fields.push('next_run_at = ?');
    values.push(calculateNextRun(updates.frequency, updates.cronExpression));
  }
  if (updates.cronExpression !== undefined) { fields.push('cron_expression = ?'); values.push(updates.cronExpression); }
  if (updates.mode !== undefined) { fields.push('mode = ?'); values.push(updates.mode); }
  if (updates.isActive !== undefined) { fields.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }

  if (fields.length === 0) return getScheduledAgent(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE scheduled_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getScheduledAgent(id);
}

export function getScheduledAgent(id: number): ScheduledAgent | null {
  ensureTable();
  const db = getDb();
  return db.prepare('SELECT * FROM scheduled_agents WHERE id = ?').get(id) as ScheduledAgent | null;
}

export function listScheduledAgents(userId: number): ScheduledAgent[] {
  ensureTable();
  const db = getDb();
  return db.prepare(
    'SELECT * FROM scheduled_agents WHERE user_id = ? ORDER BY next_run_at ASC'
  ).all(userId) as ScheduledAgent[];
}

export function deleteScheduledAgent(id: number): boolean {
  ensureTable();
  const db = getDb();
  const result = db.prepare('DELETE FROM scheduled_agents WHERE id = ?').run(id);
  return result.changes > 0;
}

// â”€â”€ Execution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function executeScheduledAgent(agent: ScheduledAgent): Promise<ScheduledAgentLog> {
  ensureTable();
  const db = getDb();
  const startedAt = new Date().toISOString();

  // Create log entry
  const logResult = db.prepare(`
    INSERT INTO scheduled_agent_logs (agent_id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(agent.id, startedAt);
  const logId = logResult.lastInsertRowid as number;

  try {
    // Run the agent prompt using the agent-loop
    const { runAgentLoop } = require('./agent-loop');

    const result = await runAgentLoop({
      userId: agent.user_id,
      mode: agent.mode,
      systemPrompt: agent.prompt,
      projectPath: agent.project_id ? getProjectPath(agent.project_id) : undefined,
      projectId: agent.project_id ?? undefined,
      history: [],
      userMessage: agent.prompt,
      sessionId: `scheduled_${agent.id}`,
      budgetCapCredits: 0.25, // Stop at $0.25 to prevent runaway background agents
      onBudgetWarning: () => {},
      onBudgetGate: async () => 'stop', // Auto-stop when cap reached
    });

    const finishedAt = new Date().toISOString();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    // Update log
    db.prepare(`
      UPDATE scheduled_agent_logs
      SET status = 'success', finished_at = ?, duration_ms = ?, result_summary = ?
      WHERE id = ?
    `).run(finishedAt, durationMs, result.content.slice(0, 500), logId);

    // Update agent stats
    const nextRun = calculateNextRun(agent.frequency, agent.cron_expression);
    db.prepare(`
      UPDATE scheduled_agents
      SET last_run_at = ?, next_run_at = ?, total_runs = total_runs + 1, success_runs = success_runs + 1
      WHERE id = ?
    `).run(startedAt, nextRun, agent.id);

    // Handle 'once' agents â€” deactivate after first successful run
    if (agent.frequency === 'once') {
      db.prepare('UPDATE scheduled_agents SET is_active = 0 WHERE id = ?').run(agent.id);
    }

    return db.prepare('SELECT * FROM scheduled_agent_logs WHERE id = ?').get(logId) as ScheduledAgentLog;
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const errorMsg = (err as Error).message || 'Unknown error';

    db.prepare(`
      UPDATE scheduled_agent_logs
      SET status = 'failed', finished_at = ?, error_message = ?
      WHERE id = ?
    `).run(finishedAt, errorMsg.slice(0, 1000), logId);

    db.prepare(`
      UPDATE scheduled_agents
      SET last_run_at = ?, total_runs = total_runs + 1
      WHERE id = ?
    `).run(startedAt, agent.id);

    return db.prepare('SELECT * FROM scheduled_agent_logs WHERE id = ?').get(logId) as ScheduledAgentLog;
  }
}

export function getAgentLogs(agentId: number, limit = 20): ScheduledAgentLog[] {
  ensureTable();
  const db = getDb();
  return db.prepare(
    'SELECT * FROM scheduled_agent_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
  ).all(agentId, limit) as ScheduledAgentLog[];
}

// â”€â”€ Scheduler loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler(checkIntervalMs = 60_000): void {
  if (schedulerInterval) return;
  console.log('[scheduler] Starting scheduled agent scheduler...');

  schedulerInterval = setInterval(async () => {
    try {
      ensureTable();
      const db = getDb();
      const now = new Date().toISOString();

      const due = db.prepare(`
        SELECT * FROM scheduled_agents
        WHERE is_active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC
      `).all(now) as ScheduledAgent[];

      for (const agent of due) {
        console.log(`[scheduler] Running agent "${agent.name}" (id=${agent.id})`);
        executeScheduledAgent(agent).catch(err => {
          console.error(`[scheduler] Agent "${agent.name}" failed:`, (err as Error).message);
        });
      }
    } catch (err) {
      console.error('[scheduler] Error in scheduler loop:', (err as Error).message);
    }
  }, checkIntervalMs);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[scheduler] Stopped.');
  }
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function calculateNextRun(frequency: ScheduleFrequency, cronExpression?: string | null): string {
  const now = new Date();

  switch (frequency) {
    case 'once':
      return new Date(now.getTime() + 60_000).toISOString(); // 1 minute from now
    case 'hourly':
      return new Date(now.getTime() + 3600_000).toISOString();
    case 'daily':
      return new Date(now.getTime() + 86400_000).toISOString();
    case 'weekly':
      return new Date(now.getTime() + 604800_000).toISOString();
    case 'custom_cron': {
      // Simple cron parser approximation â€” default to 1 hour
      // For a full cron parser, consider `cron-parser` npm package
      if (cronExpression) {
        // Very basic: detect daily patterns like "0 9 * * *" (9am daily)
        if (cronExpression.includes('0 9') || cronExpression.includes('0 0')) {
          return new Date(now.getTime() + 86400_000).toISOString();
        }
        if (cronExpression.startsWith('0 */')) {
          const hours = parseInt(cronExpression.split('*/')[1]?.split(' ')[0] || '1', 10);
          return new Date(now.getTime() + hours * 3600_000).toISOString();
        }
      }
      return new Date(now.getTime() + 3600_000).toISOString();
    }
    default:
      return new Date(now.getTime() + 86400_000).toISOString();
  }
}

function getProjectPath(projectId: number): string {
  const db = getDb();
  const project = db.prepare('SELECT local_path FROM projects WHERE id = ?').get(projectId) as { local_path: string } | undefined;
  return project?.local_path || '';
}
