/**
 * SUNy Code Conscience â€” Blueprint Memory Layer
 *
 * Persistently stores design decisions, architectural intent, and session
 * outcomes so that every turn compounds knowledge rather than starting fresh.
 *
 * Two capabilities:
 *   1. POST-TURN EXTRACTION â€” after the agent loop completes, this module
 *      analyzes what happened (what files changed, what intent drove the
 *      changes, what the outcome was) and writes a concise blueprint entry.
 *   2. PRE-TURN INJECTION â€” before the agent loop starts, relevant prior
 *      blueprint entries are injected into the system prompt so the AI
 *      operates with full memory of past design decisions.
 */

import { getAdapter } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BlueprintEntry {
  id: number;
  user_id: number;
  project_id: number | null;
  session_id: string | null;
  turn_index: number;
  category: BlueprintCategory;
  summary: string;
  details: string | null;
  intent: string | null;
  affected_files: string | null; // JSON array of file paths
  created_at: string;
}

export type BlueprintCategory =
  | 'design_decision'
  | 'architecture_change'
  | 'bug_fix'
  | 'refactor'
  | 'feature_add'
  | 'dependency_change'
  | 'config_change'
  | 'test_strategy'
  | 'user_preference'
  | 'goal_completed';

// â”€â”€ Category heuristics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function classifyCategory(summary: string, changedFiles: string[], userMessage: string): BlueprintCategory {
  const t = `${summary} ${userMessage}`.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|regression|issue)\b/.test(t)) return 'bug_fix';
  if (/\b(refactor(ed|ing)?|clean|restructure|rename|extract|reorganize)\b/.test(t)) return 'refactor';
  if (/\b(feature|add|new|implement|create|introduce)\b/.test(t)) return 'feature_add';
  if (/\b(depend|package|npm|pip|gem|cargo|install|upgrade|downgrade)\b/.test(t)) return 'dependency_change';
  if (/\b(config|setting|setup|environment|env)\b/.test(t)) return 'config_change';
  if (/\b(architect|design|pattern|structur|layout|plan)\b/.test(t)) return 'architecture_change';
  if (/\b(test|spec|jest|mocha|vitest|coverage)\b/.test(t)) return 'test_strategy';
  if (/\b(prefer|like|want|style|format|theme|dark|mode)\b/.test(t)) return 'user_preference';
  if (/\b(done|complete|finish|achieved|goal|accomplish)\b/.test(t)) return 'goal_completed';
  return 'design_decision';
}

// â”€â”€ Extract intent from user message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function extractIntent(userMessage: string): string {
  // Use the first sentence or question as the core intent
  const cleaned = userMessage
    .replace(/^(i want|i need|please|can you|could you|would you)\s+/i, '')
    .replace(/[.!?].*$/, '')
    .trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

// â”€â”€ Store a blueprint entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function storeBlueprintEntry(entry: {
  userId: number;
  projectId: number | null;
  sessionId: string;
  turnIndex: number;
  summary: string;
  details?: string;
  intent?: string;
  affectedFiles?: string[];
}): Promise<BlueprintEntry> {
  const db = await getAdapter();
  const category = classifyCategory(entry.summary, entry.affectedFiles ?? [], entry.intent ?? '');
  const intent = entry.intent ?? extractIntent(entry.summary);
  const filesJson = entry.affectedFiles?.length ? JSON.stringify(entry.affectedFiles) : null;

  const result = await db.run(
    `INSERT INTO blueprint_entries (user_id, project_id, session_id, turn_index, category, summary, details, intent, affected_files)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.projectId,
      entry.sessionId,
      entry.turnIndex,
      category,
      entry.summary.slice(0, 500),
      entry.details?.slice(0, 2000) ?? null,
      intent.slice(0, 300),
      filesJson,
    ],
  );

  return {
    id: result.lastInsertRowid as number,
    user_id: entry.userId,
    project_id: entry.projectId,
    session_id: entry.sessionId,
    turn_index: entry.turnIndex,
    category,
    summary: entry.summary.slice(0, 500),
    details: entry.details?.slice(0, 2000) ?? null,
    intent: intent.slice(0, 300),
    affected_files: filesJson,
    created_at: new Date().toISOString(),
  };
}

// â”€â”€ Query blueprint entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getBlueprintEntries(options: {
  userId: number;
  projectId?: number;
  limit?: number;
  categories?: BlueprintCategory[];
}): Promise<BlueprintEntry[]> {
  const db = await getAdapter();
  const conditions: string[] = ['user_id = ?'];
  const params: unknown[] = [options.userId];

  if (options.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(options.projectId);
  }

  if (options.categories?.length) {
    conditions.push(`category IN (${options.categories.map(() => '?').join(',')})`);
    params.push(...options.categories);
  }

  const sql = `
    SELECT * FROM blueprint_entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, turn_index DESC
    LIMIT ?
  `;
  params.push(options.limit ?? 20);

  return await db.all<BlueprintEntry>(sql, params);
}

// â”€â”€ Get compact context string for system prompt injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns a plain-text context block of recent blueprint entries for the given
 * user/project. Designed to be injected into the system prompt before each turn.
 *
 * The output is intentionally concise â€” 3-5 most recent entries with category
 * labels, summaries, and intents. This keeps token overhead low while giving
 * the AI full design memory continuity.
 */
export async function getBlueprintContext(options: {
  userId: number;
  projectId?: number;
  maxEntries?: number;
}): Promise<string> {
  const entries = await getBlueprintEntries({
    userId: options.userId,
    projectId: options.projectId,
    limit: options.maxEntries ?? 5,
  });

  if (entries.length === 0) return '';

  const sections = entries.map((e, i) => {
    const tag = e.category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const files = e.affected_files
      ? (JSON.parse(e.affected_files) as string[]).slice(0, 4).join(', ')
      : '';
    return (
      `[${i + 1}] ${tag}\n` +
      `    Intent: ${e.intent}\n` +
      `    Summary: ${e.summary}\n` +
      (files ? `    Files: ${files}\n` : '')
    );
  }).join('\n');

  return (
    '\n\n=== SUNy CODE CONSCIENCE â€” DESIGN MEMORY ===\n' +
    'The following entries record past design decisions and outcomes from this project.\n' +
    'Use them to maintain consistency with prior intent.\n\n' +
    sections +
    '\n=== END DESIGN MEMORY ==='
  );
}

// â”€â”€ Aggregate summaries (lightweight knowledge flywheel) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns a high-level "design trajectory" summary â€” the categories of decisions
 * made and how many entries each has. Gives the AI a sense of thematic focus.
 */
export async function getBlueprintSummary(options: {
  userId: number;
  projectId?: number;
}): Promise<string> {
  const db = await getAdapter();
  const conditions: string[] = ['user_id = ?'];
  const params: unknown[] = [options.userId];

  if (options.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(options.projectId);
  }

  const rows = await db.all<{ category: string; count: number }>(
    `SELECT category, COUNT(*) as count
    FROM blueprint_entries
    WHERE ${conditions.join(' AND ')}
    GROUP BY category
    ORDER BY count DESC`,
    params,
  );

  if (rows.length === 0) return '';

  const total = rows.reduce((s, r) => s + r.count, 0);
  const lines = rows.map(r => {
    const label = r.category.replace(/_/g, ' ');
    return `  ${label}: ${r.count}`;
  }).join('\n');

  return `\n[Blueprint memory contains ${total} entries â€” project design knowledge:\n${lines}]`;
}

// â”€â”€ Phase 2.2: Blueprint â†’ Behavioral Rule Pipeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Detect repeated patterns in blueprint memory and auto-generate behavioral rules.
 * When the same file is changed 3+ times for similar intent categories, extract a
 * rule that guides SUNy's future behavior with that file.
 */
export async function generateRulesFromPatterns(options: {
  userId: number;
  projectId: number | null;
}): Promise<{ generated: number; reason: string }> {
  const db = await getAdapter();
  const conditions: string[] = ['be.user_id = ?'];
  const params: unknown[] = [options.userId];

  if (options.projectId !== null) {
    conditions.push('be.project_id = ?');
    params.push(options.projectId);
  }

  // Find files that appear in 3+ blueprint entries
  const repeatedFiles = await db.all<{ affected_files: string; category: string; cnt: number }>(
    `SELECT be.affected_files, be.category, COUNT(*) as cnt
    FROM blueprint_entries be
    WHERE ${conditions.join(' AND ')} AND be.affected_files IS NOT NULL
    GROUP BY be.affected_files
    HAVING cnt >= 3
    ORDER BY cnt DESC
    LIMIT 10`,
    params,
  );

  let generated = 0;

  for (const row of repeatedFiles) {
    try {
      const files: string[] = JSON.parse(row.affected_files);
      const fileList = files.slice(0, 3).join(', ');
      const ruleText = `File "${fileList}" has been modified ${row.cnt} times in context of "${row.category}" â€” verify imports and dependents when touching it`;

      // Check if rule already exists
      const existing = await db.get<{ id: number }>(
        'SELECT id FROM behavioral_rules WHERE user_id = ? AND rule_text = ?',
        [options.userId, ruleText],
      );

      if (!existing) {
        await db.run(
          `INSERT INTO behavioral_rules (user_id, project_id, category, rule_text, trigger_context, source_score, confidence, application_count)
           VALUES (?, ?, 'neutral', ?, ?, 6, 0.6, 1)`,
          [options.userId, options.projectId, ruleText, `when working in this project (pattern detected from ${row.cnt} turns)`],
        );
        generated++;
        console.log(`[blueprintâ†’rule] Generated rule: ${ruleText.slice(0, 100)}`);
      }
    } catch { /* skip malformed entries */ }
  }

  return { generated, reason: generated > 0 ? `Generated ${generated} rule(s) from repeated file patterns` : 'No repeated patterns detected' };
}
