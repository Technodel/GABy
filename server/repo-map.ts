/**
 * GABy Repo Map — ported from Aider's repomap.py logic.
 *
 * Builds a compressed "map" of the project codebase (file paths + exported symbols)
 * and injects it into every prompt so the AI knows what's in the project without
 * needing explicit file reads first.
 *
 * Architecture:
 *   1. Write a small extraction script to the user's project via the bridge
 *   2. Execute it with exec:shell (single pass over all source files)
 *   3. Parse JSON result of { relPath: string[] } (symbols per file)
 *   4. Cache for 90 seconds — invalidated on any file_edit / file_write
 *   5. Rank by relevance to current user message, trim to token budget
 *   6. Format as <repo_map>...</repo_map> and inject into system prompt
 */

import path from 'path';
import { sendToBridge } from './bridge-manager';
import { isBridgeConnected } from './bridge-manager';

interface SymbolMap { [relPath: string]: string[] }

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, { data: SymbolMap; at: number }>();
const CACHE_TTL = 90_000; // 90 seconds

export function invalidateRepoMap(userId: number, projectPath: string): void {
  cache.delete(`${userId}|${projectPath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function buildRepoMap(
  userId: number,
  projectPath: string,
  userMessage: string,
  tokenBudget = 1800,
): Promise<string> {
  if (!isBridgeConnected(userId)) return '';

  const key = `${userId}|${projectPath}`;
  let entry = cache.get(key);

  if (!entry || Date.now() - entry.at > CACHE_TTL) {
    try {
      const data = await Promise.race<SymbolMap>([
        extractSymbols(userId, projectPath),
        new Promise<SymbolMap>((_, reject) =>
          setTimeout(() => reject(new Error('repo-map timeout after 20s')), 20_000),
        ),
      ]);
      entry = { data, at: Date.now() };
      cache.set(key, entry);
    } catch (err) {
      console.warn('[repo-map] extraction failed:', (err as Error).message);
      return '';
    }
  }

  return formatMap(entry.data, userMessage, tokenBudget);
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction script — executed as a single Node.js process on the user's machine
// via exec:shell.  Uses only Node.js built-ins (fs, path, child_process).
// String.raw preserves backslashes so regex patterns survive the template literal.
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACTION_SCRIPT = String.raw`
(function(projectPath) {
  const fs = require('fs');
  const p = require('path');
  const cp = require('child_process');

  const MAX = 200;
  const SKIP = new Set([
    'node_modules','.git','dist','build','.next','__pycache__','venv','.venv',
    'vendor','coverage','.cache','.turbo','out','.output','target',
    '.svelte-kit','public','static','assets','migrations',
  ]);
  const EXTS = new Set([
    '.ts','.tsx','.js','.jsx','.py','.go','.rb','.php',
    '.java','.cs','.rs','.vue','.svelte','.kt','.swift',
  ]);

  // Symbol extraction regexes per extension
  const RX = {
    ts: [
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/gm,
      /^(?:export\s+)?class\s+(\w+)/gm,
      /^(?:export\s+)?(?:interface|type|enum)\s+(\w+)/gm,
      /^export\s+(?:const|let)\s+(\w+)/gm,
    ],
    tsx: [
      /^(?:export\s+)?(?:default\s+)?function\s+(\w+)/gm,
      /^(?:export\s+)?class\s+(\w+)/gm,
      /^(?:export\s+)?(?:interface|type)\s+(\w+)/gm,
      /^export\s+(?:const|let)\s+(\w+)/gm,
    ],
    js: [
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
      /^(?:export\s+)?class\s+(\w+)/gm,
      /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
      /^(?:module\.exports\.)(\w+)\s*=/gm,
    ],
    jsx: [
      /^(?:export\s+)?function\s+(\w+)/gm,
      /^export\s+(?:const|let)\s+(\w+)/gm,
    ],
    py: [
      /^(?:async\s+)?def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
    ],
    go: [
      /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm,
      /^type\s+(\w+)\s+(?:struct|interface)/gm,
    ],
    rb: [
      /^\s*def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
      /^module\s+(\w+)/gm,
    ],
    rs: [
      /^pub\s+(?:async\s+)?fn\s+(\w+)/gm,
      /^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/gm,
    ],
    java: [
      /^(?:public|private|protected|static|\s)+(?:\w+\s+)+(\w+)\s*\(/gm,
      /^(?:public|private|protected)?\s+(?:class|interface|enum)\s+(\w+)/gm,
    ],
    cs: [
      /^(?:public|private|protected|internal|static|\s)+\w+\s+(\w+)\s*\(/gm,
      /^(?:public|private|internal)?\s+(?:class|interface|enum|struct)\s+(\w+)/gm,
    ],
  };

  function walk(dir, acc) {
    if (acc.length >= MAX) return;
    let es;
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (acc.length >= MAX) break;
      if (e.name.startsWith('.') && !e.isDirectory()) continue;
      const full = p.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(full, acc);
      } else if (e.isFile() && EXTS.has(p.extname(e.name).toLowerCase())) {
        acc.push(full);
      }
    }
  }

  // Prefer git ls-files for accuracy (respects .gitignore)
  let files = [];
  try {
    const out = cp.execSync('git ls-files', { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    files = out.trim().split('\n').filter(Boolean)
      .map(f => p.resolve(projectPath, f))
      .filter(f => {
        const e = p.extname(f).toLowerCase();
        const parts = f.split(p.sep);
        return EXTS.has(e) && !parts.some(d => SKIP.has(d));
      })
      .slice(0, MAX);
  } catch (e) {
    walk(projectPath, files);
  }

  const result = {};
  for (const fp of files) {
    const rel = p.relative(projectPath, fp).replace(/\\/g, '/');
    const ext = p.extname(fp).slice(1).toLowerCase();
    const alias = (ext === 'mjs' || ext === 'cjs') ? 'js' : ext;
    const pats = RX[alias] || [];

    let content;
    try { content = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
    if (content.length > 80000) { result[rel] = ['[large file — use file_read to explore]']; continue; }

    const syms = new Set();
    for (const rx of pats) {
      const r = new RegExp(rx.source, rx.flags);
      let m;
      while ((m = r.exec(content)) !== null) {
        if (m[1] && m[1].length > 1 && m[1].length < 50 && !/^\d/.test(m[1])) {
          syms.add(m[1]);
        }
      }
    }
    result[rel] = [...syms];
  }

  process.stdout.write(JSON.stringify(result));
})(process.argv[2]);
`.trim();

async function extractSymbols(userId: number, projectPath: string): Promise<SymbolMap> {
  const scriptPath = path.join(projectPath, '.gaby-repomap.js');
  try {
    // Write extraction script to project dir
    await sendToBridge(userId, 'exec:write_file', {
      path: scriptPath,
      content: EXTRACTION_SCRIPT,
    }, 10_000);

    // Run it — pass projectPath as forward-slash for cross-platform compat
    const normalizedPath = projectPath.replace(/\\/g, '/').replace(/"/g, '\\"');
    const raw = await sendToBridge(userId, 'exec:shell', {
      command: `node ".gaby-repomap.js" "${normalizedPath}"`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 25_000) as string;

    return JSON.parse(raw.trim());
  } finally {
    // Always clean up temp script
    sendToBridge(userId, 'exec:delete_file', { path: scriptPath }, 5_000).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Relevance scoring — files mentioned in the user's message rank higher
// ─────────────────────────────────────────────────────────────────────────────

function scoreFile(relPath: string, msg: string): number {
  const lower = msg.toLowerCase();
  const name = relPath.toLowerCase();
  const parts = name.split('/');
  const base = (parts.pop() || '').replace(/\.[^.]+$/, '');

  let score = 0;
  if (base.length > 2 && lower.includes(base)) score += 10;
  if (lower.includes(name)) score += 20;
  // Shallower files (closer to root) get a small boost
  score += Math.max(0, 6 - parts.length);
  // Key files always near top
  if (['index', 'main', 'app', 'server', 'mod'].includes(base)) score += 3;
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format + trim to token budget
// ─────────────────────────────────────────────────────────────────────────────

function formatMap(symbols: SymbolMap, userMessage: string, tokenBudget: number): string {
  const entries = Object.entries(symbols);
  if (!entries.length) return '';

  const sorted = entries.sort((a, b) => scoreFile(b[0], userMessage) - scoreFile(a[0], userMessage));
  const BUDGET_CHARS = tokenBudget * 3.5;

  const lines: string[] = [];
  let used = 0;

  for (const [rel, syms] of sorted) {
    if (used >= BUDGET_CHARS) break;
    const symPart = syms.length ? `  ${syms.slice(0, 20).join(', ')}` : '';
    const entry = symPart ? `${rel}\n${symPart}` : rel;
    used += entry.length + 1;
    if (used > BUDGET_CHARS) break;
    lines.push(entry);
  }

  if (!lines.length) return '';
  return `<repo_map>\n${lines.join('\n')}\n</repo_map>`;
}
