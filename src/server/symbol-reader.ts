/**
 * SUNy Symbol Reader — regex-based function/class/variable/export map.
 *
 * F2a deliverable: gives the AI a structural view of a JS/TS file without
 * reading the full content. Reduces context usage on large files and
 * improves edit precision by showing exact symbol locations.
 *
 * No native dependencies — pure regex. Falls back gracefully for non-JS/TS.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { sendToBridge, isBridgeConnected } from './bridge-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum' | 'method' | 'property';
  exported: boolean;
  line: number;
  defaultExport: boolean;
}

export interface SymbolMap {
  filePath: string;
  symbols: SymbolEntry[];
  language: string;
  lineCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regex patterns for JS/TS symbol extraction
// ─────────────────────────────────────────────────────────────────────────────

interface SymbolPattern {
  regex: RegExp;
  kind: SymbolEntry['kind'];
}

const EXPORT_PATTERNS: SymbolPattern[] = [
  { regex: /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,   kind: 'function' },
  { regex: /export\s+default\s+class\s+(\w+)/g,                     kind: 'class' },
  { regex: /export\s+default\s+(?:const|let|var)\s+(\w+)/g,          kind: 'variable' },
  { regex: /export\s+function\s+(\w+)/g,                             kind: 'function' },
  { regex: /export\s+(?:async\s+)?function\s+(\w+)/g,                kind: 'function' },
  { regex: /export\s+class\s+(\w+)/g,                                kind: 'class' },
  { regex: /export\s+(?:abstract\s+)?class\s+(\w+)/g,                kind: 'class' },
  { regex: /export\s+interface\s+(\w+)/g,                            kind: 'interface' },
  { regex: /export\s+type\s+(\w+)\s*=/g,                             kind: 'type' },
  { regex: /export\s+(?:const|let|var)\s+(\w+)/g,                    kind: 'variable' },
  { regex: /export\s+enum\s+(\w+)/g,                                 kind: 'enum' },
];

const DECLARATION_PATTERNS: SymbolPattern[] = [
  { regex: /(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(/g,        kind: 'function' },
  { regex: /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g, kind: 'class' },
  { regex: /(?:^|\n)\s*(?:export\s+)?interface\s+(\w+)/g,           kind: 'interface' },
  { regex: /(?:^|\n)\s*(?:export\s+)?type\s+(\w+)\s*=/g,            kind: 'type' },
  { regex: /(?:^|\n)\s*(?:export\s+)?enum\s+(\w+)/g,                kind: 'enum' },
  { regex: /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::|=)/g, kind: 'variable' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract symbol entries from file content.
 * Deduplicates by name — prefers exported over non-exported, keeps first occurrence.
 */
export function extractSymbols(content: string, fileName: string): SymbolMap {
  const lines = content.split('\n');
  const symbolMap = new Map<string, SymbolEntry>();

  // Helper to add a symbol (prefer exported, keep first)
  const addSymbol = (name: string, kind: SymbolEntry['kind'], line: number, exported: boolean, defaultExport: boolean) => {
    const existing = symbolMap.get(name);
    if (existing) {
      // Prefer exported over non-exported
      if (exported && !existing.exported) {
        symbolMap.set(name, { name, kind, exported, line, defaultExport });
      }
      return;
    }
    symbolMap.set(name, { name, kind, exported, line, defaultExport });
  };

  // Scan export patterns first (prefer exported status)
  for (const { regex, kind } of EXPORT_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      // Find approximate line number
      const line = getLineNumber(content, match.index);
      const isDefault = content.slice(match.index, match.index + match[0].length).startsWith('export default');
      addSymbol(name, kind, line, true, isDefault);
    }
  }

  // Scan declarations — only add if not already captured as exported
  for (const { regex, kind } of DECLARATION_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (!symbolMap.has(name)) {
        const line = getLineNumber(content, match.index);
        addSymbol(name, kind, line, false, false);
      }
    }
  }

  // Detect methods inside classes (indented function declarations)
  const methodRegex = /(?:^|\n)(\s+)(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(content)) !== null) {
    const indent = match[1];
    const name = match[2];
    // Only count as method if indented (inside a class/object)
    if (indent.length >= 2 && !symbolMap.has(name)) {
      const line = getLineNumber(content, match.index);
      // Skip if it looks like a standalone function (no indentation)
      addSymbol(name, 'method', line, false, false);
    }
  }

  const lang = detectLanguage(fileName);

  return {
    filePath: fileName,
    symbols: Array.from(symbolMap.values()),
    language: lang,
    lineCount: lines.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function detectLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'ts': case 'tsx': return 'TypeScript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'JavaScript';
    case 'py': return 'Python';
    case 'go': return 'Go';
    case 'rs': return 'Rust';
    case 'java': return 'Java';
    case 'rb': return 'Ruby';
    case 'php': return 'PHP';
    case 'css': case 'scss': case 'less': return 'Stylesheet';
    case 'json': return 'JSON';
    case 'md': return 'Markdown';
    case 'yaml': case 'yml': return 'YAML';
    default: return 'Unknown';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format for AI consumption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a SymbolMap into a compact string for the AI.
 */
export function formatSymbolMap(map: SymbolMap): string {
  if (map.symbols.length === 0) {
    return `[${map.filePath}] — ${map.language}, ${map.lineCount} lines. No symbols detected.`;
  }

  const maxNameLen = Math.max(...map.symbols.map(s => s.name.length));
  const lines: string[] = [
    `📄 ${map.filePath} — ${map.language}, ${map.lineCount} lines, ${map.symbols.length} symbols`,
    '',
  ];

  for (const sym of map.symbols) {
    const marker = sym.exported ? (sym.defaultExport ? '⬇' : '📤') : '  ';
    const lineStr = `L${String(sym.line).padStart(4)}`;
    const namePadded = sym.name.padEnd(maxNameLen);
    lines.push(`  ${marker} ${lineStr}  ${namePadded}  ${sym.kind}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSymbolReaderTool(ctx: { userId: number; projectPath: string }) {
  const { userId, projectPath } = ctx;

  return tool({
    description:
      'Read the symbol structure of a file (functions, classes, interfaces, types, variables, enums) ' +
      'without reading the full content. Returns symbol names, kinds, export status, and line numbers. ' +
      'Use this to understand a file\'s structure before editing — saves tokens vs reading the whole file. ' +
      'Supports JS/TS, Python, Go, Rust, Java, and others.',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file (relative to WorkingDirectory, or absolute).'),
    }),
    execute: async ({ filePath }) => {
      if (!isBridgeConnected(userId)) {
        return 'Bridge not connected. Cannot read file.';
      }

      const absPath = filePath.startsWith('/') || filePath.startsWith('~')
        ? filePath
        : `${projectPath}/${filePath}`;

      try {
        const rawContent = await sendToBridge(userId, 'exec:read_file', {
          path: absPath,
          withLines: false,
        }, 15000) as string | undefined;

        if (!rawContent) {
          return `File '${filePath}' is empty or could not be read.`;
        }

        const symbolMap = extractSymbols(
          (rawContent as string).replace(/\r\n/g, '\n'),
          filePath,
        );

        return formatSymbolMap(symbolMap);
      } catch (e) {
        return `Error reading symbols from '${filePath}': ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}
