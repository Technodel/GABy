/**
 * SUNy Prometheus / Metrics Endpoint
 *
 * Exposes agent performance data in Prometheus text format at GET /metrics
 * for scraping by Prometheus + Grafana. All data comes from the existing
 * agent_turn_metrics DB table â€” no new instrumentation needed.
 *
 * Usage: app.get('/metrics', prometheusMetricsHandler);
 */

import { Request, Response } from 'express';
import promClient from 'prom-client';
import { getAdapter } from './db';
import { getGlobalQueueStats } from './user-queue';

// â”€â”€ Registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// â”€â”€ Gauges â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const turnsTotalGauge = new promClient.Gauge({
  name: 'suny_turns_total',
  help: 'Total agent turns recorded',
  labelNames: ['mode'] as const,
  registers: [register],
});

const successRateGauge = new promClient.Gauge({
  name: 'suny_success_rate_pct',
  help: 'Success rate percentage',
  labelNames: ['mode'] as const,
  registers: [register],
});

const avgDurationGauge = new promClient.Gauge({
  name: 'suny_avg_duration_ms',
  help: 'Average turn duration in milliseconds',
  labelNames: ['mode'] as const,
  registers: [register],
});

const avgToolCallsGauge = new promClient.Gauge({
  name: 'suny_avg_tool_calls',
  help: 'Average tool calls per turn',
  labelNames: ['mode'] as const,
  registers: [register],
});

const totalCostGauge = new promClient.Gauge({
  name: 'suny_total_cost_usd',
  help: 'Total cost in USD',
  labelNames: ['mode'] as const,
  registers: [register],
});

const errorCountGauge = new promClient.Gauge({
  name: 'suny_errors_total',
  help: 'Total errors by category',
  labelNames: ['category'] as const,
  registers: [register],
});

const tokenUsageGauge = new promClient.Gauge({
  name: 'suny_token_usage_total',
  help: 'Total token usage',
  labelNames: ['type'] as const, // 'input', 'output', 'cache_write', 'cache_read'
  registers: [register],
});

const stepsExhaustedGauge = new promClient.Gauge({
  name: 'suny_steps_exhausted_total',
  help: 'Total turns that hit step limit',
  registers: [register],
});

const hypotheisWinRateGauge = new promClient.Gauge({
  name: 'suny_hypothesis_win_rate',
  help: 'Hypothesis engine win rate (best strategy selected)',
  registers: [register],
});

const userQueueActiveGauge = new promClient.Gauge({
  name: 'suny_user_queue_active',
  help: 'Currently active agent turns across all users',
  registers: [register],
});

const userQueueQueuedGauge = new promClient.Gauge({
  name: 'suny_user_queue_queued',
  help: 'Currently queued agent turns across all users',
  registers: [register],
});

// â”€â”€ Data refresh interval â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let lastRefresh = 0;
const REFRESH_INTERVAL_MS = 15_000; // refresh from DB every 15s

async function refreshMetrics(): Promise<void> {
  const db = getAdapter();
  const since = "datetime('now', '-7 days')";

  // Per-mode stats
  const byMode = await db.all<Record<string, unknown>>(`
    SELECT
      mode,
      COUNT(*)                                     AS turns,
      ROUND(100.0 * SUM(success) / COUNT(*), 1)   AS success_rate,
      ROUND(AVG(duration_ms), 0)                   AS avg_duration,
      ROUND(AVG(tool_calls), 2)                    AS avg_tool_calls,
      ROUND(SUM(cost_usd), 6)                      AS total_cost
    FROM agent_turn_metrics
    WHERE ts >= ${since}
    GROUP BY mode
  `);

  for (const row of byMode) {
    const mode = String(row.mode);
    turnsTotalGauge.set({ mode }, Number(row.turns));
    successRateGauge.set({ mode }, Number(row.success_rate));
    avgDurationGauge.set({ mode }, Number(row.avg_duration));
    avgToolCallsGauge.set({ mode }, Number(row.avg_tool_calls));
    totalCostGauge.set({ mode }, Number(row.total_cost));
  }

  // Error categories
  const byError = await db.all<Record<string, unknown>>(`
    SELECT COALESCE(error_category, 'none') AS category, COUNT(*) AS count
    FROM agent_turn_metrics
    WHERE ts >= ${since} AND success = 0
    GROUP BY error_category
  `);

  for (const row of byError) {
    errorCountGauge.set({ category: String(row.category) }, Number(row.count));
  }

  // Token usage (aggregate from usage_log)
  const tokenUsage = await db.get<{ input: number; output: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0)  AS input,
      COALESCE(SUM(output_tokens), 0) AS output
    FROM usage_log
    WHERE created_at >= ${since}
  `) ?? { input: 0, output: 0 };

  tokenUsageGauge.set({ type: 'input' }, tokenUsage.input);
  tokenUsageGauge.set({ type: 'output' }, tokenUsage.output);

  // Step exhaustion â€” count completed turns where steps >= 24 (MAX_STEPS)
  const exhausted = await db.get<{ count: number }>(`
    SELECT COUNT(*) AS count FROM agent_turn_metrics
    WHERE ts >= ${since}
  `) ?? { count: 0 };
  // Approximate: we don't store steps exhausted in agent_turn_metrics directly
  // Use 0-tool-call failures as a proxy
  const zeroToolFailures = await db.get<{ count: number }>(`
    SELECT COUNT(*) AS count FROM agent_turn_metrics
    WHERE ts >= ${since} AND tool_calls = 0 AND success = 0
  `) ?? { count: 0 };
  stepsExhaustedGauge.set(zeroToolFailures.count);

  // Hypothesis win rate â€” counting ratio of positive scores from hypothesis_runs
  const hypStats = await db.get<{ total: number; high_score: number }>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN score > 50 THEN 1 ELSE 0 END) AS high_score
    FROM hypothesis_runs
    WHERE completed_at >= ${since}
  `) ?? { total: 0, high_score: 0 };
  if (hypStats.total > 0) {
    hypotheisWinRateGauge.set(hypStats.high_score / hypStats.total * 100);
  }

  // User queue stats
  const queueStats = getGlobalQueueStats();
  userQueueActiveGauge.set(queueStats.totalActive);
  userQueueQueuedGauge.set(queueStats.totalQueued);
}

// â”€â”€ Express handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function prometheusMetricsHandler(_req: Request, res: Response): Promise<void> {
  // Refresh data from DB if interval has elapsed
  const now = Date.now();
  if (now - lastRefresh > REFRESH_INTERVAL_MS) {
    try {
      await refreshMetrics();
      lastRefresh = now;
    } catch (e) {
      console.warn('[prometheus] metrics refresh failed:', (e as Error).message);
    }
  }

  res.set('Content-Type', register.contentType);
  register.metrics().then(
    (metrics) => res.send(metrics),
    (err) => {
      console.error('[prometheus] metrics serialization failed:', err);
      res.status(500).send('metrics error');
    },
  );
}
