/**
 * SUNy Training Scorer — LLM-as-Judge evaluation of SUNy's own outputs.
 *
 * After every task, a free-tier LLM (Groq Llama 3.3 70B / OpenRouter free)
 * scores SUNy's execution trace against a structured rubric:
 *   correctness, completeness, safety, efficiency, style
 *
 * High-scoring tasks → behavioral rules are extracted and stored.
 * Low-scoring tasks → improvement patterns are extracted and stored.
 *
 * This creates a closed feedback loop: SUNy scores itself, learns from
 * its own wins and mistakes, and injects those lessons into future prompts.
 *
 * Feature flag: ff_training_scorer
 */

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { getAdapter } from './db';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrainingScore {
  id: number;
  userId: number;
  projectId: number | null;
  sessionId: string;
  taskMode: string;
  turnIndex: number;
  rubricCorrectness: number;    // 0–10
  rubricCompleteness: number;   // 0–10
  rubricSafety: number;         // 0–10
  rubricEfficiency: number;     // 0–10
  rubricStyle: number;          // 0–10
  rubricTotal: number;          // 0–50
  extractedLesson: string;      // key behavioral lesson from this task
  lessonCategory: string;       // 'win' | 'mistake' | 'neutral'
  created_at: string;
}

export interface TrainingScorerInput {
  userRequest: string;
  aiResponse: string;
  changedFiles: string[];
  lintPassed: boolean;
  testPassed: boolean;
  lintErrorsFound: number;
  testFailuresFound: number;
  durationMs: number;
  toolCallCount: number;
  steps: number;
}

// ── DB initialization ─────────────────────────────────────────────────────────

export async function initializeTrainingScorerTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS training_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      session_id TEXT NOT NULL,
      task_mode TEXT DEFAULT '',
      turn_index INTEGER DEFAULT 0,
      rubric_correctness INTEGER DEFAULT 0,
      rubric_completeness INTEGER DEFAULT 0,
      rubric_safety INTEGER DEFAULT 0,
      rubric_efficiency INTEGER DEFAULT 0,
      rubric_style INTEGER DEFAULT 0,
      rubric_total INTEGER DEFAULT 0,
      extracted_lesson TEXT DEFAULT '',
      lesson_category TEXT DEFAULT 'neutral',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_training_user ON training_scores(user_id);
    CREATE INDEX IF NOT EXISTS idx_training_category ON training_scores(lesson_category);
    CREATE INDEX IF NOT EXISTS idx_training_total ON training_scores(rubric_total);
  `);
}

// ── Scoring rubric prompt ─────────────────────────────────────────────────────

const SCORING_SYSTEM_PROMPT = `You are a strict but fair code quality judge.
Your task is to evaluate an AI coding assistant's output on 5 criteria.
Score each criterion from 0 (worst) to 10 (best).

Scoring criteria:

1. CORRECTNESS (0–10)
   Does the solution actually work? No syntax errors, no logical bugs,
   no undefined references, no type mismatches. The code should be
   functionally correct for the given request.

2. COMPLETENESS (0–10)
   Does the solution fully address what was asked? All requested features,
   all edge cases handled, no "TODO" stubs left behind.

3. SAFETY (0–10)
   Does the solution avoid introducing security issues? No credential leaks,
   no path traversal, no eval of untrusted input, no unsafe file operations,
   no dependency injection of unverified code.

4. EFFICIENCY (0–10)
   Is the solution reasonably efficient? Appropriate algorithms, no unnecessary
   computation, no redundant database queries, no N+1 patterns.

5. STYLE (0–10)
   Is the code well-structured? Follows project conventions, clear naming,
   consistent formatting, appropriate comments, good separation of concerns.

Respond with a single JSON object:
{"correctness":N,"completeness":N,"safety":N,"efficiency":N,"style":N,"lesson":"one-sentence key lesson","category":"win|mistake|neutral"}

Where:
- Each N is an integer 0–10
- "lesson" is the single most important behavioral lesson from this task
- "category" is "win" (excellent), "mistake" (needs improvement), or "neutral" (average)`; // category

// ── Score a task execution ────────────────────────────────────────────────────

/**
 * Score SUNy's execution of a task using an LLM judge.
 * Returns the rubric scores + extracted lesson.
 *
 * The judge model should be a free/cheap model (Groq Llama 3.3 70B,
 * OpenRouter free tier) to keep costs near zero.
 */
export async function scoreTaskExecution(
  judgeModel: LanguageModel,
  input: TrainingScorerInput,
  signal?: AbortSignal,
): Promise<{
  correctness: number;
  completeness: number;
  safety: number;
  efficiency: number;
  style: number;
  total: number;
  lesson: string;
  category: 'win' | 'mistake' | 'neutral';
} | null> {
  try {
    const userPrompt = `Evaluate this AI coding task execution:

User request:
"""
${input.userRequest.slice(0, 1500)}
"""

AI response (truncated):
"""
${input.aiResponse.slice(0, 3000)}
"""

Files changed: ${input.changedFiles.length > 0 ? input.changedFiles.slice(0, 10).join(', ') : 'none'}
Lint passed: ${input.lintPassed} (${input.lintErrorsFound} errors found)
Tests passed: ${input.testPassed} (${input.testFailuresFound} failures found)
Duration: ${input.durationMs}ms
Tool calls: ${input.toolCallCount}
Steps: ${input.steps}

Based on the criteria in the system prompt, score this execution.`;

    const result = await generateText({
      model: judgeModel,
      system: SCORING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 800,
      abortSignal: signal,
    });

    const text = result.text?.trim() ?? '';
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[training-scorer] No JSON found in judge response:', text.slice(0, 200));
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      correctness: number;
      completeness: number;
      safety: number;
      efficiency: number;
      style: number;
      lesson: string;
      category: string;
    };

    // Validate ranges
    const clamp = (v: number) => Math.max(0, Math.min(10, Math.round(v)));
    const correctness = clamp(parsed.correctness);
    const completeness = clamp(parsed.completeness);
    const safety = clamp(parsed.safety);
    const efficiency = clamp(parsed.efficiency);
    const style = clamp(parsed.style);
    const total = correctness + completeness + safety + efficiency + style;

    const category = parsed.category === 'win' || parsed.category === 'mistake'
      ? parsed.category
      : 'neutral';

    return {
      correctness,
      completeness,
      safety,
      efficiency,
      style,
      total,
      lesson: (parsed.lesson || '(no lesson extracted)').slice(0, 300),
      category,
    };
  } catch (err) {
    console.warn('[training-scorer] Judge model error:', (err as Error).message);
    return null;
  }
}

// ── Record a training score in the DB ─────────────────────────────────────────

export async function recordTrainingScore(entry: {
  userId: number;
  projectId: number | null;
  sessionId: string;
  taskMode: string;
  turnIndex: number;
  correctness: number;
  completeness: number;
  safety: number;
  efficiency: number;
  style: number;
  total: number;
  lesson: string;
  category: string;
}): Promise<void> {
  const db = await getAdapter();
  await db.run(
    `INSERT INTO training_scores (
      user_id, project_id, session_id, task_mode, turn_index,
      rubric_correctness, rubric_completeness, rubric_safety,
      rubric_efficiency, rubric_style, rubric_total,
      extracted_lesson, lesson_category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.projectId,
      entry.sessionId,
      entry.taskMode,
      entry.turnIndex,
      entry.correctness,
      entry.completeness,
      entry.safety,
      entry.efficiency,
      entry.style,
      entry.total,
      entry.lesson,
      entry.category,
    ],
  );
}

// ── Phase 2.1: Real-time agent turn scoring ────────────────────────────────────

/**
 * Score SUNy's output immediately after each major agent loop phase.
 * Unlike post-turn batch scoring, this runs during the agent loop for
 * faster feedback. Runs on a best-effort basis — never blocks the user.
 */
export async function scoreAgentTurn(
  userId: number,
  projectId: number | null,
  sessionId: string,
  resolvedMode: string,
  turnIndex: number,
  input: TrainingScorerInput,
): Promise<void> {
  // Only score if the feature flag is enabled
  const { isFeatureEnabled } = await import('./feature-flags');
  if (!isFeatureEnabled('ff_training_scorer')) return;

  // Only score tasks that did actual work (file changes or tool calls)
  if (input.changedFiles.length === 0 && input.toolCallCount === 0) return;

  // Phase-2.1 scoring requires a configured judge model. Until one is wired
  // up (a free/cheap model dedicated to scoring), skip silently instead of
  // calling a missing function that throws on every turn.
  // TODO: thread a judge LanguageModel through here, then call:
  //   const scores = await scoreTaskExecution(judgeModel, input);
  return;
}

// ── Query training scores ─────────────────────────────────────────────────────

/**
 * Get the average scores for a user across all scored tasks.
 */
export async function getTrainingSummary(userId: number): Promise<{
  totalScored: number;
  avgCorrectness: number;
  avgCompleteness: number;
  avgSafety: number;
  avgEfficiency: number;
  avgStyle: number;
  avgTotal: number;
  winCount: number;
  mistakeCount: number;
  neutralCount: number;
  recentLessons: string[];
}> {
  const db = await getAdapter();
  const rows = await db.all(
    'SELECT * FROM training_scores WHERE user_id = ? ORDER BY created_at',
    [userId],
  ) as TrainingScore[];

  if (rows.length === 0) {
    return {
      totalScored: 0, avgCorrectness: 0, avgCompleteness: 0, avgSafety: 0,
      avgEfficiency: 0, avgStyle: 0, avgTotal: 0,
      winCount: 0, mistakeCount: 0, neutralCount: 0, recentLessons: [],
    };
  }

  const totalScored = rows.length;
  const avgCorrectness = rows.reduce((s, r) => s + r.rubricCorrectness, 0) / totalScored;
  const avgCompleteness = rows.reduce((s, r) => s + r.rubricCompleteness, 0) / totalScored;
  const avgSafety = rows.reduce((s, r) => s + r.rubricSafety, 0) / totalScored;
  const avgEfficiency = rows.reduce((s, r) => s + r.rubricEfficiency, 0) / totalScored;
  const avgStyle = rows.reduce((s, r) => s + r.rubricStyle, 0) / totalScored;
  const avgTotal = rows.reduce((s, r) => s + r.rubricTotal, 0) / totalScored;

  const winCount = rows.filter(r => r.lessonCategory === 'win').length;
  const mistakeCount = rows.filter(r => r.lessonCategory === 'mistake').length;
  const neutralCount = rows.filter(r => r.lessonCategory === 'neutral').length;

  // Get 5 most recent lessons (highest total first)
  const recent = [...rows]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5);

  return {
    totalScored,
    avgCorrectness: Math.round(avgCorrectness * 100) / 100,
    avgCompleteness: Math.round(avgCompleteness * 100) / 100,
    avgSafety: Math.round(avgSafety * 100) / 100,
    avgEfficiency: Math.round(avgEfficiency * 100) / 100,
    avgStyle: Math.round(avgStyle * 100) / 100,
    avgTotal: Math.round(avgTotal * 100) / 100,
    winCount, mistakeCount, neutralCount,
    recentLessons: recent.map(r => `[${r.lessonCategory}] ${r.extractedLesson}`),
  };
}

/**
 * Format training summary for AI system prompt injection.
 */
export function formatTrainingSummary(summary: ReturnType<typeof getTrainingSummary>): string {
  if (summary.totalScored === 0) return '';

  let result = `[TRAINING SUMMARY — ${summary.totalScored} tasks scored]\n`;
  result += `  Average score: ${summary.avgTotal}/50 (correctness=${summary.avgCorrectness}, completeness=${summary.avgCompleteness}, safety=${summary.avgSafety}, efficiency=${summary.avgEfficiency}, style=${summary.avgStyle})\n`;
  result += `  Wins: ${summary.winCount} | Mistakes: ${summary.mistakeCount} | Neutral: ${summary.neutralCount}\n`;

  if (summary.recentLessons.length > 0) {
    result += `\n  [Lessons from recent tasks]\n`;
    for (const lesson of summary.recentLessons) {
      result += `  • ${lesson}\n`;
    }
  }

  return result;
}
