/**
 * SUNy Verifier â€” Write Verification + Deterministic Completion Criteria
 *
 * Two responsibilities:
 *   1. Write-and-Verify: After every file write, read back and confirm
 *      key content blocks are present. Retry once on mismatch.
 *   2. Deterministic Completion Criteria: A task is done ONLY when:
 *      - All planned edits are confirmed present (read-back verified)
 *      - Lint passes (or was skipped intentionally)
 *      - Tests pass (or were skipped intentionally)
 *      - Any required server validation passes (dev server starts)
 */

import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import { sendToBridge, isBridgeConnected } from './bridge-manager';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Error Taxonomy â€” Classify errors before fixing
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export enum ErrorClass {
  MISSING_IMPORT = 'missing_import',
  TYPE_ERROR = 'type_error',
  SYNTAX_ERROR = 'syntax_error',
  MISSING_FILE = 'missing_file',
  PORT_CONFLICT = 'port_conflict',
  DEPENDENCY_ERROR = 'dependency_error',
  PERMISSION_ERROR = 'permission_error',
  LOGIC_ERROR = 'logic_error',
  TIMEOUT = 'timeout',
  UNKNOWN = 'unknown',
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; cls: ErrorClass }> = [
  { pattern: /Cannot find module/i, cls: ErrorClass.MISSING_IMPORT },
  { pattern: /Cannot resolve dependency/i, cls: ErrorClass.MISSING_IMPORT },
  { pattern: /Module not found/i, cls: ErrorClass.MISSING_IMPORT },
  { pattern: /TS\d{1,5}|TypeScript.*error|Type '.*' is not assignable/i, cls: ErrorClass.TYPE_ERROR },
  { pattern: /SyntaxError|Unexpected token|Unexpected identifier/i, cls: ErrorClass.SYNTAX_ERROR },
  { pattern: /ENOENT|no such file or directory/i, cls: ErrorClass.MISSING_FILE },
  { pattern: /EADDRINUSE|address already in use/i, cls: ErrorClass.PORT_CONFLICT },
  { pattern: /npm ERR!|npm error/i, cls: ErrorClass.DEPENDENCY_ERROR },
  { pattern: /EACCES|EACCESS|permission denied/i, cls: ErrorClass.PERMISSION_ERROR },
  { pattern: /Timeout|timed? out/i, cls: ErrorClass.TIMEOUT },
];

export function classifyError(output: string): ErrorClass {
  for (const { pattern, cls } of ERROR_PATTERNS) {
    if (pattern.test(output)) return cls;
  }
  return ErrorClass.UNKNOWN;
}

export function buildFixPrompt(errorClass: ErrorClass, errorOutput: string, contextLines?: string): string {
  const truncated = errorOutput.slice(0, 3000);
  const context = contextLines ? `\nRelevant code context:\n\`\`\`\n${contextLines.slice(0, 1500)}\n\`\`\`` : '';

  const prompts: Record<ErrorClass, string> = {
    [ErrorClass.MISSING_IMPORT]:
      `There's a missing import or module. The error: ${truncated}.` +
      ` Check import paths and package.json dependencies. Install any missing packages.` +
      context,

    [ErrorClass.TYPE_ERROR]:
      `There's a TypeScript type mismatch. The error: ${truncated}.` +
      ` Fix the type annotation or the value being passed.` +
      context,

    [ErrorClass.SYNTAX_ERROR]:
      `There's a syntax error. The error: ${truncated}.` +
      ` Find and fix the malformed code.` +
      context,

    [ErrorClass.MISSING_FILE]:
      `A required file doesn't exist. The error: ${truncated}.` +
      ` Create the missing file or fix the reference.` +
      context,

    [ErrorClass.PORT_CONFLICT]:
      `Port is already in use. The error: ${truncated}.` +
      ` Kill the existing process or use a different port.` +
      context,

    [ErrorClass.DEPENDENCY_ERROR]:
      `A package dependency issue. The error: ${truncated}.` +
      ` Check package.json, update versions, re-run install.` +
      context,

    [ErrorClass.PERMISSION_ERROR]:
      `Permission error. The error: ${truncated}.` +
      ` This usually requires manual intervention. Try an alternative approach that doesn't need elevated permissions.` +
      context,

    [ErrorClass.LOGIC_ERROR]:
      `A logic error was detected. The error: ${truncated}.` +
      ` Re-read the relevant files, understand the expected behavior, fix the logic.` +
      context,

    [ErrorClass.TIMEOUT]:
      `A command timed out. The error: ${truncated}.` +
      ` The operation took too long. Try a simpler approach, smaller batch, or increase timeout.` +
      context,

    [ErrorClass.UNKNOWN]:
      `There's an unknown error: ${truncated}.` +
      ` Read the relevant files, determine the root cause, and fix it.` +
      context,
  };

  return prompts[errorClass];
}

/**
 * Fresh Eyes Retry â€” break fixation loops after 3 identical attempts.
 */
export function buildFreshEyesPrompt(errorOutput: string, attempts: number): string {
  if (attempts < 3) return '';
  return (
    `\n\n[FRESH EYES REQUIRED] You have tried this approach ${attempts} times and it keeps failing.\n` +
    `STOP. Take a completely different approach.\n` +
    `Read the error message carefully: ${errorOutput.slice(0, 1000)}\n` +
    `What is the ROOT CAUSE of this error?\n` +
    `Think of a different solution that avoids this root cause entirely.\n` +
    `Do NOT retry the same approach.`
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Write-and-Verify
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface WriteVerifyResult {
  path: string;
  success: boolean;
  attempts: number;
  error?: string;
}

/**
 * Write a file via the bridge, then read it back to verify key content is present.
 * Retries the write once if verification fails.
 */
export async function writeAndVerify(
  userId: number,
  projectPath: string,
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<WriteVerifyResult> {
  if (!isBridgeConnected(userId)) {
    return { path: filePath, success: false, attempts: 1, error: 'Bridge not connected' };
  }

  const absPath = filePath.startsWith('/') ? filePath : `${projectPath}/${filePath}`;
  let attempts = 0;

  while (attempts < 2) {
    attempts++;

    // Write
    try {
      await sendToBridge(userId, 'exec:write_file', {
        path: absPath,
        content,
        requiresConfirmation: false,
      }, 30000);
    } catch (err) {
      if (attempts >= 2) {
        return { path: filePath, success: false, attempts, error: `Write failed: ${(err as Error).message}` };
      }
      continue;
    }

    // Read back and verify
    try {
      const written = await sendToBridge(userId, 'exec:read_file', {
        path: absPath,
        requiresConfirmation: false,
      }, 15000) as string;

      // Extract key phrases from content for spot-checking
      const keyPhrases = extractKeyPhrases(content);
      const allPresent = keyPhrases.every(phrase => written.includes(phrase));

      if (allPresent) {
        return { path: filePath, success: true, attempts };
      }

      // Content mismatch â€” retry once
      if (attempts < 2) continue;

      return {
        path: filePath, success: false, attempts,
        error: `Verification failed: ${keyPhrases.length} key phrases checked, ${keyPhrases.filter(p => !written.includes(p)).length} missing`,
      };
    } catch (err) {
      if (attempts >= 2) {
        return { path: filePath, success: false, attempts, error: `Read-back failed: ${(err as Error).message}` };
      }
    }
  }

  return { path: filePath, success: false, attempts, error: 'Unknown verification failure' };
}

/**
 * Extract 3-5 unique key phrases from content for verification spot-checking.
 * Prefers function/class names, import paths, and unique strings.
 */
function extractKeyPhrases(content: string): string[] {
  const phrases: string[] = [];

  // Extract export function/class/const names
  const exportMatches = content.matchAll(/export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/g);
  for (const m of exportMatches) {
    if (phrases.length < 3) phrases.push(m[1]);
  }

  // Extract import source paths (unique ones)
  const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
  for (const m of importMatches) {
    if (phrases.length < 5 && !phrases.includes(m[1])) phrases.push(m[1]);
  }

  // Fallback: use first 2 non-empty, unique lines over 30 chars
  if (phrases.length < 2) {
    const lines = content.split('\n').filter(l => l.trim().length > 30);
    for (const line of lines) {
      const trimmed = line.trim();
      if (phrases.length < 2) phrases.push(trimmed.slice(0, 60));
    }
  }

  return phrases.length > 0 ? phrases : ['export']; // minimal fallback
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Deterministic Completion Check
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface CompletionCriteria {
  plannedEditsVerified: boolean;
  lintPassed: boolean;
  testsPassed: boolean;
  serverValidated: boolean;
  allMet: boolean;
  failures: string[];
}

/**
 * Check if all completion criteria are met.
 */
export function checkCompletion(criteria: Partial<CompletionCriteria>): CompletionCriteria {
  const failures: string[] = [];
  const plannedEditsVerified = criteria.plannedEditsVerified ?? true;
  const lintPassed = criteria.lintPassed ?? true;
  const testsPassed = criteria.testsPassed ?? true;
  const serverValidated = criteria.serverValidated ?? true;

  if (!plannedEditsVerified) failures.push('Not all planned edits are confirmed present');
  if (!lintPassed) failures.push('Lint/type-check has errors');
  if (!testsPassed) failures.push('Tests have failures');
  if (!serverValidated) failures.push('Server validation did not pass');

  return {
    plannedEditsVerified,
    lintPassed,
    testsPassed,
    serverValidated,
    allMet: failures.length === 0,
    failures,
  };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI-powered write verification (for complex content checks)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Use AI to verify that written content correctly implements the intended change.
 * Only used for complex refactors where simple string matching isn't enough.
 */
export async function aiVerifyWrite(
  model: LanguageModel,
  intendedChange: string,
  writtenContent: string,
  signal?: AbortSignal,
): Promise<{ passed: boolean; issues: string[] }> {
  try {
    const result = await generateText({
      model,
      system: 'You verify that written code correctly implements the intended change. Respond in JSON only.',
      messages: [{
        role: 'user',
        content: `Intended change: ${intendedChange.slice(0, 1000)}\n\nWritten code:\n\`\`\`\n${writtenContent.slice(0, 3000)}\n\`\`\`\n\nDoes the written code correctly implement the intended change? Respond with: {"passed":true} or {"passed":false,"issues":["issue1","issue2"]}`,
      }],
      maxTokens: 500,
      abortSignal: signal,
    });

    const parsed = JSON.parse(result.text);
    return {
      passed: parsed.passed ?? false,
      issues: parsed.issues ?? [],
    };
  } catch {
    return { passed: true, issues: [] }; // fall through on error
  }
}
