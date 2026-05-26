/**
 * SUNy Cross-Project Knowledge Transfer â€” shared learning across projects.
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
 * Opt-in only â€” user must toggle from settings. Each user's projects form
 * their own learning pool (no cross-user sharing).
 *
 * Feature flag: ff_cross_project_learning
 * Settings key: user_{id}_cross_project_learning_enabled
 */

import { getAdapter } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SharedPattern {
  id: number;
  userId: number;
  sourceProjectId: number;
  sourceProjectName: string;
  patternType: 'error_fix' | 'design_decision' | 'coding_convention' | 'user_preference';
  patternKey: string;
  patternSummary: string;
  patternDetail: string;
  confidence: number;          // 0.0 â€“ 1.0
  applicationCount: number;    // how many times this pattern was reused
  lastAppliedAt: string | null;
  createdAt: string;
}

// â”€â”€ DB initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function initializeCrossProjectTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
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

// â”€â”€ Check if cross-project learning is enabled for a user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function isCrossProjectLearningEnabled(userId: number): Promise<boolean> {
  const db = await getAdapter();
  const row = await db.get(
    "SELECT value FROM app_settings WHERE key = ?",
    [`user_${userId}_cross_project_learning_enabled`],
  ) as { value: string } | undefined;
  return row?.value === 'true';
}

// â”€â”€ Extract and store shared patterns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Extract a generalizable error pattern from a failure memory entry and
 * store it in the shared patterns pool.
 */
export async function shareErrorPattern(entry: {
  userId: number;
  projectId: number;
  projectName: string;
  errorPattern: string;
  errorMessage: string;
  attemptedFix: string;
  fixSucceeded: boolean;
  recurrenceCount: number;
}): Promise<SharedPattern | null> {
  if (!(await isCrossProjectLearningEnabled(entry.userId))) return null;
  if (!entry.fixSucceeded) return null;
  if (entry.recurrenceCount < 2) return null; // need at least 2 occurrences to be a pattern

  const db = await getAdapter();
  const normalizedPattern = entry.errorPattern;
  const key = `err:${normalizedPattern.slice(0, 80)}`;

  // Check if this pattern already exists
  const existing = await db.get(
    'SELECT id, application_count, confidence FROM shared_patterns WHERE user_id = ? AND pattern_key = ?',
    [entry.userId, key],
  ) as SharedPattern | undefined;

  if (existing) {
    // Increment confidence and application count
    const newConfidence = Math.min(1.0, existing.confidence + 0.1);
    await db.run(
      `UPDATE shared_patterns
      SET confidence = ?, application_count = application_count + 1, last_applied_at = datetime('now')
      WHERE id = ?`,
      [newConfidence, existing.id],
    );
    return { ...existing, confidence: newConfidence, applicationCount: existing.application_count + 1 };
  }

  // Create new shared pattern
  const result = await db.run(
    `INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence, application_count)
    VALUES (?, ?, ?, 'error_fix', ?, ?, ?, ?, 1)`,
    [
      entry.userId,
      entry.projectId,
      entry.projectName.slice(0, 100),
      key,
      `Failed with: ${normalizedPattern.slice(0, 150)}`,
      entry.attemptedFix.slice(0, 500),
      Math.min(0.9, 0.3 + entry.recurrenceCount * 0.15),
    ],
  );

  return await db.get('SELECT * FROM shared_patterns WHERE id = ?', [result.lastInsertRowid]) as SharedPattern;
}

/**
 * Extract a generalizable design decision from a blueprint entry.
 */
export async function shareDesignDecision(entry: {
  userId: number;
  projectId: number;
  projectName: string;
  category: string;
  summary: string;
  details: string | null;
}): Promise<SharedPattern | null> {
  if (!(await isCrossProjectLearningEnabled(entry.userId))) return null;
  if (!['architecture_change', 'design_decision', 'config_change'].includes(entry.category)) return null;

  const db = await getAdapter();
  const key = `design:${entry.summary.slice(0, 100)}`;

  const existing = await db.get(
    'SELECT id FROM shared_patterns WHERE user_id = ? AND pattern_key = ?',
    [entry.userId, key],
  ) as SharedPattern | undefined;
  if (existing) return null; // already recorded

  const result = await db.run(
    `INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence)
    VALUES (?, ?, ?, 'design_decision', ?, ?, ?, 0.5)`,
    [
      entry.userId,
      entry.projectId,
      entry.projectName.slice(0, 100),
      key,
      entry.summary.slice(0, 200),
      entry.details?.slice(0, 500) ?? '',
    ],
  );

  return await db.get('SELECT * FROM shared_patterns WHERE id = ?', [result.lastInsertRowid]) as SharedPattern;
}

// â”€â”€ Query shared patterns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Get all shared patterns for a user that are applicable to a given context.
 * Returns patterns ranked by confidence Ã— relevance.
 */
export async function getRelevantPatterns(userId: number, context?: {
  patternTypes?: string[];
  minConfidence?: number;
  limit?: number;
}): Promise<SharedPattern[]> {
  if (!(await isCrossProjectLearningEnabled(userId))) return [];

  const db = await getAdapter();
  const minConfidence = context?.minConfidence ?? 0.3;
  const limit = context?.limit ?? 20;

  let query = `SELECT * FROM shared_patterns WHERE user_id = ? AND confidence >= ?`;
  const params: unknown[] = [userId, minConfidence];

  if (context?.patternTypes && context.patternTypes.length > 0) {
    const placeholders = context.patternTypes.map(() => '?').join(',');
    query += ` AND pattern_type IN (${placeholders})`;
    params.push(...context.patternTypes);
  }

  query += ' ORDER BY confidence DESC, application_count DESC LIMIT ?';
  params.push(limit);

  return await db.all(query, params) as SharedPattern[];
}

/**
 * Get cross-project patterns formatted for AI prompt injection.
 */
export function formatSharedPatterns(patterns: SharedPattern[]): string {
  if (patterns.length === 0) return '';

  let result = '[CROSS-PROJECT KNOWLEDGE]\n';

  for (const p of patterns) {
    const typeLabel = p.pattern_type === 'error_fix' ? 'âš ï¸ Error Pattern'
      : p.pattern_type === 'design_decision' ? 'ðŸ“ Design Pattern'
      : p.pattern_type === 'coding_convention' ? 'ðŸ”§ Convention'
      : 'ðŸ’¡ Preference';

    result += `  â€¢ ${typeLabel} (confidence=${p.confidence.toFixed(2)}, used=${p.application_count}x)\n`;
    result += `    "${p.pattern_summary}"\n`;
    result += `    (from: ${p.source_project_name})\n`;
  }

  return result;
}

// â”€â”€ Phase 2.4: Cross-Project Persona Memory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
export async function updateCrossProjectPersona(input: PersonaUpdateInput): Promise<{ updated: boolean; reason: string }> {
  const db = await getAdapter();

  // Detect verbosity preference: short user messages = prefs conciseness
  const userMsgLen = input.userMessage.length;
  const responseLen = input.aiResponse.length;

  if (userMsgLen < 80 && responseLen > 1500) {
    // User was brief, AI was verbose â€” might be a pattern
    const key = 'verbosity_preference:' + (userMsgLen < 40 ? 'concise' : 'moderate');
    const existing = await db.get(
      `SELECT id FROM shared_patterns WHERE user_id = ? AND pattern_key = ?`,
      [input.userId, key],
    ) as { id: number } | undefined;

    if (!existing) {
      await db.run(
        `INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence)
         VALUES (?, ?, 'current', 'user_preference', ?, ?, 'Detected from message patterns', 0.5)`,
        [input.userId, input.projectId ?? 0, key, key === 'verbosity_preference:concise' ? 'concise responses' : 'moderate detail'],
      );
      return { updated: true, reason: `Detected ${key}` };
    } else {
      await db.run(
        `UPDATE shared_patterns SET application_count = application_count + 1, confidence = MIN(1.0, confidence + 0.05) WHERE id = ?`,
        [existing.id],
      );
      return { updated: true, reason: `Reinforced ${key}` };
    }
  }

  // Detect framework mentions in user messages
  const frameworks = ['react', 'next.js', 'nextjs', 'vue', 'angular', 'svelte', 'express', 'fastify', 'nestjs', 'typescript', 'javascript', 'python', 'rust', 'go'];
  for (const fw of frameworks) {
    if (input.userMessage.toLowerCase().includes(fw)) {
      const key = `framework_pref:${fw}`;
      const existing = await db.get(
        `SELECT id FROM shared_patterns WHERE user_id = ? AND pattern_key = ?`,
        [input.userId, key],
      ) as { id: number } | undefined;

      if (!existing) {
        await db.run(
          `INSERT INTO shared_patterns (user_id, source_project_id, source_project_name, pattern_type, pattern_key, pattern_summary, pattern_detail, confidence)
           VALUES (?, ?, 'current', 'coding_convention', ?, ?, 'Detected from message patterns', 0.6)`,
          [input.userId, input.projectId ?? 0, key, fw],
        );
        return { updated: true, reason: `Detected framework preference: ${fw}` };
      } else {
        await db.run(
          `UPDATE shared_patterns SET application_count = application_count + 1, confidence = MIN(1.0, confidence + 0.05) WHERE id = ?`,
          [existing.id],
        );
        return { updated: true, reason: `Reinforced framework preference: ${fw}` };
      }
    }
  }

  return { updated: false, reason: 'No persona pattern detected' };
}

// â”€â”€ Phase 3: Aggregation + Anonymization + Prompt Builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Known project-name patterns for anonymization.
 * Strips these from pattern_summary and pattern_detail to remove
 * project-specific identifiers before injecting into new projects.
 */
const PROJECT_SPECIFIC_PATTERNS = [
  /project\s+['"][^'"]+['"]/gi,
  /repo(?:sitory)?\s+['"][^'"]+['"]/gi,
  /app\s+['"][^'"]+['"]/gi,
  /module\s+['"][^'"]+['"]/gi,
  /\b[A-Z][a-zA-Z]*[A-Z][a-zA-Z]*\b/g,   // CamelCaseWithMultipleUppercase (likely project names)
];

/**
 * Anonymize a pattern by stripping project-specific identifiers.
 * Returns a sanitized copy of the pattern.
 */
export function anonymizePattern(pattern: SharedPattern): SharedPattern {
  let summary = pattern.patternSummary;
  let detail = pattern.patternDetail;

  for (const re of PROJECT_SPECIFIC_PATTERNS) {
    summary = summary.replace(re, '[project]');
    detail = detail.replace(re, '[project]');
  }

  // Strip known file path patterns
  summary = summary.replace(/(src\/|lib\/|app\/|components\/)[^\s,;)]+/g, '[path]');
  detail = detail.replace(/(src\/|lib\/|app\/|components\/)[^\s,;)]+/g, '[path]');

  return {
    ...pattern,
    patternSummary: summary,
    patternDetail: detail,
    sourceProjectName: '[shared]',
  };
}

interface AggregatedPattern {
  type: string;
  category: string;
  summary: string;
  confidence: number;
  applicationCount: number;
  sourceCount: number;       // how many source patterns fed into this cluster
  patternDetailSummary: string;
}

/**
 * Cluster similar patterns by type and key prefix, then rank by
 * (confidence Ã— applicationCount) and return the top 5 aggregated entries.
 *
 * The clustering groups patterns with the same type prefix
 * (e.g. all err: patterns, all design: patterns) and within each type
 * groups those with overlapping key tokens.
 */
export function aggregateSharedPatterns(patterns: SharedPattern[]): AggregatedPattern[] {
  if (patterns.length === 0) return [];

  // 1. Anonymize
  const anonymized = patterns.map(p => anonymizePattern(p));

  // 2. Group by type
  const byType = new Map<string, SharedPattern[]>();
  for (const p of anonymized) {
    const type = p.patternType;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(p);
  }

  // 3. Within each type, cluster by shared key tokens (split by ':')
  const clusters: AggregatedPattern[] = [];

  for (const [type, typePatterns] of byType) {
    // Sort by confidence desc
    typePatterns.sort((a, b) => b.confidence - a.confidence);

    // Pick the top patterns, merge similar ones
    const considered = new Set<number>();
    for (let i = 0; i < typePatterns.length && clusters.length < 8; i++) {
      if (considered.has(i)) continue;
      const base = typePatterns[i];
      considered.add(i);

      const similar: SharedPattern[] = [base];
      const baseTokens = base.patternKey.toLowerCase().split(/[:_\s]+/).filter(Boolean);

      for (let j = i + 1; j < typePatterns.length; j++) {
        if (considered.has(j)) continue;
        const cmp = typePatterns[j];
        const cmpTokens = cmp.patternKey.toLowerCase().split(/[:_\s]+/).filter(Boolean);
        // Check overlap: at least 40% of tokens match
        const intersect = baseTokens.filter(t => cmpTokens.includes(t));
        const overlap = intersect.length / Math.max(baseTokens.length, cmpTokens.length);
        if (overlap >= 0.4) {
          similar.push(cmp);
          considered.add(j);
        }
      }

      // Merge cluster: use best confidence, sum counts, pick representative summary
      const avgConfidence = similar.reduce((s, p) => s + p.confidence, 0) / similar.length;
      const totalApplications = similar.reduce((s, p) => s + p.applicationCount, 0);
      const bestSummary = similar.reduce((a, b) => a.confidence > b.confidence ? a : b).patternSummary;
      const detailSummary = similar.length > 1
        ? `(merged from ${similar.length} similar patterns)`
        : (similar[0].patternDetail?.slice(0, 200) || '');

      const typeLabel = type === 'error_fix' ? 'Error Pattern'
        : type === 'design_decision' ? 'Design Pattern'
        : type === 'coding_convention' ? 'Convention'
        : 'Preference';

      clusters.push({
        type,
        category: typeLabel,
        summary: bestSummary,
        confidence: avgConfidence,
        applicationCount: totalApplications,
        sourceCount: similar.length,
        patternDetailSummary: detailSummary,
      });
    }
  }

  // 5. Sort by composite score: confidence Ã— sqrt(applicationCount)
  clusters.sort((a, b) => {
    const scoreA = a.confidence * Math.sqrt(a.applicationCount + 1);
    const scoreB = b.confidence * Math.sqrt(b.applicationCount + 1);
    return scoreB - scoreA;
  });

  // 6. Return top 5
  return clusters.slice(0, 5);
}

/**
 * Build a full cross-project knowledge prompt block for injection into
 * the system prompt. Runs the full pipeline:
 *   1. Fetch relevant patterns (confidence â‰¥ 0.3, all types)
 *   2. Aggregate + anonymize
 *   3. Format into a clean prompt block
 *
 * Returns empty string if cross-project learning is disabled or no patterns found.
 */
export async function buildCrossProjectPrompt(userId: number): Promise<string> {
  if (!(await isCrossProjectLearningEnabled(userId))) return '';

  const patterns = await getRelevantPatterns(userId, {
    minConfidence: 0.3,
    limit: 50,     // fetch enough for clustering
  });

  if (patterns.length === 0) return '';

  const aggregated = aggregateSharedPatterns(patterns);
  if (aggregated.length === 0) return '';

  const lines: string[] = [
    '',
    '<cross_project_knowledge>',
    'The following patterns were learned from your other projects. They may be relevant here:',
  ];

  for (const a of aggregated) {
    lines.push(`  â€¢ ${a.category}: ${a.summary}`);
    lines.push(`    (confidence: ${(a.confidence * 100).toFixed(0)}%, reused ${a.applicationCount}x across ${a.sourceCount} pattern(s))`);
  }

  lines.push('</cross_project_knowledge>');
  lines.push('');

  return lines.join('\n');
}
