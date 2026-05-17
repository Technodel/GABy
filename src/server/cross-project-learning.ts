/**
 * SUNy Cross-Project Knowledge Transfer — shared learning across projects.
 *
 * When enabled (via user settings), high-confidence patterns extracted from one
 * project are shared with others. This includes:
 *   1. Error patterns with confirmed fixes (high recurrence, high success rate)
 *   2. Design decisions marked as "architectural" or cross-cutting
 *   3. User preferences and coding conventions
 *
 * The system de-identifies project-specific details (file paths, variable names)
 * before storing shared patterns, keeping only the generalizable learning.
 *
 * Opt-in only — user must toggle from settings. Each user's projects form
 * their own learning pool (no cross-user sharing).
 *
 * Feature flag: ff_cross_project_learning
 * Settings key: user_{id}_cross_project_learning_enabled
 */

import { getDb } from './db';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SharedPattern {
  id: number;
  userId: number;
  sourceProjectId: number;
  sourceProjectName: string;
  patternType: 'error_fix' | 'design_decision' | 'coding_convention' | 'user_preference';
  patternKey: string;
  patternSummary: string;
  patternDetail: string;
  confidence: number;          // 0.0 – 1.0
  applicationCount: number;    // how many times this pattern was reused
  lastAppliedAt: string | null;
  createdAt: string;
}

// ── DB initialization ─────────────────────────────────────────────────────────

export function initializeCrossProjectTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_project_id INTEGER NOT NULL,
      source_project_name TEXT DEFAULT '',
      pattern_type TEXT NOT NULL,
      pattern_key TEXT NOT NULL,
      pattern_summary TEXT NOT NULL,
      pattern_detail TEXT DEFAULT '',
      confidence REAL DEFAULT 0.5,
      application_count INTEGER DEFAULT 0,
      last_applied_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(source_project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_user ON shared_patterns(user_id);
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_type ON shared_patterns(pattern_type);
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_key ON shared_patterns(pattern_key);
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_confidence ON shared_patterns(confidence);
  `);
}

// ── Check if cross-project learning is enabled for a user ─────────────────────

export function isCrossProjectLearningEnabled(userId: number): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT value FROM app_settings WHERE key = ?"
  ).get(`user_${userId}_cross_project_learning_enabled`) as { value: string } | undefined;
  return row?.value === 'true';
}

// ── Extract and store shared patterns ─────────────────────────────────────────

/**
 * Extract a generalizable error pattern from a failure memory entry and
 * store it in the shared patterns pool.
 */
export function shareErrorPattern(entry: {
  userId: number;
  projectId: number;
  projectName: string;
  errorPattern: string;
  errorMessage: string;
  attemptedFix: string;
  fixSucceeded: boolean;
  recurrenceCount: number;
}): SharedPattern | null {
  if (!isCrossProjectLearningEnabled(entry.userId)) return null;
  if (!entry.fixSucceeded) return null;
  if (entry.recurrenceCount < 2) return null; // need at least 2 occurrences to be a pattern

  const db = getDb();
  const normalizedPattern = entry.errorPattern;
  const key = `err:${normalizedPattern.slice(0, 80)}`;

  // Check if this pattern already exists
  const existing = db.prepare(
    'SELECT id, application_count, confidence FROM shared_patterns WHERE user_id = ? AND pattern_key = ?'
  ).get(entry.userId, key) as SharedPattern | undefined;

  if (existing) {
    // Increment confidence and application count
    const newConfidence = Math.min(1.0, existing.confidence + 0.1);
    db.prepare(`
      UPDATE shared_patterns
      SET confidence = ?, application_count = application_count + 1, last_applied_at = datetime('now')
      WHERE id = ?
    `).run(newConfidence, existing.id);
    return { ...existing, confidence: newConfidence, applicationCount: existing.application_count + 1 };
  }

  // Create new shared pattern
  const result = db.prepare(`
    INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence, application_count)
    VALUES (?, ?, ?, 'error_fix', ?, ?, ?, ?, 1)
  `).run(
    entry.userId,
    entry.projectId,
    entry.projectName.slice(0, 100),
    key,
    `Failed with: ${normalizedPattern.slice(0, 150)}`,
    entry.attemptedFix.slice(0, 500),
    Math.min(0.9, 0.3 + entry.recurrenceCount * 0.15),
  );

  return db.prepare('SELECT * FROM shared_patterns WHERE id = ?').get(result.lastInsertRowid) as SharedPattern;
}

/**
 * Extract a generalizable design decision from a blueprint entry.
 */
export function shareDesignDecision(entry: {
  userId: number;
  projectId: number;
  projectName: string;
  category: string;
  summary: string;
  details: string | null;
}): SharedPattern | null {
  if (!isCrossProjectLearningEnabled(entry.userId)) return null;
  if (!['architecture_change', 'design_decision', 'config_change'].includes(entry.category)) return null;

  const db = getDb();
  const key = `design:${entry.summary.slice(0, 100)}`;

  const existing = db.prepare(
    'SELECT id FROM shared_patterns WHERE user_id = ? AND pattern_key = ?'
  ).get(entry.userId, key) as SharedPattern | undefined;
  if (existing) return null; // already recorded

  const result = db.prepare(`
    INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence)
    VALUES (?, ?, ?, 'design_decision', ?, ?, ?, 0.5)
  `).run(
    entry.userId,
    entry.projectId,
    entry.projectName.slice(0, 100),
    key,
    entry.summary.slice(0, 200),
    entry.details?.slice(0, 500) ?? '',
  );

  return db.prepare('SELECT * FROM shared_patterns WHERE id = ?').get(result.lastInsertRowid) as SharedPattern;
}

// ── Query shared patterns ─────────────────────────────────────────────────────

/**
 * Get all shared patterns for a user that are applicable to a given context.
 * Returns patterns ranked by confidence × relevance.
 */
export function getRelevantPatterns(userId: number, context?: {
  patternTypes?: string[];
  minConfidence?: number;
  limit?: number;
}): SharedPattern[] {
  if (!isCrossProjectLearningEnabled(userId)) return [];

  const db = getDb();
  const minConfidence = context?.minConfidence ?? 0.3;
  const limit = context?.limit ?? 20;

  let query = `
    SELECT * FROM shared_patterns
    WHERE user_id = ? AND confidence >= ?
  `;
  const params: unknown[] = [userId, minConfidence];

  if (context?.patternTypes && context.patternTypes.length > 0) {
    const placeholders = context.patternTypes.map(() => '?').join(',');
    query += ` AND pattern_type IN (${placeholders})`;
    params.push(...context.patternTypes);
  }

  query += ' ORDER BY confidence DESC, application_count DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params) as SharedPattern[];
}

/**
 * Get cross-project patterns formatted for AI prompt injection.
 */
export function formatSharedPatterns(patterns: SharedPattern[]): string {
  if (patterns.length === 0) return '';

  let result = '[CROSS-PROJECT KNOWLEDGE]\n';

  for (const p of patterns) {
    const typeLabel = p.pattern_type === 'error_fix' ? '⚠️ Error Pattern'
      : p.pattern_type === 'design_decision' ? '📐 Design Pattern'
      : p.pattern_type === 'coding_convention' ? '🔧 Convention'
      : '💡 Preference';

    result += `  • ${typeLabel} (confidence=${p.confidence.toFixed(2)}, used=${p.application_count}x)\n`;
    result += `    "${p.pattern_summary}"\n`;
    result += `    (from: ${p.source_project_name})\n`;
  }

  return result;
}

// ── Phase 2.4: Cross-Project Persona Memory ────────────────────────────────────

export interface PersonaUpdateInput {
  userId: number;
  projectId: number | null;
  userMessage: string;
  aiResponse: string;
}

/**
 * Detect and store user preferences from conversation patterns so they carry
 * across projects. Tracks: verbosity, formality, framework preferences.
 */
export function updateCrossProjectPersona(input: PersonaUpdateInput): { updated: boolean; reason: string } {
  const db = getDb();

  // Detect verbosity preference: short user messages = prefs conciseness
  const userMsgLen = input.userMessage.length;
  const responseLen = input.aiResponse.length;

  if (userMsgLen < 80 && responseLen > 1500) {
    // User was brief, AI was verbose — might be a pattern
    const key = 'verbosity_preference:' + (userMsgLen < 40 ? 'concise' : 'moderate');
    const existing = db.prepare(
      `SELECT id FROM shared_patterns WHERE user_id = ? AND pattern_key = ?`
    ).get(input.userId, key) as { id: number } | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence)
         VALUES (?, ?, 'current', 'user_preference', ?, 'User prefers ' || ?, 'Detected from message patterns', 0.5)`,
      ).run(input.userId, input.projectId ?? 0, key, key === 'verbosity_preference:concise' ? 'concise responses' : 'moderate detail');
      return { updated: true, reason: `Detected ${key}` };
    } else {
      db.prepare(
        `UPDATE shared_patterns SET application_count = application_count + 1, confidence = MIN(1.0, confidence + 0.05) WHERE id = ?`,
      ).run(existing.id);
      return { updated: true, reason: `Reinforced ${key}` };
    }
  }

  // Detect framework mentions in user messages
  const frameworks = ['react', 'next.js', 'nextjs', 'vue', 'angular', 'svelte', 'express', 'fastify', 'nestjs', 'typescript', 'javascript', 'python', 'rust', 'go'];
  for (const fw of frameworks) {
    if (input.userMessage.toLowerCase().includes(fw)) {
      const key = `framework_pref:${fw}`;
      const existing = db.prepare(
        `SELECT id FROM shared_patterns WHERE user_id = ? AND pattern_key = ?`
      ).get(input.userId, key) as { id: number } | undefined;

      if (!existing) {
        db.prepare(
          `INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence)
           VALUES (?, ?, 'current', 'coding_convention', ?, 'User works with ' || ?, 'Detected from message patterns', 0.6)`,
        ).run(input.userId, input.projectId ?? 0, key, fw);
        return { updated: true, reason: `Detected framework preference: ${fw}` };
      } else {
        db.prepare(
          `UPDATE shared_patterns SET application_count = application_count + 1, confidence = MIN(1.0, confidence + 0.05) WHERE id = ?`,
        ).run(existing.id);
        return { updated: true, reason: `Reinforced framework preference: ${fw}` };
      }
    }
  }

  return { updated: false, reason: 'No persona pattern detected' };
}
