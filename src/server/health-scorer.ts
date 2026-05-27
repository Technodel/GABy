/**
 * Codebase Health Scorer
 *
 * After each agent session, computes a lightweight health delta for every
 * file the agent touched and writes a row to codebase_health_log.
 *
 * Health score (0–100):
 *   - Starts at 70 (neutral)
 *   - +10 if test files were touched alongside code files (coverage intent)
 *   - -10 if only code files were touched (no test pairing)
 *   - -1 per "complex function" heuristic (functions > 40 lines in changed files)
 *   - +5 if lint passed clean
 *   - -10 if lint found errors
 *   - +5 if all tests passed
 *   - -10 if tests failed
 *   Clamped to [0, 100].
 *
 * The delta vs. the previous session's score is the "AI debt flag".
 */

import { getDb } from './db';
import * as fs from 'fs';
import * as path from 'path';

interface HealthInput {
  userId: number;
  projectId: number;
  sessionId: string;
  changedFiles: string[];
  lintPassed: boolean;
  lintErrorsFound: number;
  testPassed: boolean;
  testFailuresFound: number;
  testRuns: number;
  projectPath?: string;
}

export interface HealthLogRow {
  id: number;
  user_id: number;
  project_id: number;
  session_id: string;
  score: number;
  delta: number;
  files_changed: number;
  test_coverage_flag: number; // 1 = tests touched, 0 = not, -1 = no tests ever
  lint_passed: number;
  test_passed: number;
  complex_functions_found: number;
  created_at: string;
}

export function initializeHealthTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS codebase_health_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      delta INTEGER NOT NULL DEFAULT 0,
      files_changed INTEGER NOT NULL DEFAULT 0,
      test_coverage_flag INTEGER NOT NULL DEFAULT 0,
      lint_passed INTEGER NOT NULL DEFAULT 0,
      test_passed INTEGER NOT NULL DEFAULT 0,
      complex_functions_found INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_health_project ON codebase_health_log(project_id, created_at DESC);
  `);
}

function countComplexFunctions(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    // Heuristic: count function/method blocks longer than 40 lines
    let complexCount = 0;
    let inFunctionDepth = 0;
    let functionStartLine = -1;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isFunctionLine = /\b(function|=>|\bdef\b|\bfunc\b)\b/.test(line) && line.includes('{');
      if (isFunctionLine && braceDepth === 0) {
        functionStartLine = i;
        inFunctionDepth = 1;
      }
      if (functionStartLine >= 0) {
        for (const ch of line) {
          if (ch === '{') inFunctionDepth++;
          if (ch === '}') inFunctionDepth--;
        }
        if (inFunctionDepth <= 0) {
          const length = i - functionStartLine;
          if (length > 40) complexCount++;
          functionStartLine = -1;
          inFunctionDepth = 0;
        }
      }
      // Track overall brace depth for top-level detection
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      }
    }
    return complexCount;
  } catch {
    return 0;
  }
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.php', '.rb', '.swift']);
const TEST_PATTERNS = [/\.test\.\w+$/, /\.spec\.\w+$/, /__tests__/, /\/tests?\//i];

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some(p => p.test(filePath));
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function recordHealthScore(input: HealthInput): Promise<{ score: number; delta: number }> {
  const db = getDb();

  const codeFiles = input.changedFiles.filter(f => isCodeFile(f) && !isTestFile(f));
  const testFiles = input.changedFiles.filter(f => isTestFile(f));

  // Test coverage flag
  let testCoverageFlag = 0;
  if (codeFiles.length > 0 && testFiles.length > 0) testCoverageFlag = 1;
  else if (codeFiles.length > 0 && testFiles.length === 0) testCoverageFlag = -1;

  // Count complex functions in changed code files
  let complexFunctions = 0;
  if (input.projectPath) {
    for (const f of codeFiles.slice(0, 20)) { // cap at 20 files for perf
      const absPath = path.isAbsolute(f) ? f : path.join(input.projectPath, f);
      complexFunctions += countComplexFunctions(absPath);
    }
  }

  // Compute raw score
  let score = 70;
  if (testCoverageFlag === 1) score += 10;
  if (testCoverageFlag === -1) score -= 10;
  score -= Math.min(complexFunctions, 15); // cap penalty at -15
  if (input.lintPassed) score += 5;
  if (input.lintErrorsFound > 0) score -= 10;
  if (input.testRuns > 0 && input.testPassed) score += 5;
  if (input.testRuns > 0 && input.testFailuresFound > 0) score -= 10;
  score = Math.max(0, Math.min(100, score));

  // Get previous score for this project
  const prev = db.prepare(
    'SELECT score FROM codebase_health_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(input.projectId) as { score: number } | undefined;

  const delta = prev ? score - prev.score : 0;

  db.prepare(`
    INSERT INTO codebase_health_log
      (user_id, project_id, session_id, score, delta, files_changed, test_coverage_flag, lint_passed, test_passed, complex_functions_found)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.userId,
    input.projectId,
    input.sessionId,
    score,
    delta,
    input.changedFiles.length,
    testCoverageFlag,
    input.lintPassed ? 1 : 0,
    input.testPassed ? 1 : 0,
    complexFunctions,
  );

  return { score, delta };
}

export function getHealthHistory(projectId: number, limit = 20): HealthLogRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM codebase_health_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(projectId, limit) as HealthLogRow[];
}

export function getLatestHealthScore(projectId: number): HealthLogRow | null {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM codebase_health_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(projectId) as HealthLogRow | null;
}
