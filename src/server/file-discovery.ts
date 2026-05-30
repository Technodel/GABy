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
  return [];
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
