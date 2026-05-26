/**
 * SUNy Test Runner â€” runs the project's test suite after code edits,
 * returning structured results so agent-loop.ts can feed failures back to the AI.
 *
 * Design goals (beyond Aider):
 *   - Smart command detection for all major ecosystems
 *   - Focused failure extraction: returns only failing test names + error snippets,
 *     not the full verbose output (saves tokens, improves fix accuracy)
 *   - Scope narrowing: on retry passes, re-run ONLY the failing tests instead of
 *     the full suite (faster, cheaper, more focused context)
 *   - Structured FailedTest[] so the agent loop can build precise fix prompts
 *   - Progressive fix prompts that escalate in depth on each retry pass
 *
 * Detection priority:
 *   package.json scripts["test"]   â†’ npm test (unless it's echo/exit)
 *   vitest in deps                 â†’ npx vitest run
 *   jest in deps                   â†’ npx jest
 *   mocha in deps                  â†’ npx mocha
 *   bun.lockb present              â†’ bun test
 *   Cargo.toml                     â†’ cargo test
 *   go.mod                         â†’ go test ./...
 *   pyproject.toml (pytest)        â†’ python -m pytest
 *   requirements.txt + tests/      â†’ python -m pytest
 *   None found                     â†’ skip (return null)
 */

import { sendToBridge, isBridgeConnected } from './bridge-manager';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface FailedTest {
  /** Human-readable test name */
  name: string;
  /** Trimmed error/assertion snippet (â‰¤ 800 chars) */
  errorSnippet: string;
  /** File path of the test if parseable */
  file?: string;
  /** Command fragment to re-run ONLY this test */
  narrowCmd?: string;
}

export interface TestResult {
  /** true = all tests passed */
  passed: boolean;
  /** Raw full output */
  output: string;
  /** Total failing test count */
  failCount: number;
  /** Structured list of failing tests with error snippets */
  failedTests: FailedTest[];
  /** The command that was run */
  command: string;
  /** Framework detected */
  framework: string;
  /** Command to re-run only failing tests (null if can't narrow) */
  narrowCommand: string | null;
}

interface DetectedSuite {
  cmd: string;
  label: string;
  framework: 'jest' | 'vitest' | 'pytest' | 'cargo' | 'go' | 'mocha' | 'generic';
  cwd?: string;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Detection cache (per project, 5 min TTL)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const suiteCache = new Map<string, { suite: DetectedSuite | null; at: number }>();
const CACHE_TTL = 5 * 60_000;

export function clearTestCache(projectPath: string): void {
  suiteCache.delete(projectPath);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public API
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Run the full test suite for the project.
 * Returns null if no test runner is detected or bridge is offline.
 */
export async function runTests(
  userId: number,
  projectPath: string,
  signal?: AbortSignal,
): Promise<TestResult | null> {
  if (!isBridgeConnected(userId)) return null;

  const suite = await detectSuite(userId, projectPath);
  if (!suite) return null;

  const cwd = suite.cwd ?? projectPath;
  console.log(`[test-runner] running: ${suite.cmd} (cwd: ${cwd})`);

  const raw = await execShell(userId, suite.cmd, cwd, 180_000);
  return parseOutput(raw, suite);
}

/**
 * Re-run only the failing tests from a previous TestResult.
 * Falls back to running the full suite if no narrowCommand is available.
 */
export async function runFailingTests(
  userId: number,
  projectPath: string,
  previous: TestResult,
): Promise<TestResult | null> {
  if (!isBridgeConnected(userId)) return null;

  const suite = await detectSuite(userId, projectPath);
  if (!suite) return null;

  const cwd = suite.cwd ?? projectPath;
  const cmd = previous.narrowCommand ?? suite.cmd;

  console.log(`[test-runner] re-running failing tests: ${cmd}`);

  const raw = await execShell(userId, cmd, cwd, 180_000);
  const result = parseOutput(raw, suite);
  // Re-narrow command for the NEXT potential retry
  result.narrowCommand = buildNarrowCommand(suite, result.failedTests);
  return result;
}

/**
 * Build a focused AI correction prompt from a TestResult.
 * pass = 1-based retry attempt. Prompt escalates in depth on each pass.
 */
export function buildTestFixPrompt(result: TestResult, pass: number): string {
  const failList = result.failedTests
    .slice(0, 12)
    .map((t, i) =>
      `${i + 1}. **${t.name}**${t.file ? ` (${t.file})` : ''}\n\`\`\`\n${t.errorSnippet || '(no details)'}\n\`\`\``,
    )
    .join('\n\n');

  const header =
    `${result.failCount} test(s) are still failing (attempt ${pass}).\n\n` +
    (failList || result.output.slice(0, 3000));

  if (pass === 1) {
    return (
      header +
      '\n\nFix ALL failing tests above. Do not ask for permission â€” just fix them.\n' +
      'Read the relevant source files if you need context before editing.'
    );
  }

  if (pass === 2) {
    return (
      header +
      '\n\nYour previous fix did not resolve all failures. Before editing:\n' +
      '  1. Use file_read to re-read every source file referenced in the errors above.\n' +
      '  2. Use file_read to re-read the failing test files to understand the exact expectations.\n' +
      '  3. Try a completely different approach if your first attempt did not work.\n' +
      'Fix ALL remaining failures.'
    );
  }

  // pass 3+: full step-back
  return (
    header +
    '\n\nMultiple fix attempts have failed. Step back completely:\n' +
    '  1. Re-read ALL changed files and the failing test files from scratch.\n' +
    '  2. Identify the root cause â€” do NOT assume your previous diagnosis was correct.\n' +
    '  3. If the test expectations are wrong, fix the tests. If the implementation is wrong, fix it.\n' +
    '  4. Fix the root cause, not the symptom.\n' +
    'This is a critical pass â€” get it right.'
  );
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Detection
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function detectSuite(userId: number, projectPath: string): Promise<DetectedSuite | null> {
  const cached = suiteCache.get(projectPath);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.suite;

  let suite: DetectedSuite | null = null;
  try { suite = await doDetect(userId, projectPath); } catch { suite = null; }

  suiteCache.set(projectPath, { suite, at: Date.now() });
  return suite;
}

async function doDetect(userId: number, projectPath: string): Promise<DetectedSuite | null> {
  // â”€â”€ Node/JS/TS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const pkgRaw = await readFileSafe(userId, `${projectPath}/package.json`);
  if (pkgRaw) {
    let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> } = {};
    try { pkg = JSON.parse(pkgRaw); } catch { /* ignore */ }

    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    const testScript = scripts['test'] ?? '';
    const isPlaceholder = !testScript || /echo|exit 1|no test/i.test(testScript);

    if (!isPlaceholder) {
      const fw = testScript.includes('vitest') ? 'vitest'
        : testScript.includes('jest') ? 'jest'
        : testScript.includes('mocha') ? 'mocha'
        : 'generic';
      return { cmd: 'npm test -- --reporter=verbose 2>&1', label: 'npm test', framework: fw };
    }
    if (deps['vitest']) {
      return { cmd: 'npx vitest run --reporter=verbose 2>&1', label: 'Vitest', framework: 'vitest' };
    }
    if (deps['jest'] || deps['@jest/core']) {
      return { cmd: 'npx jest --no-coverage 2>&1', label: 'Jest', framework: 'jest' };
    }
    if (deps['mocha']) {
      return { cmd: 'npx mocha 2>&1', label: 'Mocha', framework: 'mocha' };
    }
    const hasBunLock = await fileExists(userId, `${projectPath}/bun.lockb`);
    if (hasBunLock) {
      return { cmd: 'bun test 2>&1', label: 'Bun test', framework: 'generic' };
    }
    return null;
  }

  // â”€â”€ Rust â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (await fileExists(userId, `${projectPath}/Cargo.toml`)) {
    return { cmd: 'cargo test 2>&1', label: 'cargo test', framework: 'cargo' };
  }

  // â”€â”€ Go â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (await fileExists(userId, `${projectPath}/go.mod`)) {
    return { cmd: 'go test ./... -v 2>&1', label: 'go test', framework: 'go' };
  }

  // â”€â”€ Python â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const pyProjectRaw = await readFileSafe(userId, `${projectPath}/pyproject.toml`);
  if (pyProjectRaw && /pytest/.test(pyProjectRaw)) {
    return { cmd: 'python -m pytest -v 2>&1', label: 'pytest', framework: 'pytest' };
  }
  if (await fileExists(userId, `${projectPath}/requirements.txt`)) {
    const hasTests = await fileExists(userId, `${projectPath}/tests`) ||
      await fileExists(userId, `${projectPath}/test`);
    if (hasTests) return { cmd: 'python -m pytest -v 2>&1', label: 'pytest', framework: 'pytest' };
  }

  return null;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Output parsing â€” structured failure extraction
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseOutput(raw: string, suite: DetectedSuite): TestResult {
  const output = raw.trim();
  let failedTests: FailedTest[] = [];

  switch (suite.framework) {
    case 'jest':
    case 'vitest':  failedTests = parseJestVitest(output); break;
    case 'pytest':  failedTests = parsePytest(output); break;
    case 'cargo':   failedTests = parseCargo(output); break;
    case 'go':      failedTests = parseGo(output); break;
    default:        failedTests = parseGeneric(output); break;
  }

  const failCount = failedTests.length || countGenericFailures(output);
  const passed = failCount === 0 && !hasAnyFailure(output);

  return {
    passed,
    output,
    failCount,
    failedTests,
    command: suite.cmd,
    framework: suite.framework,
    narrowCommand: buildNarrowCommand(suite, failedTests),
  };
}

function hasAnyFailure(output: string): boolean {
  return /\bfail(ed|ing|ure)?\b/i.test(output) ||
    /\d+\s+fail/i.test(output) ||
    /\bERROR\b/.test(output) ||
    /FAILED/i.test(output);
}

function countGenericFailures(output: string): number {
  if (!hasAnyFailure(output)) return 0;
  const m = output.match(/(\d+)\s+fail/i);
  if (m) return parseInt(m[1], 10);
  return (output.match(/\bFAIL(ED)?\b/gi) ?? []).length || 1;
}

function parseJestVitest(output: string): FailedTest[] {
  const tests: FailedTest[] = [];

  // Jest: "â— DescribeBlock > test name\n  error..."
  const jestBlockRe = /â—\s+(.+?)\n([\s\S]+?)(?=\nâ—|\nâ”€+|\nTest Suites:|$)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = jestBlockRe.exec(output)) !== null) {
    const name = m[1].trim();
    const errorSnippet = m[2].split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('at '))
      .slice(0, 12).join('\n').trim().slice(0, 800);
    tests.push({ name, errorSnippet });
  }

  if (tests.length > 0) {
    // Attach file paths from FAIL lines
    const failFileRe = /FAIL\s+([\w./\\-]+\.(test|spec)\.[tj]sx?)/g;
    // eslint-disable-next-line no-cond-assign
    while ((m = failFileRe.exec(output)) !== null) {
      for (const t of tests) { if (!t.file) t.file = m[1]; }
    }
    return tests;
  }

  // Vitest: "Ã— test name"
  const vitestRe = /[Ã—âœ•]\s+(.+)/g;
  // eslint-disable-next-line no-cond-assign
  while ((m = vitestRe.exec(output)) !== null) {
    tests.push({ name: m[1].trim(), errorSnippet: '' });
  }
  return tests;
}

function parsePytest(output: string): FailedTest[] {
  const tests: FailedTest[] = [];
  const failRe = /FAILED\s+([\w/\\.-]+)::([\w:]+)\s*-?\s*(.*)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = failRe.exec(output)) !== null) {
    const file = m[1];
    const name = m[2];
    const blockRe = new RegExp(`_{3,}\\s+${escapeRegex(name)}\\s+_{3,}([\\s\\S]+?)(?=_{3,}|=====|$)`, 'i');
    const blockM = blockRe.exec(output);
    const errorSnippet = blockM ? blockM[1].trim().slice(0, 800) : m[3].trim().slice(0, 800);
    const narrowCmd = `python -m pytest "${file}::${name}" -v 2>&1`;
    tests.push({ name, file, errorSnippet, narrowCmd });
  }
  return tests;
}

function parseCargo(output: string): FailedTest[] {
  const tests: FailedTest[] = [];
  const failRe = /test\s+([\w:]+)\s+\.\.\.\s+FAILED/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = failRe.exec(output)) !== null) {
    const name = m[1];
    const panicRe = new RegExp(`---- ${escapeRegex(name)} stdout ----([\\s\\S]+?)(?=---- |test result|$)`, 'i');
    const panicM = panicRe.exec(output);
    const errorSnippet = panicM ? panicM[1].trim().slice(0, 800) : '';
    tests.push({ name, errorSnippet, narrowCmd: `cargo test "${name}" 2>&1` });
  }
  return tests;
}

function parseGo(output: string): FailedTest[] {
  const tests: FailedTest[] = [];
  const failRe = /--- FAIL:\s+([\w/]+)\s+\([\d.]+s\)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = failRe.exec(output)) !== null) {
    const name = m[1];
    const upTo = output.indexOf(m[0]);
    const errorSnippet = output.slice(Math.max(0, upTo - 600), upTo)
      .trim().split('\n').slice(-10).join('\n').trim();
    tests.push({ name, errorSnippet, narrowCmd: `go test ./... -run "^${name}$" -v 2>&1` });
  }
  return tests;
}

function parseGeneric(output: string): FailedTest[] {
  const tests: FailedTest[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/\bFAIL(ED|ING)?\b/i.test(lines[i]) && lines[i].trim().length < 200) {
      const snippet = lines.slice(i + 1, i + 8).filter(l => l.trim()).join('\n').trim().slice(0, 800);
      tests.push({ name: lines[i].trim(), errorSnippet: snippet });
      i += 7;
    }
  }
  return tests.slice(0, 20);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Scope narrowing
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildNarrowCommand(suite: DetectedSuite, failedTests: FailedTest[]): string | null {
  if (failedTests.length === 0) return null;

  switch (suite.framework) {
    case 'jest': {
      const names = failedTests.map(t => escapeRegex(t.name)).join('|');
      const files = [...new Set(failedTests.map(t => t.file).filter(Boolean))].join(' ');
      return `npx jest ${files ? files + ' ' : ''}--testNamePattern="${names}" --no-coverage 2>&1`;
    }
    case 'vitest': {
      const files = [...new Set(failedTests.map(t => t.file).filter(Boolean))];
      if (files.length > 0) return `npx vitest run ${files.join(' ')} --reporter=verbose 2>&1`;
      const names = failedTests.map(t => escapeRegex(t.name)).join('|');
      return `npx vitest run -t "${names}" --reporter=verbose 2>&1`;
    }
    case 'pytest': {
      const ids = failedTests.map(t => `${t.file}::${t.name}`).filter(id => !id.startsWith(':')).join(' ');
      return ids ? `python -m pytest ${ids} -v 2>&1` : null;
    }
    case 'cargo': {
      if (failedTests.length === 1) return failedTests[0].narrowCmd ?? null;
      return 'cargo test 2>&1';
    }
    case 'go': {
      const names = failedTests.map(t => t.name).join('|');
      return `go test ./... -run "^(${names})$" -v 2>&1`;
    }
    default:
      return null;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Bridge helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function execShell(userId: number, cmd: string, cwd: string, timeoutMs = 180_000): Promise<string> {
  try {
    const raw = await Promise.race<unknown>([
      sendToBridge(userId, 'exec:shell', { command: cmd, cwd, requiresConfirmation: false }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`test timeout after ${timeoutMs / 1000}s`)), timeoutMs),
      ),
    ]);
    if (raw && typeof raw === 'object') {
      const { output = '', stdout = '', stderr = '' } = raw as { output?: string; stdout?: string; stderr?: string };
      return (output || `${stdout}\n${stderr}`).trim();
    }
    return String(raw ?? '');
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.length > 80 && !msg.includes('timeout')) return msg;
    return `Error running tests: ${msg}`;
  }
}

async function readFileSafe(userId: number, absPath: string): Promise<string | null> {
  try {
    const res = await sendToBridge(userId, 'exec:read_file', { path: absPath });
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && typeof (res as { content?: unknown }).content === 'string') {
      return (res as { content: string }).content;
    }
    return null;
  } catch { return null; }
}

async function fileExists(userId: number, absPath: string): Promise<boolean> {
  try {
    await sendToBridge(userId, 'exec:path_exists', { path: absPath });
    return true;
  } catch { return false; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
