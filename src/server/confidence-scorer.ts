/**
 * SUNy Confidence Scorer — self-reported uncertainty with automatic escalation.
 *
 * After every agent turn:
 *   1. The model self-reports confidence (0-1) and uncertainties
 *   2. Low confidence triggers automatic escalation to a stronger model
 *   3. Escalation history is tracked to detect patterns of over/under-confidence
 *
 * Feature flag: ff_confidence_scoring
 * DB table: confidence_log
 */

import { getAdapter } from './db';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfidenceReport {
  turnIndex: number;
  userId: number;
  projectId: number;
  sessionId: string;
  confidence: number;           // 0.0 – 1.0
  uncertainties: string[];      // what the model admits it's unsure about
  escalationNeeded: boolean;    // true if confidence < threshold
  escalatedFrom: string | null; // mode before escalation (e.g., 'free')
  escalatedTo: string | null;   // mode after escalation (e.g., 'pro')
  escalationResolved: boolean;  // did the escalation help?
  createdAt: string;
}

export interface ConfidenceStats {
  averageConfidence: number;
  totalTurns: number;
  escalationRate: number;
  escalationSuccessRate: number;
  lowConfidenceCount: number;
  topUncertainties: Array<{ topic: string; count: number }>;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLDS = {
  /** Below this confidence → escalate to stronger model */
  ESCALATE: 0.6,
  /** Below this confidence → also flag for human review */
  FLAG_FOR_REVIEW: 0.3,
  /** Mode escalation ladder */
  ESCALATION_LADDER: ['free', 'fast', 'smart', 'pro'] as const,
};

// ── DB initialization ─────────────────────────────────────────────────────────

export async function initializeConfidenceTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS confidence_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_index INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      uncertainties TEXT NOT NULL DEFAULT '[]',
      escalation_needed INTEGER DEFAULT 0,
      escalated_from TEXT DEFAULT NULL,
      escalated_to TEXT DEFAULT NULL,
      escalation_resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_confidence_user ON confidence_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_confidence_session ON confidence_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_confidence_turn ON confidence_log(user_id, project_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_confidence_escalation ON confidence_log(escalation_needed);
  `);
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Record a confidence report after an agent turn.
 * Returns the escalation recommendation (if any).
 */
export async function recordConfidence(input: {
  turnIndex: number;
  userId: number;
  projectId: number;
  sessionId: string;
  confidence: number;
  uncertainties?: string[];
  currentMode?: string;
}): Promise<{ escalationNeeded: boolean; escalateTo?: string; flagForReview: boolean }> {
  const db = await getAdapter();
  const clampedConfidence = Math.max(0, Math.min(1, input.confidence));
  const uncertainties = input.uncertainties || [];
  const escalationNeeded = clampedConfidence < CONFIDENCE_THRESHOLDS.ESCALATE;
  const flagForReview = clampedConfidence < CONFIDENCE_THRESHOLDS.FLAG_FOR_REVIEW;

  let escalateTo: string | undefined;
  if (escalationNeeded && input.currentMode) {
    const ladder = CONFIDENCE_THRESHOLDS.ESCALATION_LADDER;
    const currentIdx = ladder.indexOf(input.currentMode as typeof ladder[number]);
    if (currentIdx >= 0 && currentIdx < ladder.length - 1) {
      escalateTo = ladder[currentIdx + 1];
    }
  }

  await db.run(
    `INSERT INTO confidence_log
      (turn_index, user_id, project_id, session_id, confidence, uncertainties,
       escalation_needed, escalated_from, escalated_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.turnIndex, input.userId, input.projectId, input.sessionId,
      clampedConfidence, JSON.stringify(uncertainties),
      escalationNeeded ? 1 : 0,
      escalationNeeded ? input.currentMode || null : null,
      escalateTo || null,
    ],
  );

  return { escalationNeeded, escalateTo, flagForReview };
}

/**
 * Mark an escalation as resolved (the stronger model fixed the uncertainty).
 */
export async function markEscalationResolved(
  userId: number,
  sessionId: string,
  turnIndex: number,
): Promise<void> {
  const db = await getAdapter();
  await db.run(
    `UPDATE confidence_log SET escalation_resolved = 1
    WHERE user_id = ? AND session_id = ? AND turn_index = ? AND escalation_needed = 1`,
    [userId, sessionId, turnIndex],
  );
}

/**
 * Get confidence stats for a user/project.
 */
export async function getConfidenceStats(userId: number, projectId: number): Promise<ConfidenceStats> {
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT confidence, escalation_needed, escalation_resolved, uncertainties
    FROM confidence_log
    WHERE user_id = ? AND project_id = ?
    ORDER BY created_at DESC
    LIMIT 500`,
    [userId, projectId],
  ) as Array<{
    confidence: number; escalation_needed: number; escalation_resolved: number; uncertainties: string;
  }>;

  if (rows.length === 0) {
    return {
      averageConfidence: 1, totalTurns: 0, escalationRate: 0,
      escalationSuccessRate: 0, lowConfidenceCount: 0, topUncertainties: [],
    };
  }

  const total = rows.length;
  const avgConf = rows.reduce((s, r) => s + r.confidence, 0) / total;
  const escalations = rows.filter(r => r.escalation_needed).length;
  const escalationsResolved = rows.filter(r => r.escalation_needed && r.escalation_resolved).length;
  const lowConf = rows.filter(r => r.confidence < CONFIDENCE_THRESHOLDS.ESCALATE).length;

  // Get top uncertainty topics
  const uncertaintyMap = new Map<string, number>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.uncertainties || '[]') as string[];
      for (const topic of parsed) {
        uncertaintyMap.set(topic, (uncertaintyMap.get(topic) || 0) + 1);
      }
    } catch {
      // Skip rows with invalid JSON
    }
  }
  const topUncertainties = Array.from(uncertaintyMap.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    averageConfidence: Math.round(avgConf * 100) / 100,
    totalTurns: total,
    escalationRate: total > 0 ? Math.round((escalations / total) * 100) : 0,
    escalationSuccessRate: escalations > 0 ? Math.round((escalationsResolved / escalations) * 100) : 100,
    lowConfidenceCount: lowConf,
    topUncertainties,
  };
}

/**
 * Format confidence context for the agent prompt.
 */
export async function formatConfidenceContext(userId: number, projectId: number): Promise<string> {
  const stats = await getConfidenceStats(userId, projectId);
  if (stats.totalTurns === 0) return '';

  return [
    `<confidence_context>`,
    `  Average confidence: ${(stats.averageConfidence * 100).toFixed(0)}% over ${stats.totalTurns} turns`,
    `  Escalation rate: ${stats.escalationRate}% (${stats.escalationSuccessRate}% resolved by escalation)`,
    `  Low-confidence turns: ${stats.lowConfidenceCount}`,
    `</confidence_context>`,
  ].join('\n');
}

/**
 * Build a confidence assessment prompt for the model to self-report.
 */
export function buildConfidenceAssessmentPrompt(): string {
  return `After completing this turn, self-assess your confidence in the result.

Rate your confidence from 0.0 to 1.0:
- 1.0 = Absolutely certain, verified, tested, complete
- 0.8 = Highly confident, minor uncertainties resolved
- 0.6 = Reasonably confident but some edge cases remain
- 0.4 = Uncertain, likely needs a different approach
- 0.2 = Very uncertain, probably wrong approach
- 0.0 = Completely unsure

List specific things you're unsure about (if any). Be honest — low confidence triggers automatic escalation to a stronger model, which often resolves the issue.`;
}

/**
 * Determine if escalation is trending (last N turns show declining confidence).
 */
export async function isEscalationTrending(userId: number, projectId: number, lookback: number = 5): Promise<boolean> {
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT confidence FROM confidence_log
    WHERE user_id = ? AND project_id = ?
    ORDER BY created_at DESC
    LIMIT ?`,
    [userId, projectId, lookback],
  ) as Array<{ confidence: number }>;

  if (rows.length < 3) return false;

  // Check if confidence is strictly decreasing
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].confidence >= rows[i - 1].confidence) return false;
  }
  return true;
}
