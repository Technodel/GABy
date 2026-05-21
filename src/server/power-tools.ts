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
import { sendToBridge, sendToBridgeWithNarration } from './bridge-manager';
import { userClientManager } from './user-client-manager';

// -- Helpers -------------------------------------------------------------------

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace('~', process.env.HOME || process.env.USERPROFILE || '~');
  }
  return p;
}

function resolvePath(filePath: string, projectPath: string): string {
  const expanded = expandTilde(filePath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(projectPath, expanded);
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

  // ── Read-before-edit guard ──────────────────────────────────────────────
  // Tracks files the model has actually read this turn. file_edit and overwrite
  // file_write are blocked for files that exist but were never read, to prevent
  // hallucinated edits from corrupting code. Resets per turn (new context).
  const readFiles = new Set<string>();
  const knownNewFiles = new Set<string>(); // files the model just created — safe to edit

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
        }, 30000);
        readFiles.add(abs);
        return result as string;
      } catch (e) {
        return `Error reading '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // file_edit -- search/replace, executed server-side after reading from bridge
  const fileEditTool = tool({
    description: `Edit a file by replacing an exact string with new text.
EXACTLY MATCH the existing content, character for character, including whitespace, comments, etc.
Include enough context to uniquely identify the location. Do not use escape characters.`,
    inputSchema: z.object({
      filePath: z.string().describe('Path to the file to edit (relative to WorkingDirectory or absolute).'),
      searchTerm: z.string().describe('The exact string to find in the file. Must match character for character.'),
      replacementText: z.string().describe('The string to replace the searchTerm with.'),
      isRegex: z.boolean().optional().default(false).describe('Treat searchTerm as a regular expression. Default: false.'),
      replaceAll: z.boolean().optional().default(false).describe('Replace all occurrences (not just first). Default: false.'),
    }),
    execute: async (input) => {
      notify('file_edit', input);
      if (input.searchTerm === input.replacementText) return 'Already updated - no changes were needed.';

      const abs = resolvePath(input.filePath, projectPath);

      // Read-before-edit guard: refuse to edit files the model hasn't read this turn.
      if (!readFiles.has(abs) && !knownNewFiles.has(abs)) {
        return `Refused: you must call file_read on '${input.filePath}' before editing it. This guard prevents hallucinated edits from corrupting code. Read the file first, then retry the edit with the exact searchTerm matching what you read.`;
      }

      return withFileLock(abs, async () => {
        try {
          // Read current content from bridge
          const rawContent = await sendToBridge(userId, 'exec:read_file', { path: abs }, 30000);
          let fileContent = (rawContent as string).replace(/\r\n/g, '\n');

          let modifiedContent: string;
          if (input.isRegex) {
            const rx = new RegExp(input.searchTerm, input.replaceAll ? 'g' : '');
            modifiedContent = fileContent.replace(rx, input.replacementText);
          } else {
            const sTerm = sanitizeEscapes(input.searchTerm).replace(/\r\n/g, '\n');
            const sRepl = sanitizeEscapes(input.replacementText);
            modifiedContent = input.replaceAll
              ? fileContent.replaceAll(sTerm, () => sRepl)
              : fileContent.replace(sTerm, () => sRepl);
          }

          if (fileContent === modifiedContent) {
            const hint = input.searchTerm.startsWith('\\\n')
              ? 'Do not start the search term with a backslash character.'
              : input.searchTerm.includes('\\"')
                ? 'Do not use \\" � use plain " instead.'
                : 'Make sure to exactly match the file content, character for character.';
            return `Warning: searchTerm not found in file. No changes made. ${hint}`;
          }

          // Write back via bridge
          await sendToBridge(userId, 'exec:write_file', { path: abs, content: modifiedContent }, 30000);
          onFileChanged?.(abs);
          readFiles.add(abs); // post-edit content is now what model has seen
          return `Successfully edited '${input.filePath}'.`;
        } catch (e) {
          return `Error editing '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`;
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
        return `Error writing '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`;
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
        return `Error listing '${input.dirPath}': ${e instanceof Error ? e.message : String(e)}`;
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
        return `Error creating '${input.dirPath}': ${e instanceof Error ? e.message : String(e)}`;
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
        return `Error checking '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // bash (shell command execution)
  const bashTool = tool({
    description: 'Execute a shell command in the project directory.',
    inputSchema: z.object({
      command: z.string().min(1).describe('The shell command to run.'),
      cwd: z.string().optional().describe('Working directory (relative to WorkingDirectory). Default: WorkingDirectory.'),
      timeout: z.number().int().min(0).optional().default(120000).describe('Timeout in ms. Default: 120000.'),
    }),
    execute: async (input) => {
      notify('bash', input);
      const cwd = input.cwd ? resolvePath(input.cwd, projectPath) : projectPath;
      userClientManager.pushNarration(userId, 'Running command...');
      try {
        const result = await sendToBridge(userId, 'exec:shell', {
          command: input.command, cwd, requiresConfirmation: false,
        }, input.timeout + 5000);
        return result as string;
      } catch (e) {
        return `Error running command: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // file_delete
  const fileDeleteTool = tool({
    description: 'Delete a file or empty directory. Use with extreme caution — this is irreversible.',
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
        return `Error deleting '${input.filePath}': ${e instanceof Error ? e.message : String(e)}`;
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
        return `Error running glob '${input.pattern}': ${e instanceof Error ? e.message : String(e)}`;
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
        return `Error during grep: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const allTools: ToolSet = { file_read: fileReadTool, file_edit: fileEditTool, file_write: fileWriteTool, file_delete: fileDeleteTool,
    list_dir: listDirTool, mkdir: mkdirTool, path_exists: pathExistsTool,
    bash: bashTool, glob: globTool, grep: grepTool };

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
