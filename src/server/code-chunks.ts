/**
 * code-chunks.ts — Semantic vector context for SUNy.
 *
 * Bridges the existing code-index (symbol names/lines) with the vectors.ts
 * trigram embedding engine to give SUNy "semantic file awareness":
 *
 *   buildChunkVectors(projectPath, projectId)
 *     → reads every indexed symbol body from disk
 *     → embeds with textToVector (trigrams, zero-dependency)
 *     → stores in code_chunks SQLite table (hash-gated, only re-indexes changed content)
 *     → rebuilds an in-memory HNSW index for fast ANN search
 *
 *   searchChunks(query, projectId, topK)
 *     → embeds the query
 *     → HNSW ANN search → brute-force cosine re-rank on top-50
 *     → returns topK most relevant code snippets
 *
 *   formatChunksForPrompt(chunks)
 *     → formats results as a compact system-prompt section
 *
 * Feature flag: ff_vector_context
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb } from './db';
import { textToVector, cosineSimilarity, serializeVector, deserializeVector } from './vectors';
import { HNSWIndex } from './hnsw-lite';

// ── Constants ─────────────────────────────────────────────────────────────────

const VECTOR_DIMS = 2000;
const MAX_CHUNK_LINES = 80;    // cap per chunk to avoid huge embeddings
const MAX_CHUNK_CHARS = 3000;  // char cap for prompt injection per chunk
const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'coverage']);

// ── In-memory HNSW index per project ─────────────────────────────────────────

interface ProjectIndex {
  hnsw: HNSWIndex;
  idToChunk: Map<number, { file: string; symbol: string; type: string; startLine: number; endLine: number }>;
}

const projectIndexes = new Map<number, ProjectIndex>();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChunkResult {
  filePath: string;
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface IndexStats {
  chunksIndexed: number;
  chunksUpdated: number;
  filesProcessed: number;
  skipped: number;
}

// ── Core: build chunk vectors ─────────────────────────────────────────────────

/**
 * Index all symbols in a project into the code_chunks table.
 * Hash-gated: only re-embeds chunks whose content has changed.
 * Returns stats. Safe to call repeatedly (idempotent).
 */
export function buildChunkVectors(projectPath: string, projectId: number): IndexStats {
  const db = getDb();
  const stats: IndexStats = { chunksIndexed: 0, chunksUpdated: 0, filesProcessed: 0, skipped: 0 };

  // Get all indexed symbols for this project (from code_index table)
  const symbols = db.prepare(
    `SELECT file_path, symbol_name, symbol_type, line_start, line_end
     FROM code_index
     WHERE file_path LIKE ?
     ORDER BY file_path, line_start`
  ).all(projectPath.replace(/\\/g, '/') + '%') as Array<{
    file_path: string; symbol_name: string; symbol_type: string; line_start: number; line_end: number;
  }>;

  // Also collect file-level chunks for files with very few/no symbols
  const indexedFiles = new Set(symbols.map(s => s.file_path));

  // Walk project for any supported files not yet in code_index (e.g., Python)
  const extraFiles: string[] = [];
  walkProject(projectPath, (fp) => {
    if (!indexedFiles.has(fp)) extraFiles.push(fp);
  });

  const upsert = db.prepare(`
    INSERT INTO code_chunks (project_id, file_path, symbol_name, symbol_type, start_line, end_line, content, content_hash, vector_b64)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, file_path, symbol_name, symbol_type) DO UPDATE SET
      start_line = excluded.start_line,
      end_line = excluded.end_line,
      content = excluded.content,
      content_hash = excluded.content_hash,
      vector_b64 = excluded.vector_b64,
      updated_at = datetime('now')
    WHERE excluded.content_hash != content_hash
  `);

  const insertMany = db.transaction((items: Array<{
    projectId: number; filePath: string; symbolName: string; symbolType: string;
    startLine: number; endLine: number; content: string; hash: string; vec: string;
  }>) => {
    for (const item of items) {
      const result = upsert.run(item.projectId, item.filePath, item.symbolName, item.symbolType,
        item.startLine, item.endLine, item.content, item.hash, item.vec);
      if (result.changes > 0) stats.chunksUpdated++;
      stats.chunksIndexed++;
    }
  });

  // ── Process symbol-level chunks ──────────────────────────────────────────
  // Group by file to avoid repeated reads
  const byFile = new Map<string, typeof symbols>();
  for (const s of symbols) {
    const key = s.file_path;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(s);
  }

  for (const [filePath, fileSymbols] of byFile) {
    const lines = readFileLines(filePath);
    if (!lines) { stats.skipped++; continue; }
    stats.filesProcessed++;

    const batch: Parameters<typeof insertMany>[0] = [];
    for (const sym of fileSymbols) {
      const startLine = Math.max(1, sym.line_start) - 1; // 0-indexed
      const endLine = Math.min(lines.length, sym.line_end + MAX_CHUNK_LINES, sym.line_start + MAX_CHUNK_LINES);
      const chunk = lines.slice(startLine, endLine).join('\n');
      if (chunk.trim().length < 20) continue; // skip trivial chunks

      const hash = md5(chunk);
      const vec = serializeVector(textToVector(chunk, VECTOR_DIMS));
      batch.push({
        projectId, filePath,
        symbolName: sym.symbol_name, symbolType: sym.symbol_type,
        startLine: sym.line_start, endLine: endLine,
        content: chunk.slice(0, MAX_CHUNK_CHARS), hash, vec,
      });
    }
    if (batch.length > 0) insertMany(batch);
  }

  // ── Process extra files (e.g. Python) as file-level chunks ───────────────
  for (const filePath of extraFiles) {
    const lines = readFileLines(filePath);
    if (!lines) { stats.skipped++; continue; }
    stats.filesProcessed++;

    // Split file into ~80-line blocks
    const blocks: Array<{ start: number; end: number; content: string }> = [];
    for (let i = 0; i < lines.length; i += MAX_CHUNK_LINES) {
      const end = Math.min(lines.length, i + MAX_CHUNK_LINES);
      const content = lines.slice(i, end).join('\n');
      if (content.trim().length < 20) continue;
      blocks.push({ start: i + 1, end, content });
    }

    const batch: Parameters<typeof insertMany>[0] = [];
    for (const block of blocks) {
      const hash = md5(block.content);
      const vec = serializeVector(textToVector(block.content, VECTOR_DIMS));
      batch.push({
        projectId, filePath,
        symbolName: `block_L${block.start}`, symbolType: 'block',
        startLine: block.start, endLine: block.end,
        content: block.content.slice(0, MAX_CHUNK_CHARS), hash, vec,
      });
    }
    if (batch.length > 0) insertMany(batch);
  }

  // ── Rebuild in-memory HNSW for this project ───────────────────────────────
  rebuildProjectIndex(projectId);

  return stats;
}

// ── Core: semantic search ─────────────────────────────────────────────────────

/**
 * Find the topK most semantically relevant code chunks for a query.
 * Uses HNSW for fast ANN, then re-ranks with exact cosine similarity.
 */
export function searchChunks(query: string, projectId: number, topK: number = 8): ChunkResult[] {
  const db = getDb();

  // Ensure index is loaded
  if (!projectIndexes.has(projectId)) {
    rebuildProjectIndex(projectId);
  }

  const idx = projectIndexes.get(projectId);
  const queryVec = textToVector(query, VECTOR_DIMS);

  let candidateIds: number[];

  if (idx && idx.hnsw.size > 0) {
    // HNSW approximate search — get top 50 candidates
    const results = idx.hnsw.search(queryVec, Math.min(50, idx.hnsw.size));
    candidateIds = results.map(r => r.id);
  } else {
    // Fallback: just take most recent 100 chunks for this project
    const rows = db.prepare(
      'SELECT id FROM code_chunks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100'
    ).all(projectId) as Array<{ id: number }>;
    candidateIds = rows.map(r => r.id);
  }

  if (candidateIds.length === 0) return [];

  // Fetch candidate rows
  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, file_path, symbol_name, symbol_type, start_line, end_line, content, vector_b64
     FROM code_chunks
     WHERE id IN (${placeholders})`
  ).all(...candidateIds) as Array<{
    id: number; file_path: string; symbol_name: string; symbol_type: string;
    start_line: number; end_line: number; content: string; vector_b64: string;
  }>;

  // Re-rank with exact cosine similarity
  const scored = rows.map(row => {
    const vec = deserializeVector(row.vector_b64, VECTOR_DIMS);
    const score = cosineSimilarity(queryVec, vec);
    return {
      filePath: row.file_path,
      symbolName: row.symbol_name,
      symbolType: row.symbol_type,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      score,
    } satisfies ChunkResult;
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(r => r.score > 0.05);
}

// ── Prompt formatting ─────────────────────────────────────────────────────────

/**
 * Format retrieved chunks as a compact system prompt section.
 * Grouped by file, with line references.
 */
export function formatChunksForPrompt(chunks: ChunkResult[], projectPath: string): string {
  if (chunks.length === 0) return '';

  const lines: string[] = [
    '',
    '=== SEMANTICALLY RELEVANT CODE (vector context) ===',
    `(Top ${chunks.length} chunks most similar to your message — read before responding)`,
  ];

  // Group by file
  const byFile = new Map<string, ChunkResult[]>();
  for (const c of chunks) {
    const rel = c.filePath.startsWith(projectPath)
      ? c.filePath.slice(projectPath.length).replace(/^[\\/]/, '')
      : c.filePath;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(c);
  }

  for (const [file, fileChunks] of byFile) {
    lines.push('', `--- ${file} ---`);
    for (const chunk of fileChunks) {
      const label = chunk.symbolType !== 'block'
        ? `${chunk.symbolType} \`${chunk.symbolName}\` (L${chunk.startLine}–${chunk.endLine})`
        : `lines ${chunk.startLine}–${chunk.endLine}`;
      lines.push(`// ${label}`);
      // Trim to first 60 lines for prompt brevity
      const trimmed = chunk.content.split('\n').slice(0, 60).join('\n');
      lines.push(trimmed);
    }
  }

  lines.push('', '=== END VECTOR CONTEXT ===');
  return lines.join('\n');
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

export function getChunkStats(projectId: number): { total: number; files: number; indexed_at: string | null } {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) as total, COUNT(DISTINCT file_path) as files, MAX(updated_at) as indexed_at
     FROM code_chunks WHERE project_id = ?`
  ).get(projectId) as { total: number; files: number; indexed_at: string | null };
  return row ?? { total: 0, files: 0, indexed_at: null };
}

export function clearChunkIndex(projectId: number): void {
  getDb().prepare('DELETE FROM code_chunks WHERE project_id = ?').run(projectId);
  projectIndexes.delete(projectId);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function rebuildProjectIndex(projectId: number): void {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, vector_b64, file_path, symbol_name, symbol_type, start_line, end_line FROM code_chunks WHERE project_id = ?'
  ).all(projectId) as Array<{
    id: number; vector_b64: string; file_path: string;
    symbol_name: string; symbol_type: string; start_line: number; end_line: number;
  }>;

  const hnsw = new HNSWIndex(VECTOR_DIMS, 16, 200);
  const idToChunk = new Map<number, { file: string; symbol: string; type: string; startLine: number; endLine: number }>();

  for (const row of rows) {
    try {
      const vec = deserializeVector(row.vector_b64, VECTOR_DIMS);
      hnsw.insert(row.id, vec);
      idToChunk.set(row.id, {
        file: row.file_path, symbol: row.symbol_name, type: row.symbol_type,
        startLine: row.start_line, endLine: row.end_line,
      });
    } catch { /* skip corrupt */ }
  }

  projectIndexes.set(projectId, { hnsw, idToChunk });
  console.log(`[code-chunks] HNSW index rebuilt for project ${projectId}: ${rows.length} chunks`);
}

function readFileLines(filePath: string): string[] | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8').split('\n');
  } catch {
    return null;
  }
}

function walkProject(projectPath: string, callback: (filePath: string) => void): void {
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(fullPath);
      } else if (SUPPORTED_EXTS.has(path.extname(e.name).toLowerCase())) {
        callback(fullPath);
      }
    }
  }
  walk(projectPath);
}

function md5(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}
