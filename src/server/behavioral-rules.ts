/**
 * SUNy Behavioral Rules — extract lessons from scored tasks and inject them
 * into future prompts to create a self-improving feedback loop.
 *
 * ── How it works ──
 * 1. After every task, the training scorer evaluates SUNy's output against a rubric.
 * 2. High/low scoring tasks yield a "behavioral lesson" — a one-sentence insight
 *    about what SUNy did well or poorly.
 * 3. This module stores those lessons as "behavioral rules" in the DB.
 * 4. Before the next task, relevant rules are injected into the system prompt,
 *    guiding SUNy to repeat good behaviors and avoid mistakes.
 *
 * ── Rule lifecycle ──
 *    Extracted → stored (confidence=0.5) → applied (each application increases
 *    confidence) → pruned (rules below confidence threshold after N applications
 *    are removed).
 *
 * Feature flag: ff_behavioral_rules
 */

import { getDb } from './db';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BehavioralRule {
  id: number;
  userId: number;
  projectId: number | null;
  category: 'win' | 'mistake' | 'neutral';
  ruleText: string;           // e.g. "Always handle empty state before rendering lists"
  triggerContext: string;     // e.g. "when rendering arrays or lists"
  sourceScore: number;        // the rubric total that generated this rule (0–50)
  confidence: number;         // 0.0 – 1.0 (how reliable this rule has proven)
  applicationCount: number;   // how many times this rule was injected
  lastAppliedAt: string | null;
  createdAt: string;
}

// ── DB initialization ─────────────────────────────────────────────────────────

export function initializeBehavioralRulesTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS behavioral_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      category TEXT NOT NULL DEFAULT 'neutral',
      rule_text TEXT NOT NULL,
      trigger_context TEXT DEFAULT '',
      source_score INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.5,
      application_count INTEGER DEFAULT 0,
      last_applied_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_user ON behavioral_rules(user_id);
    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_category ON behavioral_rules(category);
    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_confidence ON behavioral_rules(confidence);
  `);
}

// ── Extract a behavioral rule from a training score ───────────────────────────

/**
 * Extract a behavioral rule from a scored task and store it.
 * Rule text is derived from the lesson + category.
 * Win rules get higher initial confidence (0.6) than mistake rules (0.4).
 */
export function extractBehavioralRule(entry: {
  userId: number;
  projectId: number | null;
  category: 'win' | 'mistake' | 'neutral';
  lesson: string;
  sourceScore: number;
}): BehavioralRule | null {
  if (!entry.lesson || entry.lesson === '(no lesson extracted)') return null;
  if (entry.category === 'neutral') return null; // only extract from clear wins/mistakes

  const db = getDb();

  // Normalize the lesson into a rule
  const ruleText = entry.lesson.length > 200 ? entry.lesson.slice(0, 200) : entry.lesson;

  // Infer trigger context from the rule text
  const triggerContext = inferTriggerContext(ruleText, entry.category);

  // Check for near-duplicate (same user, similar rule text)
  const existing = db.prepare(
    `SELECT id, confidence, application_count FROM behavioral_rules
     WHERE user_id = ? AND category = ? AND (rule_text = ? OR ? LIKE '%' || rule_text || '%')
     ORDER BY confidence DESC LIMIT 1`
  ).get(entry.userId, entry.category, ruleText, ruleText) as BehavioralRule | undefined;

  if (existing) {
    // Strengthen existing rule
    const boost = entry.category === 'win' ? 0.1 : 0.05;
    const newConfidence = Math.min(1.0, existing.confidence + boost);
    db.prepare(`
      UPDATE behavioral_rules
      SET confidence = ?, application_count = application_count + 1, last_applied_at = datetime('now')
      WHERE id = ?
    `).run(newConfidence, existing.id);
    return { ...existing, confidence: newConfidence };
  }

  // Create new rule
  const initialConfidence = entry.category === 'win' ? 0.6 : 0.4;
  const result = db.prepare(`
    INSERT INTO behavioral_rules (user_id, project_id, category, rule_text, trigger_context, source_score, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.userId,
    entry.projectId,
    entry.category,
    ruleText,
    triggerContext,
    entry.sourceScore,
    initialConfidence,
  );

  return db.prepare('SELECT * FROM behavioral_rules WHERE id = ?').get(result.lastInsertRowid) as BehavioralRule;
}

// ── Infer trigger context from rule text ──────────────────────────────────────

function inferTriggerContext(ruleText: string, category: string): string {
  const lower = ruleText.toLowerCase();

  // Map common patterns to trigger contexts
  const triggers: Array<{ pattern: RegExp; context: string }> = [
    { pattern: /\b(empty|null|undefined|optional|default)\b/, context: 'when handling optional/empty states' },
    { pattern: /\b(error|fail|exception|catch|throw|try)\b/, context: 'when implementing error handling' },
    { pattern: /\b(type|interface|generic|typedef|extends|implements)\b/, context: 'when defining types and interfaces' },
    { pattern: /\b(import|export|module|require|dependenc)\b/, context: 'when managing dependencies' },
    { pattern: /\b(test|spec|assert|expect|mock|jest|vitest)\b/, context: 'when writing tests' },
    { pattern: /\b(security|auth|token|password|credential|secret|key)\b/, context: 'when handling sensitive data' },
    { pattern: /\b(async|await|promise|callback|concurr|parallel)\b/, context: 'when managing async operations' },
    { pattern: /\b(query|sql|database|db|migration|schema)\b/, context: 'when working with databases' },
    { pattern: /\b(api|route|endpoint|http|request|response)\b/, context: 'when building API endpoints' },
    { pattern: /\b(style|css|layout|responsive|theme|ui)\b/, context: 'when implementing UI/styling' },
    { pattern: /\b(config|setting|env|constant|variable)\b/, context: 'when managing configuration' },
    { pattern: /\b(refactor|clean|rename|restructur|extract)\b/, context: 'when refactoring code' },
    { pattern: /\b(comment|doc|readme|document)\b/, context: 'when writing documentation' },
    { pattern: /\b(performance|optimize|slow|cache|memo)\b/, context: 'when optimizing performance' },
    { pattern: /\b(lint|format|prettier|eslint|standard)\b/, context: 'when ensuring code quality' },
  ];

  for (const t of triggers) {
    if (t.pattern.test(lower)) return t.context;
  }

  // Default context based on category
  return category === 'win'
    ? 'general coding tasks (proven pattern)'
    : 'general coding tasks (watch for this pattern)';
}

// ── Get relevant behavioral rules for a given context ─────────────────────────

/**
 * Get the most relevant behavioral rules for a user, ordered by confidence.
 * These are injected into the system prompt before each task.
 */
export function getRelevantRules(userId: number, options?: {
  category?: 'win' | 'mistake';
  minConfidence?: number;
  limit?: number;
}): BehavioralRule[] {
  const db = getDb();
  const minConfidence = options?.minConfidence ?? 0.4;
  const limit = options?.limit ?? 10;

  let query = `
    SELECT * FROM behavioral_rules
    WHERE user_id = ? AND confidence >= ?
  `;
  const params: unknown[] = [userId, minConfidence];

  if (options?.category) {
    query += ' AND category = ?';
    params.push(options.category);
  }

  query += ' ORDER BY confidence DESC, application_count DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params) as BehavioralRule[];
}

// ── Format behavioral rules for system prompt injection ───────────────────────

/**
 * Format behavioral rules as a string for injection into the system prompt.
 * Win rules are phrased as "Always do X" and mistake rules as "Avoid Y".
 */
export function formatBehavioralRules(rules: BehavioralRule[]): string {
  if (rules.length === 0) return '';

  const winRules = rules.filter(r => r.category === 'win');
  const mistakeRules = rules.filter(r => r.category === 'mistake');

  const parts: string[] = [];

  // Group by trigger context for readability
  const contextGroups = new Map<string, BehavioralRule[]>();
  for (const rule of rules) {
    const ctx = rule.triggerContext || 'general';
    if (!contextGroups.has(ctx)) contextGroups.set(ctx, []);
    contextGroups.get(ctx)!.push(rule);
  }

  for (const [context, groupRules] of contextGroups) {
    const groupWins = groupRules.filter(r => r.category === 'win');
    const groupMistakes = groupRules.filter(r => r.category === 'mistake');

    if (groupWins.length > 0) {
      parts.push(`[When ${context}, always:]`);
      for (const r of groupWins) {
        parts.push(`  ✓ ${r.ruleText}`);
      }
    }

    if (groupMistakes.length > 0) {
      parts.push(`[When ${context}, avoid:]`);
      for (const r of groupMistakes) {
        parts.push(`  ✗ ${r.ruleText}`);
      }
    }
  }

  return `[BEHAVIORAL RULES — learned from ${rules.length} past tasks]\n${parts.join('\n')}`;
}

// ── Prune low-confidence rules ────────────────────────────────────────────────

/**
 * Remove behavioral rules that have low confidence after being applied
 * multiple times. Rules with confidence < 0.2 after 3+ applications are removed.
 */
export function pruneLowConfidenceRules(userId: number): {
  totalRemoved: number;
} {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM behavioral_rules
    WHERE user_id = ? AND confidence < 0.2 AND application_count >= 3
  `).run(userId);

  return { totalRemoved: result.changes };
}

// ── Phase 2.3: Extract mistake rules from lint/test failures ──────────────────

export interface MistakeContext {
  errorCount: number;
  retriesUsed: number;
  gaveUp: boolean;
  context: string; // user message or task intent (truncated)
}

/**
 * Extract a behavioral rule from a lint or test failure pattern.
 * Stores it with category 'mistake' and elevated initial confidence (0.7)
 * since lint/test failures represent confirmed errors, not speculation.
 */
export function extractMistakeRule(
  userId: number,
  projectId: number | null,
  source: 'lint' | 'test',
  info: MistakeContext,
): BehavioralRule | null {
  const db = getDb();

  // Generate a descriptive rule from the error context
  const sourceLabel = source === 'lint' ? 'type/lint error' : 'test failure';
  const retryDesc = info.gaveUp
    ? `was NOT resolved after ${info.retriesUsed} attempts`
    : `resolved in ${info.retriesUsed} attempt(s)`;

  const ruleText = info.gaveUp
    ? `${sourceLabel} pattern (${info.errorCount} error(s), ${retryDesc}) — task: "${info.context}"`
    : `${sourceLabel} pattern (${info.errorCount} error(s), ${retryDesc}) — task: "${info.context}"`;

  const triggerContext = source === 'lint'
    ? 'when writing or modifying TypeScript files'
    : 'when implementing features that affect existing tests';

  const existing = db.prepare(
    `SELECT id FROM behavioral_rules
     WHERE user_id = ? AND category = 'mistake' AND rule_text = ?
     LIMIT 1`,
  ).get(userId, ruleText) as { id: number } | undefined;

  if (existing) {
    // Increment application count
    db.prepare(
      `UPDATE behavioral_rules
       SET application_count = application_count + 1,
           confidence = MIN(1.0, confidence + 0.05),
           last_applied_at = datetime('now')
       WHERE id = ?`,
    ).run(existing.id);
    return db.prepare('SELECT * FROM behavioral_rules WHERE id = ?').get(existing.id) as BehavioralRule;
  }

  // New mistake rule — starts at 0.7 confidence (lint/test failures are concrete evidence)
  const result = db.prepare(
    `INSERT INTO behavioral_rules (user_id, project_id, category, rule_text, trigger_context, source_score, confidence, application_count)
     VALUES (?, ?, 'mistake', ?, ?, ?, 0.7, 1)`,
  ).run(userId, projectId, ruleText, triggerContext, info.errorCount);

  console.log(`[behavioral-rules] Extracted mistake rule #${result.lastInsertRowid}: ${ruleText.slice(0, 80)}...`);

  return db.prepare('SELECT * FROM behavioral_rules WHERE id = ?').get(result.lastInsertRowid) as BehavioralRule;
}

// ── Get training progress report ──────────────────────────────────────────────

/**
 * Get a summary of how many behavioral rules have been learned.
 */
export function getTrainingProgress(userId: number): {
  totalRules: number;
  winRules: number;
  mistakeRules: number;
  avgConfidence: number;
  topRules: BehavioralRule[];
} {
  const db = getDb();

  const allRules = db.prepare(
    'SELECT * FROM behavioral_rules WHERE user_id = ? ORDER BY confidence DESC',
  ).all(userId) as BehavioralRule[];

  if (allRules.length === 0) {
    return { totalRules: 0, winRules: 0, mistakeRules: 0, avgConfidence: 0, topRules: [] };
  }

  return {
    totalRules: allRules.length,
    winRules: allRules.filter(r => r.category === 'win').length,
    mistakeRules: allRules.filter(r => r.category === 'mistake').length,
    avgConfidence: Math.round(
      (allRules.reduce((s, r) => s + r.confidence, 0) / allRules.length) * 100,
    ) / 100,
    topRules: allRules.slice(0, 5),
  };
}
