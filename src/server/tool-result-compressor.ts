/**
 * tool-result-compressor.ts — RTK-style lossless token savings for tool outputs.
 *
 * Compresses verbose tool results (git diff, grep, ls, tree, shell output) before
 * they are sent to the LLM. The original result is NEVER returned to the user —
 * only the LLM sees the compressed form. Billing tokens are based on what actually
 * goes to the provider, so this reduces our API costs without changing user pricing.
 *
 * Design principles:
 *   - Lossless: no semantic information removed, only redundant formatting
 *   - Safe: if any filter throws, the original is returned unchanged
 *   - Fast: no async, no external deps — pure string transforms
 *   - Composable: multiple filters can chain on one result
 */

// Minimum size before we bother compressing (small results aren't worth it)
const MIN_COMPRESS_BYTES = 500;

// ── Filters ──────────────────────────────────────────────────────────────────

/**
 * Git diff compressor.
 * Removes unchanged context lines (lines starting with a space) beyond 2 lines
 * of context around each hunk. Preserves all +/- lines and hunk headers.
 */
function compressGitDiff(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let contextBuffer: string[] = [];
  let skippedContext = 0;

  for (const line of lines) {
    const isContext = line.startsWith(' ');
    const isChange = line.startsWith('+') || line.startsWith('-');
    const isMeta = line.startsWith('diff ') || line.startsWith('index ') ||
                   line.startsWith('---') || line.startsWith('+++') ||
                   line.startsWith('@@') || line.startsWith('\\');

    if (isMeta || isChange) {
      if (skippedContext > 0) {
        out.push(`[...${skippedContext} unchanged lines omitted...]`);
        skippedContext = 0;
      }
      if (contextBuffer.length > 0) {
        out.push(...contextBuffer);
        contextBuffer = [];
      }
      out.push(line);
    } else if (isContext) {
      contextBuffer.push(line);
      if (contextBuffer.length > 2) {
        skippedContext++;
        contextBuffer.shift();
      }
    } else {
      if (skippedContext > 0) {
        out.push(`[...${skippedContext} unchanged lines omitted...]`);
        skippedContext = 0;
      }
      out.push(...contextBuffer);
      contextBuffer = [];
      out.push(line);
    }
  }
  if (skippedContext > 0) out.push(`[...${skippedContext} unchanged lines omitted...]`);
  return out.join('\n');
}

/**
 * Dedup-log compressor.
 * Collapses consecutive identical or near-identical log lines.
 * e.g. 200 lines of "WARN: retry attempt N" → "WARN: retry attempt 1 [×200]"
 */
function deduplicateLogLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let prev = '';
  let count = 1;

  for (const line of lines) {
    // Normalise numbers so "attempt 3" and "attempt 7" are treated as duplicates
    const normalised = line.replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();
    const prevNorm = prev.replace(/\b\d+\b/g, 'N').replace(/\s+/g, ' ').trim();

    if (normalised === prevNorm && normalised.length > 0) {
      count++;
    } else {
      if (count > 1) out.push(`${prev} [×${count}]`);
      else if (prev !== '') out.push(prev);
      prev = line;
      count = 1;
    }
  }
  if (count > 1) out.push(`${prev} [×${count}]`);
  else if (prev !== '') out.push(prev);

  return out.join('\n');
}

/**
 * Smart truncator for very long single-block outputs.
 * Keeps the first 40% and last 20% of lines, inserts a summary in between.
 * Only applied when the block exceeds MAX_LINES_BEFORE_TRUNCATE.
 */
const MAX_LINES_BEFORE_TRUNCATE = 300;
function smartTruncate(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_LINES_BEFORE_TRUNCATE) return text;

  const keepHead = Math.floor(MAX_LINES_BEFORE_TRUNCATE * 0.6);
  const keepTail = Math.floor(MAX_LINES_BEFORE_TRUNCATE * 0.2);
  const omitted = lines.length - keepHead - keepTail;

  return [
    ...lines.slice(0, keepHead),
    `\n[...${omitted} lines omitted for brevity — full output available if needed...]\n`,
    ...lines.slice(lines.length - keepTail),
  ].join('\n');
}

/**
 * Grep output compressor.
 * When grep returns many results for the same file, collapses runs of
 * matches from the same file into a summary after N matches.
 */
const MAX_MATCHES_PER_FILE = 20;
function compressGrepOutput(text: string): string {
  const lines = text.split('\n');
  // grep -n format: "filename:linenum:content" or "filename:content"
  const fileCounts = new Map<string, number>();
  const out: string[] = [];

  for (const line of lines) {
    if (!line.trim()) { out.push(line); continue; }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { out.push(line); continue; }
    const file = line.slice(0, colonIdx);
    const count = (fileCounts.get(file) ?? 0) + 1;
    fileCounts.set(file, count);
    if (count <= MAX_MATCHES_PER_FILE) {
      out.push(line);
    } else if (count === MAX_MATCHES_PER_FILE + 1) {
      out.push(`[...additional matches in ${file} omitted...]`);
    }
  }
  return out.join('\n');
}

/**
 * Directory listing compressor (ls / find / tree).
 * Collapses long lists of files in the same directory.
 */
const MAX_FILES_PER_DIR = 30;
function compressFileList(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_FILES_PER_DIR * 2) return text;

  // Group by directory prefix
  const dirCounts = new Map<string, number>();
  const out: string[] = [];

  for (const line of lines) {
    if (!line.trim()) { out.push(line); continue; }
    // Extract directory part
    const lastSlash = Math.max(line.lastIndexOf('/'), line.lastIndexOf('\\'));
    const dir = lastSlash >= 0 ? line.slice(0, lastSlash) : '';
    const count = (dirCounts.get(dir) ?? 0) + 1;
    dirCounts.set(dir, count);
    if (count <= MAX_FILES_PER_DIR) {
      out.push(line);
    } else if (count === MAX_FILES_PER_DIR + 1) {
      out.push(`[...${dir || 'root'}: additional files omitted...]`);
    }
  }
  return out.join('\n');
}

// ── Detection ─────────────────────────────────────────────────────────────────

type FilterType = 'git-diff' | 'grep' | 'file-list' | 'log-dedup' | 'truncate';

function detectFilter(text: string): FilterType[] {
  const peek = text.slice(0, 1024);
  const filters: FilterType[] = [];

  if (/^diff --git /m.test(peek) || /^@@\s+-\d+/.test(peek)) {
    filters.push('git-diff');
  }
  if (/^[^\s:]+:\d+:/.test(peek) || /^Binary file .+ matches/m.test(peek)) {
    filters.push('grep');
  }
  if (/^[./\\].*[/\\]/.test(peek) && text.split('\n').length > 40) {
    filters.push('file-list');
  }
  // Log-dedup: repetitive lines with timestamps/numbers
  if (/(\d{2}:\d{2}:\d{2}|\[INFO\]|\[WARN\]|\[ERROR\]|ERROR:|WARN:|INFO:)/.test(peek)) {
    filters.push('log-dedup');
  }
  // Always apply truncation as last resort for very long outputs
  if (text.split('\n').length > MAX_LINES_BEFORE_TRUNCATE) {
    filters.push('truncate');
  }

  return filters;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compress a single tool result string.
 * Returns the original if: smaller than MIN_COMPRESS_BYTES, no filter matched,
 * any filter threw an error, or the result would be larger than the original.
 */
export function compressToolResult(text: string): string {
  if (!text || text.length < MIN_COMPRESS_BYTES) return text;

  const filters = detectFilter(text);
  if (filters.length === 0) return text;

  try {
    let result = text;

    if (filters.includes('git-diff')) result = compressGitDiff(result);
    if (filters.includes('grep'))     result = compressGrepOutput(result);
    if (filters.includes('file-list')) result = compressFileList(result);
    if (filters.includes('log-dedup')) result = deduplicateLogLines(result);
    if (filters.includes('truncate')) result = smartTruncate(result);

    // Safety: never return something larger than what we started with
    return result.length < text.length ? result : text;
  } catch {
    return text;
  }
}

/**
 * Walk a CoreMessage content array and compress any tool-result parts in place.
 * Returns a new array (does not mutate the original).
 */
export function compressToolResultsInContent(
  content: unknown,
): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  return content.map((part: any) => {
    if (part?.type === 'tool-result') {
      const raw = typeof part.content === 'string'
        ? part.content
        : Array.isArray(part.content)
          ? part.content.map((c: any) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c))).join('\n')
          : JSON.stringify(part.content ?? '');

      const compressed = compressToolResult(raw);
      if (compressed === raw) return part;

      // Preserve original structure — just replace the text content
      if (typeof part.content === 'string') {
        return { ...part, content: compressed };
      }
      if (Array.isArray(part.content)) {
        return { ...part, content: [{ type: 'text', text: compressed }] };
      }
    }
    return part;
  });
}
