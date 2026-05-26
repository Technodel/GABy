/**
 * SUNy Smart File Discovery â€” a `find_files` tool the AI can call proactively
 * to discover relevant files in the project.
 *
 * Supplements the auto-injected repo map by allowing the AI to search for files
 * based on descriptions, patterns, or code concepts.
 *
 * Uses bridge shell commands (glob + grep) to scan the project in real-time.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { sendToBridge, isBridgeConnected } from './bridge-manager';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Discovery methods
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface DiscoveredFile {
  path: string;
  relevance: 'high' | 'medium' | 'low';
  reason: string;
  symbols?: string[];
}

/**
 * Search for files using keywords against paths + contents.
 * Uses a series of grep calls to find relevant files.
 */
async function discoverFiles(
  userId: number,
  projectPath: string,
  description: string,
  filePattern: string,
): Promise<DiscoveredFile[]> {
  if (!isBridgeConnected(userId)) return [];

  const keywords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'are', 'that', 'this', 'with', 'what', 'find', 'look', 'file', 'code'].includes(w));

  if (!keywords.length) return [];

  const results: DiscoveredFile[] = [];
  const seen = new Set<string>();

  try {
    // Strategy 1: Find files with matching NAMES (highest relevance)
    const nameScript = `
const g=require('glob'); const fs=require('fs');
const pattern=${JSON.stringify(filePattern)};
const keywords=${JSON.stringify(keywords)};
const files=g.globSync(pattern,{cwd:${JSON.stringify(projectPath)},nodir:true,absolute:true});
const results=[];
for(const f of files){
  const base=f.split(/[/\\\\]/).pop().toLowerCase().replace(/\\.[^.]+$/,'');
  const matchCount=keywords.filter(k=>base.includes(k)).length;
  if(matchCount>0) results.push({path:require('path').relative(${JSON.stringify(projectPath)},f),score:matchCount});
}
results.sort((a,b)=>b.score-a.score);
console.log(JSON.stringify(results.slice(0,15)));
`.replace(/\n/g, ' ');

    const nameRaw = await sendToBridge(userId, 'exec:shell', {
      command: `node -e "${nameScript.replace(/"/g, '\\"')}"`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 20000) as string;

    try {
      const nameMatches = JSON.parse(nameRaw.trim()) as Array<{ path: string; score: number }>;
      for (const m of nameMatches) {
        if (seen.has(m.path)) continue;
        seen.add(m.path);
        results.push({
          path: m.path,
          relevance: 'high',
          reason: `File name matches keywords: ${keywords.filter(k => m.path.toLowerCase().includes(k)).join(', ')}`,
        });
      }
    } catch { /* ignore parse error */ }

    // Strategy 2: Find files with matching CONTENT (medium relevance)
    const MAX_CONTENT_SCAN = 30;
    if (results.length < MAX_CONTENT_SCAN) {
      for (const kw of keywords.slice(0, 3)) {
        try {
          const raw = await sendToBridge(userId, 'exec:shell', {
            command: `grep -rli --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.go" -m 3 "${kw}" ${JSON.stringify(projectPath)} 2>nul || true`,
            cwd: projectPath,
            requiresConfirmation: false,
          }, 15000) as string;

          if (raw) {
            const lines = raw.trim().split('\n').filter(Boolean);
            for (const line of lines) {
              const relPath = line.replace(projectPath.replace(/\\/g, '/'), '').replace(/^[/\\]/, '') || line;
              if (seen.has(relPath)) continue;
              seen.add(relPath);
              results.push({
                path: relPath,
                relevance: 'medium',
                reason: `Contains keyword "${kw}"`,
              });
              if (results.length >= MAX_CONTENT_SCAN) break;
            }
          }
        } catch { /* grep may fail on some files */ }
      }
    }

    return results.slice(0, 40);
  } catch (err) {
    console.warn('[file-discovery] search error:', (err as Error).message);
    return results;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tool factory
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface FileDiscoveryContext {
  userId: number;
  projectPath: string;
}

export function createFileDiscoveryTool(ctx: FileDiscoveryContext) {
  return tool({
    description:
      'Search the project for files relevant to a specific task or concept. ' +
      'Use this when you need to find files related to a feature, component, or API â€” ' +
      'especially when the repo map alone is not enough. ' +
      'Returns a list of files with relevance scores and explanations.',
    inputSchema: z.object({
      description: z
        .string()
        .min(3)
        .describe(
          'What you are looking for. Be specific: "user authentication", "database models", "API routes for payment". The tool extracts keywords from this description.',
        ),
      file_pattern: z
        .string()
        .optional()
        .default('**/*.{ts,tsx,js,jsx,py,go,rb,rs,java,cs,vue,svelte}')
        .describe(
          'Glob pattern to restrict the search. Default: all source code files.',
        ),
    }),
    execute: async ({ description, file_pattern }) => {
      const files = await discoverFiles(ctx.userId, ctx.projectPath, description, file_pattern);

      if (!files.length) {
        return `No relevant files found for "${description}". Try a different description or check the project structure with list_dir.`;
      }

      const lines: string[] = [
        `## File Discovery: "${description}"`,
        `Found ${files.length} relevant file(s):`,
        '',
      ];

      for (const f of files) {
        const tag = f.relevance === 'high' ? 'ðŸ”' : f.relevance === 'medium' ? 'ðŸ“„' : 'ðŸ“';
        lines.push(`  ${tag} \`${f.path}\``);
        lines.push(`     ${f.reason}`);
        lines.push('');
      }

      return lines.join('\n');
    },
  });
}
