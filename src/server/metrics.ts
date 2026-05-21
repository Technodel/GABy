/**
 * metrics.ts
 * Production monitoring for the SUNy agent loop.
 *
 * Records per-turn outcomes (success/failure, tool calls, latency, cost)
 * in the `agent_turn_metrics` table and exposes aggregated views for
 * the admin dashboard at GET /api/admin/metrics.
 */

import { getAdapter } from './db';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TurnRecord {
  userId: number;
  sessionId: string;
  projectId?: number | null;
  mode: string;
  /** Number of tool/function calls the agent made (0 = likely a non-answer) */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Raw USD cost charged to the user */
  costUsd: number;
  /** true = agent produced a useful response; false = fallback / error returned */
  success: boolean;
  /** Error category if not successful: 'api_error' | 'rate_limit' | 'timeout' | 'no_key' | 'credits' | 'lock' | 'unknown' */
  errorCategory?: string | null;
  /** Wall-clock ms for the agent loop (not including WS overhead) */
  durationMs: number;
}

// ── Write ──────────────────────────────────────────────────────────────────

/**
 * Record a single agent turn outcome.  Call this at the end of every turn,
 * both on success and in the error catch block in index.ts.
 */
export async function recordAgentTurn(rec: TurnRecord): Promise<void> {
  try {
    const db = getAdapter();
    await db.run(`
      INSERT INTO agent_turn_metrics
        (user_id, session_id, project_id, mode, tool_calls,
         input_tokens, output_tokens, cost_usd, success, error_category, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      rec.userId,
      rec.sessionId,
      rec.projectId ?? null,
      rec.mode,
      rec.toolCalls,
      rec.inputTokens,
      rec.outputTokens,
      rec.costUsd,
      rec.success ? 1 : 0,
      rec.errorCategory ?? null,
      rec.durationMs,
    ]);
  } catch {
    // Metrics must never crash the server — swallow silently
  }
}

// ── Read ──────────────────────────────────────────────────────────────────

/** Overall platform health for the last N days */
export async function getAgentMetricsSummary(days = 7) {
  const db = getAdapter();
  const since = `datetime('now', '-${days} days')`;

  const overall = await db.get<Record<string, number | null>>(`
    SELECT
      COUNT(*)                                     AS total_turns,
      SUM(success)                                 AS successful_turns,
      ROUND(100.0 * SUM(success) / COUNT(*), 1)   AS success_rate_pct,
      SUM(CASE WHEN tool_calls = 0 AND success = 0 THEN 1 ELSE 0 END)
                                                   AS zero_tool_failures,
      ROUND(AVG(duration_ms), 0)                   AS avg_duration_ms,
      ROUND(AVG(tool_calls), 2)                    AS avg_tool_calls,
      ROUND(SUM(cost_usd), 6)                      AS total_cost_usd,
      ROUND(AVG(cost_usd), 8)                      AS avg_cost_per_turn
    FROM agent_turn_metrics
    WHERE ts >= ${since}
  `) ?? {};

  const byMode = await db.all<Record<string, unknown>>(`
    SELECT
      mode,
      COUNT(*)                                     AS turns,
      ROUND(100.0 * SUM(success) / COUNT(*), 1)   AS success_rate_pct,
      ROUND(AVG(duration_ms), 0)                   AS avg_duration_ms,
      ROUND(AVG(tool_calls), 2)                    AS avg_tool_calls,
      ROUND(SUM(cost_usd), 6)                      AS total_cost_usd
    FROM agent_turn_metrics
    WHERE ts >= ${since}
    GROUP BY mode
    ORDER BY turns DESC
  `);

  const byError = await db.all<Record<string, unknown>>(`
    SELECT
      COALESCE(error_category, 'none') AS error_category,
      COUNT(*)                         AS count
    FROM agent_turn_metrics
    WHERE ts >= ${since} AND success = 0
    GROUP BY error_category
    ORDER BY count DESC
  `);

  const dailyTrend = await db.all<Record<string, unknown>>(`
    SELECT
      DATE(ts)                                     AS day,
      COUNT(*)                                     AS turns,
      SUM(success)                                 AS successes,
      ROUND(100.0 * SUM(success) / COUNT(*), 1)   AS success_rate_pct,
      ROUND(SUM(cost_usd), 6)                      AS cost_usd
    FROM agent_turn_metrics
    WHERE ts >= ${since}
    GROUP BY DATE(ts)
    ORDER BY day ASC
  `);

  // Active users with their per-user stats
  const topUsers = await db.all<Record<string, unknown>>(`
    SELECT
      u.username,
      COUNT(*)                                     AS turns,
      SUM(atm.success)                             AS successes,
      ROUND(100.0 * SUM(atm.success) / COUNT(*), 1) AS success_rate_pct,
      ROUND(SUM(atm.cost_usd), 6)                  AS cost_usd
    FROM agent_turn_metrics atm
    JOIN users u ON u.id = atm.user_id
    WHERE atm.ts >= ${since}
    GROUP BY atm.user_id
    ORDER BY turns DESC
    LIMIT 20
  `);

  return { overall, byMode, byError, dailyTrend, topUsers, days };
}

/** Recent individual turns (last 100) for live monitoring */
export async function getRecentTurns(limit = 100) {
  const db = getAdapter();
  return db.all<Record<string, unknown>>(`
    SELECT
      atm.id,
      u.username,
      atm.mode,
      atm.tool_calls,
      atm.input_tokens,
      atm.output_tokens,
      ROUND(atm.cost_usd, 6)  AS cost_usd,
      atm.success,
      atm.error_category,
      atm.duration_ms,
      atm.ts
    FROM agent_turn_metrics atm
    JOIN users u ON u.id = atm.user_id
    ORDER BY atm.ts DESC
    LIMIT ?
  `, [limit]);
}
