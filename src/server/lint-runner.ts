/**
 * SUNy Lint Runner — Aider's linter self-correction loop ported to TypeScript.
 *
 * After every turn where files are changed:
 *   1. Auto-detect the project's lint/type-check command
 *   2. Run it via bridge exec:shell
 *   3. Return structured results so agent-loop.ts can feed errors back to the AI
 *
 * Detection priority (first match wins):
 *   TypeScript project  → npx tsc --noEmit
 *   "typecheck" script  → npm run typecheck
 *   "lint" script       → npm run lint
 *   Cargo.toml          → cargo check
 *   go.mod              → go build ./...
 *   pyproject.toml      → python -m ruff check . (or flake8)
 *   requirements.txt    → python -m py_compile <changed files>
 *   None                → skip
 */

import { sendToBridge, isBridgeConnected } from './bridge-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LintResult {
  /** true = no errors (warnings are OK) */
  passed: boolean;
  /** raw combined stdout + stderr output from the linter */
  output: string;
  /** estimated number of errors (0 if passed) */
  errorCount: number;
  /** the command that was run, for display purposes */
  command: string;
}

interface DetectedCommand {
  cmd: string;
  label: string;
  /** cwd relative to project root — usually '.' */
  cwd?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command detection cache  (per project path, TTL 5 min)
// ─────────────────────────────────────────────────────────────────────────────

const cmdCache = new Map<string, { cmd: DetectedCommand | null; at: number }>();
const CMD_TTL = 5 * 60_000;

export function clearLintCache(projectPath: string): void {
  cmdCache.delete(projectPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the auto-detected lint command for the project.
 * Returns null if no suitable command is found or bridge is offline.
 */
export async function runLint(
  userId: number,
  projectPath: string,
  changedFiles?: string[],
  signal?: AbortSignal,
): Promise<LintResult | null> {
  if (!isBridgeConnected(userId)) return null;

  const detected = await detectCommand(userId, projectPath, changedFiles);
  if (!detected) return null;

  const cwd = detected.cwd ? `${projectPath}/${detected.cwd}` : projectPath;

  console.log(`[lint-runner] running: ${detected.cmd} (cwd: ${cwd})`);

  try {
    const raw = await Promise.race<string>([
      execShell(userId, detected.cmd, cwd),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('lint timeout after 60s')), 60_000),
      ),
    ]);

    return parseResult(raw, detected.cmd);
  } catch (err) {
    const msg = (err as Error).message;
    // A non-zero exit code comes back as a thrown error with the output in the message
    if (msg.includes('exit code') || msg.length > 100) {
      // The shell error *is* the lint output — treat it as a failure
      return parseResult(msg, detected.cmd);
    }
    console.warn('[lint-runner] lint execution error:', msg);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

async function detectCommand(
  userId: number,
  projectPath: string,
  changedFiles?: string[],
): Promise<DetectedCommand | null> {
  const cached = cmdCache.get(projectPath);
  if (cached && Date.now() - cached.at < CMD_TTL) return cached.cmd;

  let cmd: DetectedCommand | null = null;
  try {
    cmd = await doDetect(userId, projectPath, changedFiles);
  } catch {
    cmd = null;
  }

  cmdCache.set(projectPath, { cmd, at: Date.now() });
  return cmd;
}

async function doDetect(
  userId: number,
  projectPath: string,
  changedFiles?: string[],
): Promise<DetectedCommand | null> {
  // Read package.json if present (covers Node/TS/JS projects)
  const pkgRaw = await readFileSafe(userId, `${projectPath}/package.json`);
  if (pkgRaw) {
    let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    try { pkg = JSON.parse(pkgRaw); } catch { pkg = {}; }

    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };

    // TypeScript present → tsc --noEmit is the most reliable
    if (deps['typescript']) {
      // Check for custom typecheck script first (might include additional flags)
      if (scripts['typecheck']) {
        return { cmd: 'npm run typecheck', label: 'TypeScript type check' };
      }
      // Check if there's a tsconfig.json
      const hasTsConfig = await fileExists(userId, `${projectPath}/tsconfig.json`);
      if (hasTsConfig) {
        return { cmd: 'npx tsc --noEmit', label: 'TypeScript compiler' };
      }
    }

    // ESLint available in scripts
    if (scripts['lint'] && !scripts['lint'].includes('echo')) {
      return { cmd: 'npm run lint', label: 'ESLint' };
    }

    // build script that invokes tsc or vite build
    if (scripts['build'] && (scripts['build'].includes('tsc') || scripts['build'].includes('vite'))) {
      return { cmd: 'npm run build', label: 'Build check' };
    }

    // Plain Node.js project — no static typing, skip
    return null;
  }

  // Cargo.toml → Rust
  const hasCargo = await fileExists(userId, `${projectPath}/Cargo.toml`);
  if (hasCargo) return { cmd: 'cargo check', label: 'Rust cargo check' };

  // go.mod → Go
  const hasGoMod = await fileExists(userId, `${projectPath}/go.mod`);
  if (hasGoMod) return { cmd: 'go build ./...', label: 'Go build check' };

  // pyproject.toml → Python (ruff preferred, fallback flake8)
  const hasPyProject = await fileExists(userId, `${projectPath}/pyproject.toml`);
  if (hasPyProject) {
    // Try ruff first (modern, fast)
    return { cmd: 'python -m ruff check .', label: 'Ruff linter' };
  }

  // requirements.txt → Python, check only changed .py files
  const hasRequirements = await fileExists(userId, `${projectPath}/requirements.txt`);
  if (hasRequirements && changedFiles) {
    const pyFiles = changedFiles
      .filter(f => f.endsWith('.py'))
      .map(f => JSON.stringify(f))
      .join(' ');
    if (pyFiles) {
      return { cmd: `python -m py_compile ${pyFiles}`, label: 'Python syntax check' };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse linter output into a structured result
// ─────────────────────────────────────────────────────────────────────────────

function parseResult(raw: string, command: string): LintResult {
  const output = raw.trim();

  // Heuristics for "has errors":
  // tsc: "error TS" or "Found N error(s)"
  // eslint: "N error(s)" or "error" lines
  // cargo: "error[" 
  // ruff: lines starting with "error"
  // go: lines ending in "# errors" or starting with ".go:"

  const hasError =
    /\berror\b/i.test(output) ||
    /\d+ error/i.test(output) ||
    /error\[/i.test(output);

  // Don't penalise "0 errors" or "no error" lines
  const cleanedForCount = output
    .replace(/0 errors?/gi, '')
    .replace(/no error/gi, '');

  const errorMatches = cleanedForCount.match(/\berror\b/gi) ?? [];
  const errorCount = hasError ? Math.max(1, errorMatches.length) : 0;

  // Special case: tsc "Found N error(s)"
  const tscMatch = output.match(/Found (\d+) error/i);
  const finalCount = tscMatch ? parseInt(tscMatch[1], 10) : errorCount;

  return {
    passed: finalCount === 0,
    output,
    errorCount: finalCount,
    command,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge helpers
// ─────────────────────────────────────────────────────────────────────────────

async function execShell(userId: number, cmd: string, cwd: string): Promise<string> {
  // Bridge expects `command`, not `cmd`. Result `output` contains combined stream lines.
  const res = await sendToBridge(userId, 'exec:shell', { command: cmd, cwd, requiresConfirmation: false });
  if (res && typeof res === 'object') {
    const { output = '', stdout = '', stderr = '' } = res as { output?: string; stdout?: string; stderr?: string };
    return (output || `${stdout}\n${stderr}`).trim();
  }
  return String(res ?? '');
}

async function readFileSafe(userId: number, absPath: string): Promise<string | null> {
  try {
    const res = await sendToBridge(userId, 'exec:read_file', { path: absPath });
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && typeof (res as { content?: unknown }).content === 'string') {
      return (res as { content: string }).content;
    }
    return null;
  } catch {
    return null;
  }
}

async function fileExists(userId: number, absPath: string): Promise<boolean> {
  try {
    await sendToBridge(userId, 'exec:path_exists', { path: absPath });
    return true;
  } catch {
    return false;
  }
}
