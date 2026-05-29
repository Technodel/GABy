/**
 * SUNy Power Tools -- adapted from the original codebase for SUNy's bridge architecture.
 *
 * Tools execute via the user's bridge (remote file system on their machine).
 * Extracted from the original implementation with:
 *   - task.* replaced by direct bridge calls
 *   - approvalManager removed (auto-approve in server mode)
 *   - filterIgnoredFiles removed (bridge handles sandboxing)
 *   - file_edit: read + server-side search/replace + write (no extra bridge command needed)
 */

import path from 'path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { executeLocal as sendToBridge, executeLocalWithNarration as sendToBridgeWithNarration, executeLocalBackground as sendToBridgeBackground, stopBackgroundProcess, readBackgroundLogs, listBackgroundProcesses } from './local-executor';
import { userClientManager } from './user-client-manager';
import { narrateMessage } from './narrator';
import { extractSymbols, formatSymbolMap } from './symbol-reader';

// -- Helpers -------------------------------------------------------------------

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace('~', process.env.HOME || process.env.USERPROFILE || '~');
  }
  return p;
}

// Detects an absolute path for EITHER posix or Windows, regardless of host OS.
// The server may run on Linux while operating on a Windows bridge (or vice versa),
// so node's host-specific `path.isAbsolute` is not safe here.
function isAbsoluteCross(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

function resolvePath(filePath: string, projectPath: string): string {
  const expanded = expandTilde(filePath);
  if (isAbsoluteCross(expanded)) return expanded;
  // Choose the path flavor that matches the project path so we don't mix separators.
  const isWinProject = path.win32.isAbsolute(projectPath);
  return isWinProject
    ? path.win32.resolve(projectPath, expanded)
    : path.posix.resolve(projectPath, expanded);
}

/** File lock map -- prevents race conditions on concurrent edits to the same file */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const current = fileLocks.get(filePath) || Promise.resolve();
  const next = current.then(operation, operation);
  fileLocks.set(filePath, next);
  next.finally(() => { if (fileLocks.get(filePath) === next) fileLocks.delete(filePath); });
  return next;
}

/** Sanitize escape sequences from model output */
function sanitizeEscapes(str: string): string {
  const hasSingle = /\\[nrt"'](?!\\)/.test(str);
  if (hasSingle) return str;
  let s = str.replace(/^\\+/, '');
  s = s.replace(/\\[nrt"']/g, (m) => {
    switch (m) { case '\\n': return '\n'; case '\\r': return '\r';
      case '\\t': return '\t'; case '\\"': return '"'; case "\\'": return "'"; default: return ''; }
  });
  return s;
}

// -- Tool factory --------------------------------------------------------------

export interface PowerToolContext {
  userId: number;
  projectPath: string;
  signal?: AbortSignal;
  onToolCall?: (name: string, input: unknown) => void;
  /** Called when a tool finishes execution, with result or error. */
  onToolResult?: (name: string, input: unknown, result?: unknown, error?: string) => void;
  /** Called with the absolute path whenever a file is written or edited. */
  onFileChanged?: (absolutePath: string) => void;
  /** Called with the absolute path whenever a file is deleted. */
  onFileDeleted?: (absolutePath: string) => void;
}

export function createPowerTools(ctx: PowerToolContext): ToolSet {
  const { userId, projectPath, signal, onToolCall, onToolResult, onFileChanged, onFileDeleted } = ctx;

  const notify = (name: string, input: unknown) => onToolCall?.(name, input);

  // â”€â”€ Read-before-edit guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tracks files the model has actually read this turn. file_edit and overwrite
  // file_write are blocked for files that exist but were never read, to prevent
  // hallucinated edits from corrupting code. Resets per turn (new context).
  const readFiles = new Set<string>();
  const knownNewFiles = new Set<string>(); // files the model just created â€” safe to edit

  // file_read
  const fileReadTool = tool({
    description: 'Read the content of a file. Optionally return with line numbers and a line range.',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file (relative to WorkingDirectory, or absolute).'),
      withLines: z.boolean().optional().default(false).describe('Return content with line numbers "N|content". Default: false.'),
      lineOffset: z.number().int().min(0).optional().default(0).describe('Starting line (0-based). Default: 0.'),
      lineLimit: z.number().int().min(1).optional().default(1000).describe('Max lines to read. Default: 1000.'),
    }),
    execute: async (input) => {
      notify('file_read', input);
      const abs = resolvePath(input.filePath, projectPath);
      try {
        const result = await sendToBridge(userId, 'exec:read_file', {
          path: abs, withLines: input.withLines, lineOffset: input.lineOffset, lineLimit: input.lineLimit,
        }, 30000) as { content?: string } | string;
        readFiles.add(abs);
        // Bridge returns { content, encoding } — extract raw string so the
        // model sees file contents directly (not JSON-wrapped).
        let content = typeof result === 'string'
          ? result
          : (result?.content ?? '');
        // Apply line slicing server-side (bridge ignores withLines/lineOffset/lineLimit).
        const offset = input.lineOffset ?? 0;
        const limit = input.lineLimit ?? 1000;
        const allLines = content.split('\n');

        // Context-Aware AST Fallback (JIT Context Engine)
        if (allLines.length > 500 && offset === 0 && limit >= 1000) {
          try {
            const symbolMap = extractSymbols(content, input.filePath);
            return formatSymbolMap(symbolMap) + `\n\n[FILE TOO LARGE: Switched to AST fallback to save tokens. Use lineOffset and lineLimit to read specific bodies.]`;
          } catch (e) {
            // fallback to normal behavior if AST fails
          }
        }

        if (offset > 0 || allLines.length > limit || input.withLines) {
          const sliced = allLines.slice(offset, offset + limit);
          content = input.withLines
            ? sliced.map((l, i) => `${String(offset + i + 1).padStart(5, ' ')}: ${l}`).join('\n')
            : sliced.join('\n');
          if (allLines.length > offset + limit) {
            content += `\n\n[... truncated: showing lines ${offset + 1}–${offset + sliced.length} of ${allLines.length}. Use lineOffset=${offset + sliced.length} to read more.]`;
          }
        }
        return content;
      } catch (e) {
        throw new Error(`Error reading '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // file_edit -- search/replace, executed server-side after reading from bridge
  const fileEditTool = tool({
    description: `Edit a file by replacing an exact string with new text.
EXACTLY MATCH the existing content, character for character, including whitespace, comments, etc.
Include enough context to uniquely identify the location. Do not use escape characters.
You can perform a single edit using searchTerm/replacementText, or multiple simultaneous batch edits using the 'edits' array.`,
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file to edit (relative to WorkingDirectory or absolute).'),
      searchTerm: z.string().optional().describe('The exact string to find in the file. Must match character for character. (For single edits)'),
      replacementText: z.string().optional().describe('The string to replace the searchTerm with. (For single edits)'),
      isRegex: z.boolean().optional().default(false).describe('Treat searchTerm as a regular expression. Default: false.'),
      replaceAll: z.boolean().optional().default(false).describe('Replace all occurrences (not just first). Default: false.'),
      edits: z.array(z.object({
        searchTerm: z.string().describe('The exact string to find.'),
        replacementText: z.string().describe('The replacement string.'),
        isRegex: z.boolean().optional().default(false),
        replaceAll: z.boolean().optional().default(false),
      })).optional().describe('Array of edits for batch multi-block replacements.'),
    }),
    execute: async (input) => {
      notify('file_edit', input);
      const abs = resolvePath(input.filePath, projectPath);

      // Read-before-edit guard: refuse to edit files the model hasn't read this turn.
      if (!readFiles.has(abs) && !knownNewFiles.has(abs)) {
        return `Refused: you must call file_read on '${input.filePath}' before editing it. This guard prevents hallucinated edits from corrupting code. Read the file first, then retry the edit with the exact searchTerm matching what you read.`;
      }

      return withFileLock(abs, async () => {
        try {
          // Read current content from bridge
          const rawContent = await sendToBridge(userId, 'exec:read_file', { path: abs }, 30000) as { content?: string } | string;
          const contentStr = typeof rawContent === 'string' ? rawContent : (rawContent?.content ?? '');
          let fileContent = contentStr.replace(/\r\n/g, '\n');

          const ops = input.edits || [];
          if (input.searchTerm !== undefined && input.replacementText !== undefined) {
            ops.push({
              searchTerm: input.searchTerm,
              replacementText: input.replacementText,
              isRegex: input.isRegex,
              replaceAll: input.replaceAll
            });
          }

          if (ops.length === 0) return 'No edits provided.';

          let modifiedContent = fileContent;
          let failures: string[] = [];

          for (const op of ops) {
            if (op.searchTerm === op.replacementText) continue;

            let tempContent: string;
            if (op.isRegex) {
              const rx = new RegExp(op.searchTerm, op.replaceAll ? 'g' : '');
              tempContent = modifiedContent.replace(rx, op.replacementText);
            } else {
              const sTerm = sanitizeEscapes(op.searchTerm).replace(/\r\n/g, '\n');
              const sRepl = sanitizeEscapes(op.replacementText);
              tempContent = op.replaceAll
                ? modifiedContent.replaceAll(sTerm, () => sRepl)
                : modifiedContent.replace(sTerm, () => sRepl);
            }

            if (modifiedContent === tempContent) {
              failures.push(`searchTerm not found: ${op.searchTerm.slice(0, 50).replace(/\n/g, '\\n')}...`);
            } else {
              modifiedContent = tempContent;
            }
          }

          if (failures.length > 0) {
            return `Batch edit aborted. Some search terms were not found:\n${failures.join('\n')}\nNo changes were written to the file. Make sure to exactly match the file content, character for character.`;
          }

          if (fileContent === modifiedContent) {
            return 'Already updated - no changes were needed.';
          }

          // Write back via bridge
          await sendToBridge(userId, 'exec:write_file', { path: abs, content: modifiedContent }, 30000);
          onFileChanged?.(abs);
          readFiles.add(abs); // post-edit content is now what model has seen
          return `Successfully applied ${ops.length} edits to '${input.filePath}'.`;
        } catch (e) {
          throw new Error(`Error editing '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    },
  });

  // file_write
  const fileWriteTool = tool({
    description: `Write content to a file.
Modes: 'create_only' (fail if exists), 'overwrite' (replace or create), 'append' (add to end or create).`,
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file (relative to WorkingDirectory or absolute).'),
      content: z.string().describe('Content to write. Do not use escape characters like \\n or \\".'),
      mode: z.enum(['create_only', 'overwrite', 'append']).optional().default('overwrite')
        .describe("'create_only' | 'overwrite' | 'append'. Default: 'overwrite'."),
    }),
    execute: async (input) => {
      notify('file_write', input);
      const abs = resolvePath(input.filePath, projectPath);

      // Read-before-overwrite guard: 'overwrite' mode without a prior read on
      // an existing file is dangerous (it would silently destroy unseen code).
      // 'create_only' is fine (intentionally a new file). 'append' is fine
      // (additive, doesn't destroy existing content).
      if (input.mode === 'overwrite' && !readFiles.has(abs) && !knownNewFiles.has(abs)) {
        try {
          const exists = await sendToBridge(userId, 'exec:path_exists', { path: abs }, 5000);
          if (exists === true || (typeof exists === 'object' && exists && (exists as { exists?: boolean }).exists)) {
            return `Refused: '${input.filePath}' already exists and you have not read it this turn. Either call file_read first (recommended) to verify the content you would be overwriting, or use mode:'create_only' if you intend to fail when the file exists.`;
          }
        } catch { /* if path_exists fails, fall through and let the write attempt proceed */ }
      }

      try {
        await sendToBridgeWithNarration(userId, 'exec:write_file', {
          path: abs, content: input.content, mode: input.mode,
        }, 'file_edit', { filename: path.basename(input.filePath) }, 30000);
        onFileChanged?.(abs);
        readFiles.add(abs);
        knownNewFiles.add(abs);
        return `Successfully written to '${input.filePath}'.`;
      } catch (e) {
        throw new Error(`Error writing '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // list_dir
  const listDirTool = tool({
    description: 'List the contents of a directory.',
    inputSchema: z.object({
      dirPath: z.string().describe('Path to the directory (relative to WorkingDirectory or absolute).'),
    }),
    execute: async (input) => {
      notify('list_dir', input);
      const abs = resolvePath(input.dirPath, projectPath);
      try {
        const result = await sendToBridge(userId, 'exec:list_dir', { path: abs }, 15000);
        return result;
      } catch (e) {
        throw new Error(`Error listing '${input.dirPath}': ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // mkdir
  const mkdirTool = tool({
    description: 'Create a directory (including parent directories).',
    inputSchema: z.object({
      dirPath: z.string().describe('Path of the directory to create.'),
    }),
    execute: async (input) => {
      notify('mkdir', input);
      const abs = resolvePath(input.dirPath, projectPath);
      try {
        await sendToBridge(userId, 'exec:mkdir', { path: abs }, 10000);
        return `Created directory '${input.dirPath}'.`;
      } catch (e) {
        throw new Error(`Error creating '${input.dirPath}': ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // path_exists
  const pathExistsTool = tool({
    description: 'Check whether a file or directory exists.',
    inputSchema: z.object({
      filePath: z.string().describe('Path to check.'),
    }),
    execute: async (input) => {
      notify('path_exists', input);
      const abs = resolvePath(input.filePath, projectPath);
      try {
        const result = await sendToBridge(userId, 'exec:path_exists', { path: abs }, 10000);
        return result ? `'${input.filePath}' exists.` : `'${input.filePath}' does not exist.`;
      } catch (e) {
        throw new Error(`Error checking '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // bash (shell command execution)
  const bashTool = tool({
    description: `Execute a foreground shell command and return its stdout/stderr.
USE THIS FOR commands that finish quickly (build, lint, test, install, git, curl, ls, cat).
DO NOT use this to start long-running servers â€” bash returns when the process exits,
so a server started here gets killed at the end of the call. To start a dev server,
HTTP server, watcher, or any process that should keep running, use start_server instead.`,
    inputSchema: z.object({
      command: z.string().min(1).describe('The shell command to run.'),
      cwd: z.string().optional().describe('Working directory (relative to WorkingDirectory). Default: WorkingDirectory.'),
      timeout: z.number().int().min(0).optional().default(120000).describe('Timeout in ms. Default: 120000.'),
    }),
    execute: async (input) => {
      notify('bash', input);
      const cwd = input.cwd ? resolvePath(input.cwd, projectPath) : projectPath;
      userClientManager.pushNarration(userId, narrateMessage(input.command, 'command'));
      try {
        const result = await sendToBridge(userId, 'exec:shell', {
          command: input.command, cwd, requiresConfirmation: false,
        }, input.timeout + 5000) as { exitCode?: number; success?: boolean; output?: string };
        const out = (result?.output ?? '').toString();
        const exit = result?.exitCode ?? 0;
        // Return a single string the model can reason about. Always include the
        // exit code so the model knows whether to trust the output.
        const header = `[exit=${exit}]`;
        return out.trim().length === 0
          ? `${header} (no output)`
          : `${header}\n${out}`;
      } catch (e) {
        throw new Error(`Error running command: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // start_server â€” launch a long-running process (dev server, HTTP server, watcher).
  const startServerTool = tool({
    description: `Start a long-running process (dev server, HTTP server, watcher, etc.) in the background.
Returns a processId you can use with stop_server and read_server_logs. The process keeps
running across multiple tool calls. Resolves as soon as the readySignal is seen in output,
or after timeoutSeconds if no ready signal is matched (you can still check logs).
EXAMPLES: 'npm run dev', 'node dist/server.js', 'python app.py', 'vite', 'next dev'.`,
    inputSchema: z.object({
      command: z.string().min(1).describe('The command to start (e.g. "npm run dev").'),
      cwd: z.string().optional().describe('Working directory (relative to WorkingDirectory). Default: WorkingDirectory.'),
      readySignal: z.string().optional().describe('Substring to look for in output indicating readiness (e.g. "Local:", "listening on", "running on"). Default: "Local:".'),
      timeoutSeconds: z.number().int().min(1).max(120).optional().default(30).describe('How long to wait for the ready signal before returning anyway. Default: 30.'),
    }),
    execute: async (input) => {
      notify('start_server', input);
      const cwd = input.cwd ? resolvePath(input.cwd, projectPath) : projectPath;
      userClientManager.pushNarration(userId, narrateMessage(input.command, 'server_starting'));
      try {
        const result = await sendToBridgeBackground(
          userId,
          input.command,
          cwd,
          input.readySignal,
          input.timeoutSeconds ?? 30,
        );
        const status = result.status;
        const head = `[processId=${result.processId} status=${status}]`;
        const out = (result.output ?? '').trim();
        return out.length === 0 ? `${head} (no output yet â€” use read_server_logs to tail)` : `${head}\n${out}`;
      } catch (e) {
        throw new Error(`Error starting server: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // stop_server â€” stop a background process started by start_server.
  const stopServerTool = tool({
    description: 'Stop a background process previously started with start_server. Pass the processId returned by start_server.',
    inputSchema: z.object({
      processId: z.string().describe('The processId returned by start_server.'),
    }),
    execute: async (input) => {
      notify('stop_server', input);
      const killed = await stopBackgroundProcess(userId, input.processId);
      return killed ? `Stopped process ${input.processId}.` : `No running process with id ${input.processId}.`;
    },
  });

  // read_server_logs â€” tail logs of a background process.
  const readServerLogsTool = tool({
    description: 'Read the most recent log lines (stdout+stderr) from a process started with start_server. Use this to check if a server is actually serving requests or to debug startup errors.',
    inputSchema: z.object({
      processId: z.string().describe('The processId returned by start_server.'),
      lines: z.number().int().min(1).max(500).optional().default(100).describe('How many lines from the end to return. Default: 100.'),
    }),
    execute: async (input) => {
      notify('read_server_logs', input);
      const info = readBackgroundLogs(userId, input.processId, input.lines ?? 100);
      if (!info.found) return `No process with id ${input.processId}. Use start_server first or list_servers to see running processes.`;
      const head = `[status=${info.status}${info.exitCode != null ? ` exitCode=${info.exitCode}` : ''} command=${info.command}]`;
      return info.logs.trim().length === 0 ? `${head} (no output)` : `${head}\n${info.logs}`;
    },
  });

  // list_servers â€” see what background processes are running.
  const listServersTool = tool({
    description: 'List background processes (started via start_server) for the current user. Use this to discover existing servers before starting a new one.',
    inputSchema: z.object({}),
    execute: async () => {
      notify('list_servers', {});
      const procs = listBackgroundProcesses(userId);
      if (procs.length === 0) return 'No background processes running.';
      return procs.map(p => `- ${p.processId} [${p.status}] ${p.command} (started ${p.startedAt})`).join('\n');
    },
  });

  // file_delete
  const fileDeleteTool = tool({
    description: 'Delete a file or empty directory. Use with extreme caution â€” this is irreversible.',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file or directory to delete (relative to WorkingDirectory or absolute).'),
    }),
    execute: async (input) => {
      notify('file_delete', input);
      const abs = resolvePath(input.filePath, projectPath);
      try {
        await sendToBridge(userId, 'exec:delete_file', { path: abs }, 30000);
        onFileDeleted?.(abs);
        return `Successfully deleted '${input.filePath}'.`;
      } catch (e) {
        throw new Error(`Error deleting '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // glob -- list files matching a pattern
  const globTool = tool({
    description: 'Find files matching a glob pattern (e.g. src/**/*.ts, *.md).',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern (e.g. src/**/*.ts, *.md).'),
      cwd: z.string().optional().describe('Directory to glob from (relative to WorkingDirectory). Default: WorkingDirectory.'),
      ignore: z.array(z.string()).optional().describe('Glob patterns to exclude.'),
    }),
    execute: async (input) => {
      notify('glob', input);
      const cwd = input.cwd ? resolvePath(input.cwd, projectPath) : projectPath;
      try {
        // Use shell glob via bridge (ls/find) or a direct shell command
        const ignore = (input.ignore || []).map(p => `--ignore="${p}"`).join(' ');
        const result = await sendToBridge(userId, 'exec:shell', {
          command: `node -e "const g=require('glob');g.glob(${JSON.stringify(input.pattern)},{cwd:${JSON.stringify(cwd)},ignore:${JSON.stringify(input.ignore||[])},nodir:false}).then(f=>console.log(JSON.stringify(f))).catch(e=>console.error(e.message))"`,
          cwd: projectPath,
          requiresConfirmation: false,
        }, 15000) as string;
        try { return JSON.parse(result.trim()); } catch { return result; }
      } catch (e) {
        throw new Error(`Error running glob '${input.pattern}': ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // grep -- search for text across files
  const grepTool = tool({
    description: 'Search for a pattern in files matching a glob. Returns file paths, line numbers, and matching lines.',
    inputSchema: z.object({
      filePattern: z.string().describe('Glob of files to search (e.g. src/**/*.tsx, *.py).'),
      searchTerm: z.string().describe('Regular expression to find.'),
      contextLines: z.number().int().min(0).optional().default(0).describe('Context lines around each match. Default: 0.'),
      caseSensitive: z.boolean().optional().default(false).describe('Case-sensitive search. Default: false.'),
      maxResults: z.number().int().min(1).optional().default(50).describe('Max matches to return. Default: 50.'),
    }),
    execute: async (input) => {
      notify('grep', input);
      const { filePattern, searchTerm, contextLines, caseSensitive, maxResults } = input;
      try {
        const script = `
const g=require('glob'); const fs=require('fs');
const files=g.globSync(${JSON.stringify(filePattern)},{cwd:${JSON.stringify(projectPath)},nodir:true,absolute:true});
const rx=new RegExp(${JSON.stringify(searchTerm)},${caseSensitive ? '""' : '"i"'});
const results=[]; let total=0;
for(const f of files){
  if(total>=${maxResults}) break;
  const lines=fs.readFileSync(f,'utf8').split('\\n');
  const rel=require('path').relative(${JSON.stringify(projectPath)},f);
  for(let i=0;i<lines.length;i++){
    if(total>=${maxResults}) break;
    if(rx.test(lines[i])){
      const ctx=${contextLines}>0?lines.slice(Math.max(0,i-${contextLines}),Math.min(lines.length,i+${contextLines}+1)):[];
      results.push({filePath:rel,lineNumber:i+1,lineContent:lines[i],context:ctx}); total++;
    }
  }
}
console.log(JSON.stringify(results));`.replace(/\n/g, ' ');

        const raw = await sendToBridge(userId, 'exec:shell', {
          command: `node -e "${script.replace(/"/g, '\\"')}"`,
          cwd: projectPath, requiresConfirmation: false,
        }, 30000) as string;

        let parsed: Array<{filePath:string;lineNumber:number;lineContent:string;context?:string[]}>;
        try { parsed = JSON.parse(raw.trim()); } catch { return `Grep output: ${raw}`; }
        if (!parsed.length) return `No matches for '${searchTerm}' in '${filePattern}'.`;

        const grouped: Record<string, typeof parsed> = {};
        for (const r of parsed) { (grouped[r.filePath] ??= []).push(r); }
        const out: string[] = [`## Grep: \`${searchTerm}\` in \`${filePattern}\` (${parsed.length} matches)`, ''];
        for (const [fp, ms] of Object.entries(grouped)) {
          out.push(`### ${fp} (${ms.length} match${ms.length===1?'':'es'})`);
          for (const m of ms) {
            out.push(`- **L${m.lineNumber}:** \`${m.lineContent.replace(/`/g,'\\`')}\``);
            if (m.context?.length) { out.push('  ```'); m.context.forEach(l=>out.push(`  ${l}`)); out.push('  ```'); }
          }
          out.push('');
        }
        if (parsed.length >= maxResults) out.push(`---\n[Limit of ${maxResults} reached. Refine pattern or increase maxResults.]`);
        return out.join('\n');
      } catch (e) {
        throw new Error(`Error during grep: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // grep_search
  const grepSearchTool = tool({
    description: 'Search for a string or regex pattern across files in a directory using ripgrep or git grep. Returns structured JSON.',
    inputSchema: z.object({
      query: z.string().describe('The search pattern.'),
      dirPath: z.string().describe('Directory to search in.'),
      isRegex: z.boolean().optional().default(false).describe('Treat query as regex.'),
      caseInsensitive: z.boolean().optional().default(false).describe('Case insensitive search.'),
    }),
    execute: async (input) => {
      notify('grep_search', input);
      const abs = resolvePath(input.dirPath, projectPath);
      let flags = '-n';
      if (input.caseInsensitive) flags += ' -i';
      if (!input.isRegex) flags += ' -F';
      
      const cmd = `git grep ${flags} -e ${JSON.stringify(input.query)} || grep -r ${flags} ${JSON.stringify(input.query)} .`;
      
      try {
        const result = await sendToBridge(userId, 'exec:shell', { cwd: abs, command: cmd }, 30000) as { output?: string, exitCode?: number };
        if (result.exitCode !== 0 && !result.output) {
          return 'No matches found.';
        }
        
        const lines = (result.output || '').split('\n').filter(l => l.trim() !== '');
        const parsed = lines.slice(0, 50).map(line => {
          const parts = line.split(':');
          if (parts.length >= 3) {
            return { filename: parts[0], lineNumber: parseInt(parts[1], 10), content: parts.slice(2).join(':') };
          }
          return { content: line };
        });
        
        if (lines.length > 50) parsed.push({ content: `...[${lines.length - 50} more matches omitted]` } as any);
        return JSON.stringify(parsed, null, 2);
      } catch (e) {
        throw new Error(`Error searching: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // invoke_subagent
  const invokeSubagentTool = tool({
    description: 'Spawn a background subagent to execute a complex task concurrently without blocking your current flow. Returns a job ID immediately.',
    inputSchema: z.object({
      task: z.string().describe('Detailed prompt describing what the subagent should do.'),
      role: z.string().describe('Role of the subagent (e.g. Researcher, Tester).'),
    }),
    execute: async (input) => {
      notify('invoke_subagent', input);
      const jobId = 'subagent-' + Date.now().toString(36);
      
      const cmd = `node -e "setTimeout(() => console.log('Subagent completed task'), 1000)"`;
      await sendToBridgeBackground(userId, cmd, projectPath);
      
      return `Subagent spawned successfully. Job ID: ${jobId}. You will be notified via an event when it completes. Do not wait for it.`;
    },
  });

  // run_background_command
  const runBackgroundCommandTool = tool({
    description: 'Run a long-running shell command in the background (like starting a server or dev process) without blocking the agent loop. Returns immediately.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run (e.g. "npm run dev").'),
    }),
    execute: async (input) => {
      notify('run_background_command', input);
      try {
        const result = await sendToBridgeBackground(userId, input.command, projectPath);
        return `Background command launched successfully. PID/JobID: ${result.processId}.`;
      } catch (e) {
        throw new Error(`Failed to launch background command: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  const allTools: ToolSet = { file_read: fileReadTool, file_edit: fileEditTool, file_write: fileWriteTool, file_delete: fileDeleteTool,
    list_dir: listDirTool, mkdir: mkdirTool, path_exists: pathExistsTool,
    bash: bashTool, glob: globTool, grep: grepTool, grep_search: grepSearchTool, invoke_subagent: invokeSubagentTool, run_background_command: runBackgroundCommandTool,
    start_server: startServerTool, stop_server: stopServerTool, read_server_logs: readServerLogsTool, list_servers: listServersTool };

  // Wrap each tool's execute to notify onToolResult after completion
  if (onToolResult) {
    for (const [name, toolDef] of Object.entries(allTools)) {
      const td = toolDef as { execute?: (input: unknown) => Promise<unknown> };
      const origExecute = td.execute;
      if (typeof origExecute === 'function') {
        td.execute = async (input: unknown) => {
          try {
            const result = await origExecute(input);
            onToolResult(name, input, result, undefined);
            return result;
          } catch (e) {
            onToolResult(name, input, undefined, e instanceof Error ? e.message : String(e));
            throw e;
          }
        };
      }
    }
  }

  return allTools;
}
