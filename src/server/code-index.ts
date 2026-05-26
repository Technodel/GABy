/**
 * SUNy Code Index â€” lightweight import/export/symbol graph using regex.
 *
 * Scans JS/TS files to build a searchable index of:
 *   - imports (source module + imported symbols)
 *   - exports (named + default)
 *   - declarations (functions, classes, interfaces, types, variables)
 *   - file-level metadata (path, last modified)
 *
 * Stored in SQLite for persistent querying across sessions.
 * No native dependencies â€” pure regex, fast enough for projects up to ~10K files.
 *
 * Feature flag: ff_code_index
 */

import fs from 'fs';
import path from 'path';
import { getDb } from './db';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface IndexedSymbol {
  filePath: string;
  symbolType: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum' | 'component';
  symbolName: string;
  lineStart: number;
  lineEnd: number;
  exportType: 'named' | 'default' | 'none';
}

export interface IndexedImport {
  filePath: string;
  source: string;
  importedSymbols: string[];
  isDefault: boolean;
  lineNumber: number;
}

export interface CodeSearchResult {
  symbol?: IndexedSymbol;
  import?: IndexedImport;
  filePath: string;
  relevanceScore: number;
  matchContext: string;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Regex patterns for JS/TS code analysis
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const IMPORT_PATTERN = /^import\s+(?:(?<default>\w+)\s*,?\s*)?(?:{\s*(?<named>[^}]+)\s*})?\s*from\s+['"](?<source>[^'"]+)['"]/gm;
const RE_EXPORT_PATTERN = /^export\s+\*?\s*(?:from\s+['"](?<source>[^'"]+)['"]|{\s*(?<named>[^}]+)\s*}\s*from\s+['"](?<source2>[^'"]+)['"])/gm;
const EXPORT_FUNCTION = /^export\s+(?:async\s+)?function\s+(?<name>\w+)/gm;
const EXPORT_CLASS = /^export\s+(?:abstract\s+)?class\s+(?<name>\w+)/gm;
const EXPORT_INTERFACE = /^export\s+interface\s+(?<name>\w+)/gm;
const EXPORT_TYPE = /^export\s+type\s+(?<name>\w+)/gm;
const EXPORT_DEFAULT = /^export\s+default\s+(?:function|class|const)\s+(?<name>\w+)/gm;
const EXPORT_DEFAULT_ANON = /^export\s+default\s+(?:(?:function|class)\s*[({\[])/gm;
const EXPORT_VARIABLE = /^export\s+(?:const|let|var)\s+(?<name>\w+)/gm;
const EXPORT_ENUM = /^export\s+enum\s+(?<name>\w+)/gm;
const DECLARE_FUNCTION = /^(?:async\s+)?function\s+(?<name>\w+)/gm;
const DECLARE_CLASS = /^(?:abstract\s+)?class\s+(?<name>\w+)/gm;
const DECLARE_INTERFACE = /^interface\s+(?<name>\w+)/gm;
const DECLARE_TYPE = /^type\s+(?<name>\w+)/gm;
const COMPONENT_PATTERN = /^(?:export\s+)?(?:const|function)\s+(?<name>[A-Z]\w*)\s*(?::\s*\w+\s*)?=[\s\S]{0,50}(?:=>|\(|React\.)/gm;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Index management
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function initializeCodeIndexTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      file_hash TEXT,
      symbol_type TEXT NOT NULL,
      symbol_name TEXT NOT NULL,
      export_type TEXT DEFAULT 'none',
      line_start INTEGER DEFAULT 0,
      line_end INTEGER DEFAULT 0,
      context_line TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(file_path, symbol_name, symbol_type)
    );
    CREATE TABLE IF NOT EXISTS code_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      source TEXT NOT NULL,
      imported_symbols TEXT DEFAULT '[]',
      is_default INTEGER DEFAULT 0,
      line_number INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_code_index_file ON code_index(file_path);
    CREATE INDEX IF NOT EXISTS idx_code_index_name ON code_index(symbol_name);
    CREATE INDEX IF NOT EXISTS idx_code_index_type ON code_index(symbol_type);
    CREATE INDEX IF NOT EXISTS idx_code_imports_source ON code_imports(source);
    CREATE INDEX IF NOT EXISTS idx_code_imports_file ON code_imports(file_path);
  `);
}

/**
 * Scan a single file and extract all symbols and imports.
 */
export function indexFile(filePath: string): { symbols: number; imports: number } {
  if (!fs.existsSync(filePath)) return { symbols: 0, imports: 0 };

  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return { symbols: 0, imports: 0 };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const db = getDb();

  // Remove old entries for this file
  db.prepare('DELETE FROM code_index WHERE file_path = ?').run(filePath);
  db.prepare('DELETE FROM code_imports WHERE file_path = ?').run(filePath);

  // â”€â”€ Extract imports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let importCount = 0;
  let match: RegExpExecArray | null;

  // Reset regex lastIndex
  IMPORT_PATTERN.lastIndex = 0;
  while ((match = IMPORT_PATTERN.exec(content)) !== null) {
    const defaultImport = match.groups?.default?.trim() || '';
    const namedRaw = match.groups?.named || '';
    const source = match.groups?.source || '';

    const namedSymbols = namedRaw
      .split(',')
      .map(s => s.trim().replace(/\s+as\s+\w+$/, ''))
      .filter(Boolean);

    if (defaultImport) namedSymbols.unshift(defaultImport);

    // Find line number
    const lineNumber = content.slice(0, match.index).split('\n').length;

    db.prepare(
      `INSERT OR REPLACE INTO code_imports (file_path, source, imported_symbols, is_default, line_number)
       VALUES (?, ?, ?, ?, ?)`
    ).run(filePath, source, JSON.stringify(namedSymbols), defaultImport ? 1 : 0, lineNumber);
    importCount++;
  }

  // â”€â”€ Extract exports / declarations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const patterns: Array<{ pattern: RegExp; type: IndexedSymbol['symbolType']; exportType: 'named' | 'default' | 'none' }> = [
    { pattern: EXPORT_FUNCTION, type: 'function', exportType: 'named' },
    { pattern: EXPORT_CLASS, type: 'class', exportType: 'named' },
    { pattern: EXPORT_INTERFACE, type: 'interface', exportType: 'named' },
    { pattern: EXPORT_TYPE, type: 'type', exportType: 'named' },
    { pattern: EXPORT_DEFAULT, type: 'function', exportType: 'default' },
    { pattern: EXPORT_VARIABLE, type: 'variable', exportType: 'named' },
    { pattern: EXPORT_ENUM, type: 'enum', exportType: 'named' },
    { pattern: DECLARE_FUNCTION, type: 'function', exportType: 'none' },
    { pattern: DECLARE_CLASS, type: 'class', exportType: 'none' },
    { pattern: DECLARE_INTERFACE, type: 'interface', exportType: 'none' },
    { pattern: DECLARE_TYPE, type: 'type', exportType: 'none' },
  ];

  let symbolCount = 0;

  for (const { pattern, type, exportType } of patterns) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      const name = match.groups?.name || '';
      if (!name) continue;
      const lineStart = content.slice(0, match.index).split('\n').length;
      const lineEnd = findBlockEnd(lines, lineStart - 1);
      const contextLine = lines[lineStart - 1]?.trim()?.slice(0, 120) || '';

      db.prepare(
        `INSERT OR REPLACE INTO code_index (file_path, symbol_type, symbol_name, export_type, line_start, line_end, context_line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(filePath, type, name, exportType, lineStart, lineEnd, contextLine);
      symbolCount++;
    }
  }

  // Detect React components (exported const/function starting with capital letter)
  COMPONENT_PATTERN.lastIndex = 0;
  while ((match = COMPONENT_PATTERN.exec(content)) !== null) {
    const name = match.groups?.name || '';
    if (!name) continue;
    const lineStart = content.slice(0, match.index).split('\n').length;
    const contextLine = lines[lineStart - 1]?.trim()?.slice(0, 120) || '';

    // Avoid duplicate with already indexed symbols
    const existing = db.prepare(
      'SELECT 1 FROM code_index WHERE file_path = ? AND symbol_name = ? AND symbol_type = ?'
    ).get(filePath, name, 'component');
    if (existing) continue;

    db.prepare(
      `INSERT OR REPLACE INTO code_index (file_path, symbol_type, symbol_name, export_type, line_start, line_end, context_line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(filePath, 'component', name, 'named', lineStart, lineStart + 1, contextLine);
    symbolCount++;
  }

  return { symbols: symbolCount, imports: importCount };
}

/**
 * Scan an entire project directory and index all JS/TS files.
 */
export function indexProject(projectPath: string): { filesIndexed: number; totalSymbols: number; totalImports: number } {
  initializeCodeIndexTable();

  let filesIndexed = 0;
  let totalSymbols = 0;
  let totalImports = 0;

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            const result = indexFile(fullPath);
            filesIndexed++;
            totalSymbols += result.symbols;
            totalImports += result.imports;
          }
        }
      }
    } catch {
      // Permission errors or broken symlinks â€” skip
    }
  }

  walkDir(projectPath);
  return { filesIndexed, totalSymbols, totalImports };
}

/**
 * Search the code index by symbol name or type.
 * Returns matches ranked by relevance.
 */
export function searchCodeIndex(
  query: string,
  options?: { type?: string; filePath?: string; limit?: number },
): CodeSearchResult[] {
  const db = getDb();
  const limit = options?.limit ?? 20;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Search by symbol name (fuzzy via LIKE)
  conditions.push('(symbol_name LIKE ? OR context_line LIKE ?)');
  const searchTerm = `%${query}%`;
  params.push(searchTerm, searchTerm);

  if (options?.type) {
    conditions.push('symbol_type = ?');
    params.push(options.type);
  }

  if (options?.filePath) {
    conditions.push('file_path = ?');
    params.push(options.filePath);
  }

  const where = conditions.join(' AND ');

  const rows = db.prepare(
    `SELECT file_path, symbol_type, symbol_name, export_type, line_start, line_end, context_line
     FROM code_index
     WHERE ${where}
     ORDER BY
       CASE
         WHEN symbol_name = ? THEN 0
         WHEN symbol_name LIKE ? THEN 1
         ELSE 2
       END,
       symbol_name
     LIMIT ?`
  ).all(query, `${query}%`, limit, ...params) as Array<{
    file_path: string; symbol_type: string; symbol_name: string;
    export_type: string; line_start: number; line_end: number; context_line: string;
  }>;

  return rows.map(r => ({
    filePath: r.file_path,
    symbol: {
      filePath: r.file_path,
      symbolType: r.symbol_type as IndexedSymbol['symbolType'],
      symbolName: r.symbol_name,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      exportType: r.export_type as IndexedSymbol['exportType'],
    },
    relevanceScore: r.symbol_name === query ? 1 : r.symbol_name.startsWith(query) ? 0.5 : 0.2,
    matchContext: r.context_line,
  }));
}

/**
 * Find which files import a given symbol or module.
 */
export function findImporters(symbolOrModule: string): Array<{ filePath: string; source: string; importedSymbols: string[] }> {
  const db = getDb();

  // Search as source module
  const bySource = db.prepare(
    `SELECT file_path, source, imported_symbols
     FROM code_imports
     WHERE source LIKE ?`
  ).all(`%${symbolOrModule}%`) as Array<{ file_path: string; source: string; imported_symbols: string }>;

  // Search as imported symbol
  const bySymbol = db.prepare(
    `SELECT file_path, source, imported_symbols
     FROM code_imports
     WHERE imported_symbols LIKE ?`
  ).all(`%"${symbolOrModule}"%`) as Array<{ file_path: string; source: string; imported_symbols: string }>;

  const seen = new Set<string>();
  const results: Array<{ filePath: string; source: string; importedSymbols: string[] }> = [];

  for (const row of [...bySource, ...bySymbol]) {
    const key = `${row.file_path}:${row.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      filePath: row.file_path,
      source: row.source,
      importedSymbols: JSON.parse(row.imported_symbols),
    });
  }

  return results;
}

/**
 * Get the symbol at a specific location (file + line number).
 */
export function getSymbolAtLocation(filePath: string, lineNumber: number): IndexedSymbol | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT file_path, symbol_type, symbol_name, export_type, line_start, line_end
     FROM code_index
     WHERE file_path = ? AND line_start <= ? AND line_end >= ?
     ORDER BY (line_end - line_start) ASC
     LIMIT 1`
  ).get(filePath, lineNumber, lineNumber) as {
    file_path: string; symbol_type: string; symbol_name: string;
    export_type: string; line_start: number; line_end: number;
  } | undefined;

  if (!row) return null;
  return {
    filePath: row.file_path,
    symbolType: row.symbol_type as IndexedSymbol['symbolType'],
    symbolName: row.symbol_name,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    exportType: row.export_type as IndexedSymbol['exportType'],
  };
}

/**
 * Get a summary of the indexed project.
 */
export function getIndexSummary(): { totalFiles: number; totalSymbols: number; totalImports: number } {
  const db = getDb();
  const files = db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_index').get() as { c: number };
  const symbols = db.prepare('SELECT COUNT(*) as c FROM code_index').get() as { c: number };
  const imports = db.prepare('SELECT COUNT(*) as c FROM code_imports').get() as { c: number };
  return { totalFiles: files.c, totalSymbols: symbols.c, totalImports: imports.c };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let braceFound = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { braceFound = true; depth++; }
      else if (ch === '}') { depth--; }
    }
    if (braceFound && depth <= 0) return i + 1;
  }
  return startLine + 1;
}
