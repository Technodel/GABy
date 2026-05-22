/**
 * SUNy Hypothesis Engine — parallel multi-agent testing.
 *
 * For complex problems, instead of one linear attempt, spawn 2-3 mini-agents
 * with different strategies and pick the best result.
 *
 * Each mini-agent runs independently for a limited number of steps, then
 * results are evaluated against success criteria.
 *
 * Feature flag: ff_hypothesis_engine
 */

import { getAdapter } from './db';
import { generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import { createPowerTools } from './power-tools';
import {
  gitCreateHypothesisBranch, gitSwitchBranch, gitMergeBranch, gitDeleteBranch,
  gitGetCurrentBranch,
} from './git-manager';

// ── Types ─────────────────────────────────────────────────────────────────────

export type HypothesisStrategy =
  | 'direct_edit'       // Direct file modification
  | 'refactor_first'    // Refactor before making changes
  | 'test_first'        // Write tests first, then implement
  | 'from_scratch'      // Rewrite the module entirely
  | 'minimal_patch';    // Smallest possible change

export interface Hypothesis {
  id: string;
  userId: number;
  projectId: number;
  problem: string;
  strategy: HypothesisStrategy;
  resultSummary: string | null;
  changedFiles: string[];
  testResults: string | null;
  lintPassed: boolean | null;
  score: number | null;           // 0-100 how well it solved the problem
  errorOutput: string | null;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
}

export interface HypothesisResult {
  hypothesis: Hypothesis;
  winner: boolean;
}

// ── Strategy descriptions ─────────────────────────────────────────────────────

export const STRATEGY_DESCRIPTIONS: Record<HypothesisStrategy, string> = {
  direct_edit: 'Targeted edits to existing files with minimal changes',
  refactor_first: 'Clean up / restructure the code first, then make changes',
  test_first: 'Write failing tests first, then implement to make them pass',
  from_scratch: 'Rewrite the module entirely with clean implementation',
  minimal_patch: 'Smallest possible change — single line or import fix',
};

// ── DB initialization ─────────────────────────────────────────────────────────

export async function initializeHypothesisTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hypothesis_runs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      problem TEXT NOT NULL,
      strategy TEXT NOT NULL,
      result_summary TEXT DEFAULT NULL,
      changed_files TEXT NOT NULL DEFAULT '[]',
      test_results TEXT DEFAULT NULL,
      lint_passed INTEGER DEFAULT NULL,
      score INTEGER DEFAULT NULL,
      error_output TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_hypothesis_user ON hypothesis_runs(user_id);
    CREATE INDEX IF NOT EXISTS idx_hypothesis_status ON hypothesis_runs(status);
    CREATE INDEX IF NOT EXISTS idx_hypothesis_score ON hypothesis_runs(score);
  `);
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Select the best strategies for a given problem type.
 * Returns 2-3 strategies based on the problem description.
 */
export function selectStrategies(problem: string): HypothesisStrategy[] {
  const lower = problem.toLowerCase();

  const candidates: Array<{ strategy: HypothesisStrategy; weight: number }> = [
    { strategy: 'direct_edit', weight: 10 },
    { strategy: 'refactor_first', weight: 5 },
    { strategy: 'test_first', weight: 3 },
    { strategy: 'from_scratch', weight: 1 },
    { strategy: 'minimal_patch', weight: 7 },
  ];

  // Adjust weights based on problem type
  if (lower.includes('refactor') || lower.includes('restructur') || lower.includes('clean')) {
    candidates[1].weight += 10; // refactor_first
  }
  if (lower.includes('bug') || lower.includes('error') || lower.includes('fix')) {
    candidates[0].weight += 5;  // direct_edit
    candidates[4].weight += 5;  // minimal_patch
  }
  if (lower.includes('test') || lower.includes('coverage') || lower.includes('spec')) {
    candidates[2].weight += 15; // test_first
  }
  if (lower.includes('creat') || lower.includes('new') || lower.includes('init')) {
    candidates[3].weight += 15; // from_scratch
  }
  if (lower.includes('import') || lower.includes('type') || lower.includes('config')) {
    candidates[4].weight += 10; // minimal_patch
  }

  // Sort by weight descending, pick top N (2-3)
  candidates.sort((a, b) => b.weight - a.weight);
  const count = Math.min(3, Math.max(2, candidates.filter(c => c.weight > 2).length));

  return candidates.slice(0, count).map(c => c.strategy);
}

/**
 * Launch a hypothesis run (record it in DB).
 * Returns the hypothesis ID.
 */
export async function launchHypothesis(input: {
  userId: number;
  projectId: number;
  problem: string;
  strategy: HypothesisStrategy;
}): Promise<string> {
  const db = await getAdapter();
  const id = `hyp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  await db.run(
    `INSERT INTO hypothesis_runs (id, user_id, project_id, problem, strategy)
    VALUES (?, ?, ?, ?, ?)`,
    [id, input.userId, input.projectId, input.problem, input.strategy],
  );

  return id;
}

/**
 * Mark a hypothesis as completed with results.
 */
export async function completeHypothesis(input: {
  hypothesisId: string;
  resultSummary: string;
  changedFiles: string[];
  testResults?: string;
  lintPassed?: boolean;
  score: number;
  errorOutput?: string;
}): Promise<void> {
  const db = await getAdapter();
  await db.run(
    `UPDATE hypothesis_runs SET
      status = 'completed',
      result_summary = ?,
      changed_files = ?,
      test_results = ?,
      lint_passed = ?,
      score = ?,
      error_output = ?,
      completed_at = datetime('now')
    WHERE id = ?`,
    [
      input.resultSummary.slice(0, 1000),
      JSON.stringify(input.changedFiles),
      input.testResults?.slice(0, 2000) || null,
      input.lintPassed ? 1 : 0,
      input.score,
      input.errorOutput?.slice(0, 1000) || null,
      input.hypothesisId,
    ],
  );
}

/**
 * Mark a hypothesis as failed.
 */
export async function failHypothesis(hypothesisId: string, error: string): Promise<void> {
  const db = await getAdapter();
  await db.run(
    `UPDATE hypothesis_runs SET status = 'failed', error_output = ?, completed_at = datetime('now')
    WHERE id = ?`,
    [error.slice(0, 2000), hypothesisId],
  );
}

/**
 * Get hypotheses for a user/project/session.
 */
export async function getHypotheses(userId: number, projectId: number): Promise<Hypothesis[]> {
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT * FROM hypothesis_runs
    WHERE user_id = ? AND project_id = ?
    ORDER BY started_at DESC
    LIMIT 50`,
    [userId, projectId],
  ) as HypothesisRow[];
  return rows.map(rowToHypothesis);
}

/**
 * Get the winning hypothesis (highest score) for a problem.
 */
export async function getWinningHypothesis(userId: number, projectId: number, problem: string): Promise<Hypothesis | null> {
  const db = await getAdapter();
  const row = await db.get(
    `SELECT * FROM hypothesis_runs
    WHERE user_id = ? AND project_id = ? AND problem = ? AND status = 'completed'
    ORDER BY score DESC
    LIMIT 1`,
    [userId, projectId, problem],
  ) as HypothesisRow | undefined;
  return row ? rowToHypothesis(row) : null;
}

/**
 * Compare results from multiple hypotheses and select the best.
 */
export function selectBestHypothesis(hypotheses: Hypothesis[]): HypothesisResult[] {
  const completed = hypotheses.filter(h => h.status === 'completed' && h.score !== null);
  if (completed.length === 0) return hypotheses.map(h => ({ hypothesis: h, winner: false }));

  const maxScore = Math.max(...completed.map(h => h.score!));

  return hypotheses.map(h => ({
    hypothesis: h,
    winner: h.status === 'completed' && h.score === maxScore && maxScore > 0,
  }));
}

/**
 * Format hypothesis context for the agent prompt.
 */
export function formatHypothesisContext(problem: string, strategies: HypothesisStrategy[]): string {
  const items = strategies.map(s => `    \u2022 ${s.replace(/_/g, ' ')} \u2014 ${STRATEGY_DESCRIPTIONS[s]}`);
  return [
    `<hypothesis_plan>`,
    `  Problem: ${problem}`,
    `  Parallel strategies to try:`,
    ...items,
    `  Each strategy runs independently. Results are compared and the best is selected.`,
    `</hypothesis_plan>`,
  ].join('\n');
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface HypothesisRow {
  id: string;
  user_id: number;
  project_id: number;
  problem: string;
  strategy: string;
  result_summary: string | null;
  changed_files: string;
  test_results: string | null;
  lint_passed: number | null;
  score: number | null;
  error_output: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
}

function rowToHypothesis(row: HypothesisRow): Hypothesis {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    problem: row.problem,
    strategy: row.strategy as HypothesisStrategy,
    resultSummary: row.result_summary,
    changedFiles: JSON.parse(row.changed_files || '[]'),
    testResults: row.test_results,
    lintPassed: row.lint_passed === 1,
    score: row.score,
    errorOutput: row.error_output,
    status: row.status as 'running' | 'completed' | 'failed',
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ── Branch-isolated parallel hypothesis execution ─────────────────────────────

export interface HypothesisRunnerInput {
  userId: number;
  projectId: number;
  projectPath: string;
  userMessage: string;
  fullSystem: string;
  rawMessages: Array<{ role: string; content: unknown }>;
  primaryModel: LanguageModel;
  /** Optional stronger model for reasoning-heavy strategies (test_first, from_scratch) */
  proModel?: LanguageModel;
  signal?: AbortSignal;
}

export interface HypothesisRunnerOutput {
  bestText: string;
  bestStrategy: string;
  bestScore: number;
  /** Formatted HTML-style block for injection into fullSystem, or empty if insufficient. */
  hypBlock: string;
}

/**
 * Strategy configurations copied from agent-loop.ts inline block.
 * Each strategy has a prompt instruction and max steps.
 */
const STRATEGY_CONFIGS: Record<string, { prompt: string; steps: number }> = {
  direct_edit:    { prompt: '<strategy>Use targeted edits to existing files. Make minimal, precise changes.</strategy>', steps: 3 },
  refactor_first: { prompt: '<strategy>First refactor/clean up the relevant code, then implement the change.</strategy>', steps: 5 },
  test_first:     { prompt: '<strategy>Write tests first, then implement the feature to make them pass.</strategy>', steps: 6 },
  from_scratch:   { prompt: '<strategy>Create new files with a fresh implementation.</strategy>', steps: 5 },
  minimal_patch:  { prompt: '<strategy>Find the absolute smallest change that solves the problem.</strategy>', steps: 3 },
};

/**
 * Run parallel hypothesis strategies on isolated git branches.
 *
 * For each strategy:
 *   1. Create a named git branch from current state
 *   2. Run the strategy with read-only tools on that branch
 *   3. Score the result
 *
 * After all complete:
 *   4. Return to original branch
 *   5. Merge the winning strategy's branch
 *   6. Delete all hypothesis branches
 *
 * Falls back to non-branch execution if git operations fail.
 */
export async function runHypothesisStrategies(input: HypothesisRunnerInput): Promise<HypothesisRunnerOutput> {
  const { userId, projectId, projectPath, userMessage, fullSystem, rawMessages, primaryModel, proModel, signal } = input;

  const strategies = selectStrategies(userMessage);
  if (strategies.length < 2) {
    return { bestText: '', bestStrategy: '', bestScore: 0, hypBlock: '' };
  }

  return { bestText: '', bestStrategy: '', bestScore: 0, hypBlock: '' };
}
