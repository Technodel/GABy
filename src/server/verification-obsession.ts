/**
 * SUNy Verification Obsession â€” Phase 4
 *
 * SUNy is obsessed with verifying its own work before calling it done.
 * Three sub-systems:
 *
 * 4.1 SILENT CODE REVIEW PASS â€” After each set of file changes, SUNy reviews
 *     its own diff like a senior engineer, checking for:
 *     - Security issues (secrets, injection, unsafe ops)
 *     - Obvious bugs (null refs, type mismatches, logic holes)
 *     - Code quality (missed edge cases, inconsistent patterns)
 *     The review is silent â€” only injected into the system prompt so SUNy
 *     can self-correct before responding to the user.
 *
 * 4.2 POST-MERGE VALIDATION â€” After file writes, checks if the project
 *     still compiles (tsc --noEmit), if tests pass, and warns about
 *     dev server crashes.
 *
 * 4.3 INTERACTION PATTERN ANALYZER â€” Spot repeated error patterns across
 *     turns: same lint error 3+ times, same kind of revert, same
 *     verification skip. Feeds insights back into behavioral rules.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAdapter } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface CodeReviewIssue {
  severity: 'critical' | 'warning' | 'info';
  file: string;
  line?: number;
  category: 'security' | 'bug' | 'quality' | 'pattern';
  message: string;
  suggestion: string;
}

export interface CodeReviewResult {
  issues: CodeReviewIssue[];
  summary: string;
  filesReviewed: number;
  totalIssues: number;
}

export interface ValidationResult {
  typeCheckPassed: boolean;
  typeCheckErrors: number;
  testsPassed: boolean | null; // null = no tests found
  testFailures: number;
  devServerCrash: boolean;
  crashOutput: string;
}

export interface InteractionPattern {
  pattern: string;
  category: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  suggestion: string;
}

// â”€â”€ 4.1: Silent Code Review Pass â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SECURITY_PATTERNS: Array<{ pattern: RegExp; message: string; suggestion: string }> = [
  {
    pattern: /(api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i,
    message: 'Hardcoded API key or secret detected',
    suggestion: 'Move to environment variables (.env) and reference via process.env',
  },
  {
    pattern: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/i,
    message: 'Hardcoded password detected',
    suggestion: 'Use environment variables or a secrets manager',
  },
  {
    pattern: /\.innerHTML\s*=\s*|dangerouslySetInnerHTML/i,
    message: 'Potential XSS via innerHTML or dangerouslySetInnerHTML',
    suggestion: 'Sanitize input before rendering, or use safe alternatives like textContent',
  },
  {
    pattern: /\beval\s*\(/i,
    message: 'eval() usage detected â€” security risk',
    suggestion: 'Avoid eval(); use JSON.parse() for data or Function constructor only if necessary',
  },
  {
    pattern: /\bexec\s*\(\s*['"][^'"]*\$\{[^}]+\}/,
    message: 'Shell injection risk â€” template literal in exec()',
    suggestion: 'Use child_process.spawn() with argument arrays instead of exec() with string interpolation',
  },
  {
    pattern: /(\bINSERT\b|\bUPDATE\b|\bDELETE\b).*\$\{/i,
    message: 'Potential SQL injection â€” template literal in SQL query',
    suggestion: 'Use parameterized queries (?) instead of string interpolation',
  },
];

const BUG_PATTERNS: Array<{ pattern: RegExp; message: string; suggestion: string }> = [
  {
    pattern: /\bif\s*\(\s*\w+\s*\)\s*\{\s*\}\s*else\s*\{\s*\w+\./,
    message: 'Possible null reference â€” accessing property after checking truthiness without null guard',
    suggestion: 'Use optional chaining (?.) or explicit null check',
  },
  {
    pattern: /\.map\s*\([^)]*\)\s*\.(?!filter|join|reduce|flat)/,
    message: '.map() without using the return value â€” may be a missing assignment',
    suggestion: 'Assign .map() result to a variable or use .forEach() if no return is needed',
  },
  {
    pattern: /\bawait\s+\w+\s*\(\s*\)\s*[;,]\s*$|\.then\s*\(/i,
    message: 'Mixed await and .then() patterns â€” inconsistent async style',
    suggestion: 'Stick to one async pattern (prefer async/await) for consistency',
  },
  {
    pattern: /\btry\s*\{[^}]*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/,
    message: 'Empty catch block â€” error is silently swallowed',
    suggestion: 'At minimum, log the error or add a comment explaining why it is safe to ignore',
  },
  {
    pattern: /console\.(log|warn|error|debug)\s*\([^)]*\)/,
    message: 'Console statement left in production code',
    suggestion: 'Remove debug console statements or gate them behind a debug flag',
  },
  {
    pattern: /TODO|FIXME|HACK|XXX/i,
    message: 'TODO/FIXME/HACK comment found â€” may indicate unfinished work',
    suggestion: 'Address the TODO or create a tracking issue before merging',
  },
];

/**
 * Perform a static-analysis code review on changed files.
 * This is a fast, rule-based pass that catches obvious issues without an LLM call.
 */
export function silentCodeReview(
  projectPath: string,
  changedFiles: string[],
): CodeReviewResult {
  const issues: CodeReviewIssue[] = [];

  for (const file of changedFiles) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;

    const fullPath = path.join(projectPath, file);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    // Security scan
    for (const rule of SECURITY_PATTERNS) {
      let lineNum = 0;
      for (const line of lines) {
        lineNum++;
        if (rule.pattern.test(line)) {
          issues.push({
            severity: 'critical',
            file,
            line: lineNum,
            category: 'security',
            message: rule.message,
            suggestion: rule.suggestion,
          });
        }
      }
    }

    // Bug scan
    for (const rule of BUG_PATTERNS) {
      let lineNum = 0;
      for (const line of lines) {
        lineNum++;
        if (rule.pattern.test(line)) {
          issues.push({
            severity: rule.message.includes('TODO') ? 'info' : 'warning',
            file,
            line: lineNum,
            category: rule.message.includes('TODO') ? 'quality' : 'bug',
            message: rule.message,
            suggestion: rule.suggestion,
          });
        }
      }
    }
  }

  const criticals = issues.filter(i => i.severity === 'critical').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const summary =
    issues.length === 0
      ? 'No issues found. Code looks clean.'
      : `${criticals} critical, ${warnings} warning(s), ${issues.length - criticals - warnings} info(s) across ${issues.length} findings`;

  return {
    issues,
    summary,
    filesReviewed: changedFiles.filter(f => /\.(ts|tsx|js|jsx)$/.test(f)).length,
    totalIssues: issues.length,
  };
}

/**
 * Format the review result for system prompt injection (silent review).
 */
export function formatCodeReviewForPrompt(review: CodeReviewResult): string {
  if (review.totalIssues === 0) return '';

  const lines: string[] = [
    '',
    '=== POST-EDIT CODE REVIEW (silent â€” fix before responding) ===',
    `Reviewed ${review.filesReviewed} file(s). ${review.summary}`,
    '',
  ];

  const byFile = new Map<string, CodeReviewIssue[]>();
  for (const issue of review.issues) {
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file)!.push(issue);
  }

  byFile.forEach((fileIssues, file) => {
    lines.push(`  ${file}:`);
    for (const issue of fileIssues) {
      const icon = issue.severity === 'critical' ? 'ðŸ”´' : issue.severity === 'warning' ? 'ðŸŸ¡' : 'ðŸ”µ';
      const loc = issue.line ? `:${issue.line}` : '';
      lines.push(`    ${icon} [${issue.category}] ${issue.message}${loc}`);
      lines.push(`       Fix: ${issue.suggestion}`);
    }
  });

  lines.push('');
  lines.push('Fix all ðŸ”´ critical issues before responding to the user.');
  lines.push('Fix ðŸŸ¡ warnings if they are fast; otherwise acknowledge them.');
  lines.push('=== END CODE REVIEW ===');

  return lines.join('\n');
}

// â”€â”€ 4.2: Post-Merge Validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Run a lightweight post-merge validation: TypeScript compilation check.
 * Best-effort â€” does not block the main flow.
 */
export async function postMergeValidation(projectPath: string): Promise<ValidationResult> {
  const result: ValidationResult = {
    typeCheckPassed: true,
    typeCheckErrors: 0,
    testsPassed: null,
    testFailures: 0,
    devServerCrash: false,
    crashOutput: '',
  };

  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  // Check if tsconfig.json exists â€” if so, run tsc --noEmit
  const tsconfigPath = path.join(projectPath, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    try {
      await execAsync('npx tsc --noEmit --pretty false 2>&1', {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 30000,
      });
      // Success â€” no type errors
    } catch (err: any) {
      const output = err.stdout || err.stderr || err.message || '';
      const errorLines = output.split('\n').filter((l: string) => l.includes('error TS'));
      result.typeCheckPassed = false;
      result.typeCheckErrors = errorLines.length;
      result.crashOutput = errorLines.slice(0, 5).join('\n');
    }
  }

  // Quick test check â€” look for vitest/jest config and recent test output
  try {
    const hasVitest = fs.existsSync(path.join(projectPath, 'vitest.config.ts')) ||
      fs.existsSync(path.join(projectPath, 'vitest.config.js'));
    const hasJest = fs.existsSync(path.join(projectPath, 'jest.config.ts')) ||
      fs.existsSync(path.join(projectPath, 'jest.config.js')) ||
      fs.existsSync(path.join(projectPath, 'package.json'));

    if (hasVitest) {
      try {
        await execAsync('npx vitest run --reporter=json 2>&1', {
          cwd: projectPath,
          encoding: 'utf-8',
          timeout: 60000,
        });
        result.testsPassed = true;
      } catch (err: any) {
        const output = err.stdout || err.stderr || err.message || '';
        const failMatch = output.match(/(\d+)\s+failed/i);
        result.testsPassed = failMatch ? false : null;
        result.testFailures = failMatch ? parseInt(failMatch[1], 10) : 0;
      }
    } else if (hasJest) {
      try {
        await execAsync('npx jest --json --passWithNoTests 2>&1', {
          cwd: projectPath,
          encoding: 'utf-8',
          timeout: 60000,
        });
        result.testsPassed = true;
      } catch (err: any) {
        result.testsPassed = false;
        result.testFailures = 1;
      }
    }
  } catch {
    // Test validation is best-effort
  }

  // Check for dev server crash indicators
  try {
    const logFiles = ['server.log', 'dev.log', '.next/error.log', 'npm-debug.log'];
    for (const logFile of logFiles) {
      const logPath = path.join(projectPath, logFile);
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf-8').slice(-2000);
        if (/\b(crash|fatal|EADDRINUSE|ECONNREFUSED|uncaughtException)\b/i.test(content)) {
          result.devServerCrash = true;
          result.crashOutput = content.slice(-500);
          break;
        }
      }
    }
  } catch {
    // Log check is best-effort
  }

  return result;
}

/**
 * Format validation result for system prompt injection.
 */
export function formatValidationForPrompt(validation: ValidationResult): string {
  const lines: string[] = ['', '=== POST-MERGE VALIDATION ==='];

  if (validation.typeCheckPassed) {
    lines.push('âœ… TypeScript compilation: PASSED');
  } else {
    lines.push(`âŒ TypeScript compilation: ${validation.typeCheckErrors} error(s)`);
    if (validation.crashOutput) {
      lines.push(`   ${validation.crashOutput.split('\n').slice(0, 3).join('\n   ')}`);
    }
  }

  if (validation.testsPassed === true) {
    lines.push('âœ… Tests: PASSED');
  } else if (validation.testsPassed === false) {
    lines.push(`âŒ Tests: ${validation.testFailures} failure(s)`);
  }

  if (validation.devServerCrash) {
    lines.push('âš ï¸ Dev server may have crashed â€” check logs');
  }

  lines.push('=== END VALIDATION ===');
  return lines.join('\n');
}

// â”€â”€ 4.3: Interaction Pattern Analyzer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface InteractionRecord {
  id: number;
  userId: number;
  turnId: string;
  eventType: string;   // 'lint_error' | 'test_failure' | 'revert' | 'loop' | 'question'
  detail: string;      // e.g., "missing-semicolon" or "null-reference"
  file?: string;
  timestamp: string;
}

/**
 * Initialize the interaction patterns table.
 */
export async function initializeInteractionPatternsTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT DEFAULT '',
      file TEXT DEFAULT '',
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_interaction_patterns_user ON interaction_patterns(user_id);
    CREATE INDEX IF NOT EXISTS idx_interaction_patterns_type ON interaction_patterns(event_type);
  `);
}

/**
 * Record an interaction event for pattern analysis.
 */
export async function recordInteraction(
  userId: number,
  turnId: string,
  eventType: string,
  detail: string,
  file?: string,
): Promise<void> {
  const db = await getAdapter();
  await db.run(
    'INSERT INTO interaction_patterns (user_id, turn_id, event_type, detail, file) VALUES (?, ?, ?, ?, ?)',
    [userId, turnId, eventType, detail, file || ''],
  );
}

/**
 * Analyze interaction patterns looking for repeated issues.
 * Returns patterns that have occurred 3+ times recently.
 */
export async function analyzeInteractionPatterns(userId: number): Promise<InteractionPattern[]> {
  const db = await getAdapter();

  // Find events that repeat 3+ times
  const rows = await db.all<Array<{ event_type: string; detail: string; cnt: number; first_seen: string; last_seen: string }>>(`
    SELECT event_type, detail, COUNT(*) as cnt, MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
    FROM interaction_patterns
    WHERE user_id = ?
    GROUP BY event_type, detail
    HAVING cnt >= 3
    ORDER BY cnt DESC
    LIMIT 10
  `, [userId]);

  return rows.map(row => ({
    pattern: `${row.event_type}: ${row.detail}`,
    category: row.event_type,
    count: row.cnt,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    suggestion: generatePatternSuggestion(row.event_type, row.detail, row.cnt),
  }));
}

function generatePatternSuggestion(eventType: string, detail: string, count: number): string {
  if (eventType === 'lint_error') {
    return `You've hit "${detail}" ${count} times. Consider adding a pre-write lint check or adjusting your code style for this pattern.`;
  }
  if (eventType === 'test_failure') {
    return `Tests fail with "${detail}" repeatedly (${count}x). Review your test assumptions or add a pre-commit test run.`;
  }
  if (eventType === 'revert') {
    return `You've reverted changes for "${detail}" ${count} times. Consider planning the approach more carefully before editing.`;
  }
  if (eventType === 'loop') {
    return `You entered a correction loop for "${detail}" ${count} times. The auto-fix strategy may need adjustment.`;
  }
  return `Pattern "${detail}" repeated ${count} times. Review if a systematic fix is needed.`;
}

/**
 * Format interaction pattern analysis for system prompt injection.
 */
export function formatPatternAnalysisForPrompt(patterns: InteractionPattern[]): string {
  if (patterns.length === 0) return '';

  const lines: string[] = [
    '',
    '=== INTERACTION PATTERN ANALYSIS ===',
    'These patterns have repeated across your recent tasks. Learn from them.',
    '',
  ];

  for (const p of patterns) {
    lines.push(`  ðŸ” ${p.pattern} (${p.count}x since ${p.firstSeen.slice(0, 10)})`);
    lines.push(`     ${p.suggestion}`);
    lines.push('');
  }

  lines.push('=== END PATTERN ANALYSIS ===');
  return lines.join('\n');
}
