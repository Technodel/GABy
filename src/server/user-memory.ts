/**
 * SUNy User Memory Tool — persistent fact storage via SQLite.
 *
 * The AI can save and recall user-specific facts (preferences, project context,
 * decisions) across sessions using the existing user_memories table.
 *
 * Two tools:
 *   save_memory  – save a fact
 *   recall_memories – retrieve all saved facts
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getAdapter } from './db';

// -- Tool factory -------------------------------------------------------------

export interface MemoryToolContext {
  userId: number;
  projectPath?: string;
}

export async function createMemoryTools(ctx: MemoryToolContext) {
  const { userId, projectPath } = ctx;

  // Determine project_id if we have a project path
  let projectId: number | null = null;
  if (projectPath) {
    const db = await getAdapter();
    const row = await db.get<{ id: number }>(
      'SELECT id FROM projects WHERE user_id = ? AND local_path = ?',
      [userId, projectPath],
    );
    if (row) projectId = row.id;
  }

  const saveMemoryTool = tool({
    description:
      'Save a fact or piece of information to long-term memory. Use this when the user tells you something they want you to remember (preferences, important context, decisions, personal details). The fact will persist across conversations.',
    inputSchema: z.object({
      fact: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          'The fact or information to remember. Should be a clear, self-contained statement (e.g., "User prefers tabs over spaces").',
        ),
      category: z
        .string()
        .max(100)
        .optional()
        .default('general')
        .describe(
          'Optional category: "general", "preference", "decision", "project_context", "personal".',
        ),
    }),
    execute: async ({ fact, category }) => {
      const tagged = category !== 'general' ? `[${category}] ${fact}` : fact;

      const db = await getAdapter();
      await db.run(
        'INSERT INTO user_memories (user_id, project_id, content) VALUES (?, ?, ?)',
        [userId, projectId, tagged],
      );

      return `✅ Saved: "${fact}"`;
    },
  });

  const recallMemoriesTool = tool({
    description:
      'Recall saved facts from memory. Returns all stored facts for this user/project. Use this at the start of a conversation or when you need to remember user preferences.',
    inputSchema: z.object({
      category: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Optional category filter: "general", "preference", "decision", "project_context", "personal". Returns all if omitted.',
        ),
    }),
    execute: async ({ category }) => {
      const db = await getAdapter();
      let rows: Array<{ id: number; content: string; created_at: string }>;

      if (projectId) {
        rows = await db.all<{ id: number; content: string; created_at: string }>(
          'SELECT id, content, created_at FROM user_memories WHERE user_id = ? AND (project_id = ? OR project_id IS NULL) ORDER BY created_at DESC',
          [userId, projectId],
        );
      } else {
        rows = await db.all<{ id: number; content: string; created_at: string }>(
          'SELECT id, content, created_at FROM user_memories WHERE user_id = ? ORDER BY created_at DESC',
          [userId],
        );
      }

      if (category) {
        rows = rows.filter((r) =>
          r.content.startsWith(`[${category}]`),
        );
      }

      if (rows.length === 0) {
        return 'No saved memories found.' + (category ? ` (filtered by category: ${category})` : '');
      }

      const lines = rows.map(
        (r, i) => `${i + 1}. ${r.content.replace(/^\[.*?\]\s*/, '')}`,
      );
      return `📋 Saved memories (${rows.length}):\n${lines.join('\n')}`;
    },
  });

  const deleteMemoryTool = tool({
    description:
      'Delete a specific memory by its ID number. Use recall_memories first to find the ID.',
    inputSchema: z.object({
      id: z.number().int().positive().describe('The ID of the memory to delete.'),
    }),
    execute: async ({ id }) => {
      const db = await getAdapter();
      await db.run('DELETE FROM user_memories WHERE id = ? AND user_id = ?', [id, userId]);
      return `✅ Deleted memory #${id}.`;
    },
  });

  return {
    save_memory: saveMemoryTool,
    recall_memories: recallMemoriesTool,
    delete_memory: deleteMemoryTool,
  };
}
