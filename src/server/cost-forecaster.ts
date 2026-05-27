/**
 * SUNy Cost Forecaster — pre-run estimate + budget gate.
 *
 * Two features:
 *
 * 1. FORECAST (optional, charged at forecast_markup mode):
 *    - Queries usage_log for historical averages for this user/project/mode
 *    - Optionally runs a lightweight LLM call (classifyTaskType + token estimate)
 *    - Returns a low/high credit range before the main agent loop starts
 *    - Charged to the user at the forecast_markup pricing mode (admin-configurable)
 *
 * 2. BUDGET GATE (per-run cap):
 *    - User sets budget_per_run in credits
 *    - Agent-loop calls checkBudgetGate() after each deductUsage()
 *    - When cumulative session cost approaches the cap, fires request_checkpoint
 */

import { getDb, getAdapter } from './db';
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { deductUsage } from './billing';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CostForecast {
  lowCredits: number;
  highCredits: number;
  historicalSamples: number;
  estimatedSteps: number;
  confidence: 'high' | 'medium' | 'low';
  basedOn: 'history' | 'llm_estimate' | 'default';
}

// ── Settings helpers ──────────────────────────────────────────────────────────

export function getUserCostSetting(userId: number, key: string, fallback: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`user_${userId}_${key}`) as { value: string } | undefined;
  if (row) return row.value;
  const global = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return global?.value ?? fallback;
}

export function isForecastEnabled(userId: number): boolean {
  return getUserCostSetting(userId, 'forecast_enabled', 'false') === 'true';
}

export function getBudgetPerRun(userId: number): number | null {
  const val = getUserCostSetting(userId, 'budget_per_run', '0');
  const n = parseFloat(val);
  return isFinite(n) && n > 0 ? n : null;
}

export function isBudgetGateEnabled(userId: number): boolean {
  return getUserCostSetting(userId, 'budget_gate_enabled', 'false') === 'true';
}

// ── Historical usage query ────────────────────────────────────────────────────

interface UsageRow {
  charged_cost: number;
  [key: string]: unknown;
}

export async function getHistoricalCostRange(
  userId: number,
  projectId: number | null,
  mode: string,
): Promise<{ low: number; high: number; samples: number }> {
  const db = await getAdapter();

  // Last 20 sessions for this user+mode (project-scoped if available, else global)
  let rows: UsageRow[] = [];
  if (projectId) {
    // Aggregate per session_id so one session = one data point
    rows = await db.all<UsageRow>(
      `SELECT SUM(charged_cost) as charged_cost
       FROM usage_log
       WHERE user_id = ? AND project_id = ? AND mode = ?
       GROUP BY session_id
       ORDER BY MAX(rowid) DESC
       LIMIT 20`,
      [userId, projectId, mode],
    );
  }
  // Fallback to user-wide if no project rows
  if (!projectId || !rows!.length) {
    rows = await db.all<UsageRow>(
      `SELECT SUM(charged_cost) as charged_cost
       FROM usage_log
       WHERE user_id = ? AND mode = ?
       GROUP BY session_id
       ORDER BY MAX(rowid) DESC
       LIMIT 20`,
      [userId, mode],
    );
  }

  if (!rows || rows.length === 0) {
    return { low: 0, high: 0, samples: 0 };
  }

  const costs = rows.map(r => r.charged_cost ?? 0).filter(c => c > 0);
  if (!costs.length) return { low: 0, high: 0, samples: 0 };

  costs.sort((a, b) => a - b);
  const p20 = costs[Math.floor(costs.length * 0.2)] ?? costs[0];
  const p80 = costs[Math.floor(costs.length * 0.8)] ?? costs[costs.length - 1];

  return { low: p20, high: p80, samples: costs.length };
}

// ── LLM-based estimate (charged at forecast mode) ─────────────────────────────

export async function generateLLMForecast(
  userId: number,
  projectId: number | null,
  sessionId: string,
  mode: string,
  userMessage: string,
  model: LanguageModel,
  provider: string,
): Promise<{ estimatedSteps: number; estimatedOutputTokens: number; forecastCost: number }> {
  const prompt = `You are a cost estimator for an AI coding agent. Given the task description below, estimate:
1. How many agent steps (tool calls + LLM turns) this task will likely require
2. Approximate total output tokens across all steps

Task: "${userMessage.slice(0, 300)}"

Respond with ONLY a JSON object like: {"steps": 6, "output_tokens": 4000}
No explanation. Just the JSON.`;

  const result = await generateText({
    model,
    prompt,
    maxOutputTokens: 80,
  });

  // Charge the user for this forecast call
  const inputTokens = result.usage?.inputTokens ?? 200;
  const outputTokens = result.usage?.outputTokens ?? 30;
  const forecastMode = getUserCostSetting(userId, 'forecast_markup_mode', mode);
  try {
    await deductUsage(userId, sessionId, projectId, forecastMode, inputTokens, outputTokens);
  } catch { /* best-effort charge */ }

  // Parse response
  let steps = 6;
  let estOutputTokens = 4000;
  try {
    const text = result.text.trim().replace(/```json|```/g, '');
    const parsed = JSON.parse(text);
    if (typeof parsed.steps === 'number') steps = Math.max(1, Math.min(50, parsed.steps));
    if (typeof parsed.output_tokens === 'number') estOutputTokens = Math.max(100, Math.min(100000, parsed.output_tokens));
  } catch { /* use defaults */ }

  return { estimatedSteps: steps, estimatedOutputTokens: estOutputTokens, forecastCost: (inputTokens + outputTokens) * 0.000001 };
}

// ── Main forecast entry point ─────────────────────────────────────────────────

export async function buildForecast(
  userId: number,
  projectId: number | null,
  sessionId: string,
  mode: string,
  userMessage: string,
  model: LanguageModel,
  provider: string,
): Promise<CostForecast> {
  const { low, high, samples } = await getHistoricalCostRange(userId, projectId, mode);

  if (samples >= 5) {
    // Enough history — use it directly
    return {
      lowCredits: parseFloat(low.toFixed(4)),
      highCredits: parseFloat(high.toFixed(4)),
      historicalSamples: samples,
      estimatedSteps: 0,
      confidence: samples >= 10 ? 'high' : 'medium',
      basedOn: 'history',
    };
  }

  // Not enough history — use LLM estimate
  try {
    const { estimatedSteps } = await generateLLMForecast(userId, projectId, sessionId, mode, userMessage, model, provider);

    // Get per-step cost estimate from pricing_modes
    const db = getDb();
    const pricing = db.prepare('SELECT input_token_base_cost, output_token_base_cost FROM pricing_modes WHERE mode = ?').get(mode) as { input_token_base_cost: number; output_token_base_cost: number } | undefined;
    const costPerStep = pricing
      ? (pricing.input_token_base_cost * 2000 + pricing.output_token_base_cost * 1500)
      : 0.001;

    const estLow = costPerStep * estimatedSteps * 0.6;
    const estHigh = costPerStep * estimatedSteps * 1.8;

    return {
      lowCredits: parseFloat(estLow.toFixed(4)),
      highCredits: parseFloat(estHigh.toFixed(4)),
      historicalSamples: samples,
      estimatedSteps,
      confidence: 'low',
      basedOn: 'llm_estimate',
    };
  } catch {
    // Fallback: use mode pricing with generic estimate
    const db = getDb();
    const pricing = db.prepare('SELECT input_token_base_cost, output_token_base_cost FROM pricing_modes WHERE mode = ?').get(mode) as { input_token_base_cost: number; output_token_base_cost: number } | undefined;
    const costPerStep = pricing
      ? (pricing.input_token_base_cost * 2000 + pricing.output_token_base_cost * 1500)
      : 0.001;

    return {
      lowCredits: parseFloat((costPerStep * 3).toFixed(4)),
      highCredits: parseFloat((costPerStep * 15).toFixed(4)),
      historicalSamples: 0,
      estimatedSteps: 6,
      confidence: 'low',
      basedOn: 'default',
    };
  }
}

// ── Session spend tracker ─────────────────────────────────────────────────────

const sessionSpend = new Map<string, number>();

export function trackSessionSpend(sessionId: string, amount: number): number {
  const prev = sessionSpend.get(sessionId) ?? 0;
  const next = prev + amount;
  sessionSpend.set(sessionId, next);
  return next;
}

export function clearSessionSpend(sessionId: string): void {
  sessionSpend.delete(sessionId);
}

export function getSessionSpend(sessionId: string): number {
  return sessionSpend.get(sessionId) ?? 0;
}
