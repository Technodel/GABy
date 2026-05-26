/**
 * SUNy Prompt Variants â€” A/B testing and persona-driven prompt templates.
 *
 * Extends the registry with reusable variant sets that can be assigned
 * per user or per session. Supports:
 *   - Persona variants (e.g. "senior-engineer", "teacher", "concise")
 *   - Tone variants (e.g. "formal", "casual", "encouraging")
 *   - Strategy variants (e.g. "test-first", "refactor-first", "direct")
 *   - A/B experiment assignment per user
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type PromptVariantType = 'persona' | 'tone' | 'strategy' | 'custom';

export interface PromptVariant {
  id: number;
  type: PromptVariantType;
  key: string;
  label: string;
  content: string;
  description: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PromptVariantAssignment {
  user_id: number;
  variant_key: string;
  variant_type: PromptVariantType;
  assigned_at: string;
}

// â”€â”€ Built-in variants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const BUILTIN_VARIANTS: Record<string, {
  type: PromptVariantType;
  label: string;
  description: string;
  content: string;
}> = {
  // Persona variants
  'persona:senior-engineer': {
    type: 'persona',
    label: 'Senior Engineer',
    description: 'Speaks like a principal engineer â€” direct, technical, assumes competence',
    content: 'You are a senior staff engineer mentoring a peer. Be direct, technically precise, and assume the user understands engineering concepts. Use precise terminology. Prioritize production-quality solutions. Challenge assumptions when warranted.',
  },
  'persona:teacher': {
    type: 'persona',
    label: 'Patient Teacher',
    description: 'Explains concepts thoroughly with examples and rationale',
    content: 'You are a patient instructor. Explain concepts step-by-step with concrete examples. Always explain WHY before WHAT. Check for understanding. Encourage questions. Never assume prior knowledge of the specific topic.',
  },
  'persona:concise': {
    type: 'persona',
    label: 'Ultra Concise',
    description: 'Short, direct answers â€” no fluff, no narration',
    content: 'Be extremely concise. Give the shortest possible correct answer. No greetings. No sign-offs. No narration. No emoji. Get straight to the point. If code is the answer, show only the code.',
  },
  'persona:creative': {
    type: 'persona',
    label: 'Creative Explorer',
    description: 'Brainstorms multiple approaches before committing',
    content: 'You are a creative architect. Before implementing, explore 2-3 different approaches. Discuss trade-offs openly. Use analogies. Prioritize elegant solutions. Be willing to experiment and iterate. Celebrate creative solutions.',
  },

  // Tone variants
  'tone:formal': {
    type: 'tone',
    label: 'Formal Tone',
    description: 'Professional, business-appropriate language',
    content: 'Maintain a professional and formal tone. Use complete sentences. Avoid contractions and casual language. Be respectful and courteous. Keep the interaction business-appropriate at all times.',
  },
  'tone:casual': {
    type: 'tone',
    label: 'Casual & Friendly',
    description: 'Relaxed, friendly conversation â€” like a coworker',
    content: 'Be warm, casual, and friendly. Use contractions. Crack light jokes. Use emoji naturally. Talk like you are pair programming with a friend over coffee. Keep it real and human.',
  },
  'tone:encouraging': {
    type: 'tone',
    label: 'Encouraging & Supportive',
    description: 'Extra positive reinforcement and encouragement',
    content: 'Be exceptionally encouraging and supportive. Celebrate small wins. Use lots of positive reinforcement. Frame challenges as learning opportunities. Make the user feel confident and capable.',
  },

  // Strategy variants
  'strategy:test-first': {
    type: 'strategy',
    label: 'Test-First Approach',
    description: 'Write tests before implementation code',
    content: 'Follow test-first development. Always write failing tests first, then implement the minimum code to make them pass, then refactor. Never write implementation without corresponding tests.',
  },
  'strategy:refactor-first': {
    type: 'strategy',
    label: 'Refactor-First Approach',
    description: 'Clean up existing code before adding new features',
    content: 'Prioritize refactoring existing code before adding new functionality. Clean up technical debt, improve naming, extract functions, and add types before implementing new features.',
  },
  'strategy:direct-edit': {
    type: 'strategy',
    label: 'Direct Edit Approach',
    description: 'Make minimal surgical edits with maximum impact',
    content: 'Make minimal, targeted edits. Prefer changing a few lines over rewriting entire files. Use precise surgical changes. Always verify each edit before moving on. Minimize risk surface area.',
  },
};

// â”€â”€ Database operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('persona', 'tone', 'strategy', 'custom')),
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prompt_variant_assignments (
      user_id INTEGER NOT NULL,
      variant_key TEXT NOT NULL,
      variant_type TEXT NOT NULL,
      assigned_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, variant_key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Seed built-in variants
  for (const [key, v] of Object.entries(BUILTIN_VARIANTS)) {
    const existing = db.prepare('SELECT id FROM prompt_variants WHERE key = ?').get(key);
    if (!existing) {
      db.prepare(
        'INSERT INTO prompt_variants (type, key, label, content, description) VALUES (?, ?, ?, ?, ?)'
      ).run(v.type, key, v.label, v.content, v.description);
    }
  }
}

export function getVariant(key: string): PromptVariant | null {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM prompt_variants WHERE key = ? AND is_active = 1'
  ).get(key) as PromptVariant | undefined;
  return row || null;
}

export function createCustomVariant(
  key: string,
  label: string,
  content: string,
  description: string,
): PromptVariant {
  ensureTable();
  const db = getDb();
  const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9:_-]/g, '');
  if (!cleanKey) throw new Error('Invalid variant key');

  db.prepare(
    'INSERT INTO prompt_variants (type, key, label, content, description) VALUES (?, ?, ?, ?, ?)'
  ).run('custom', cleanKey, label, content, description);

  return getVariant(cleanKey)!;
}

export function listVariants(type?: PromptVariantType): PromptVariant[] {
  ensureTable();
  const db = getDb();
  if (type) {
    return db.prepare(
      'SELECT * FROM prompt_variants WHERE type = ? AND is_active = 1 ORDER BY type, key'
    ).all(type) as PromptVariant[];
  }
  return db.prepare(
    'SELECT * FROM prompt_variants WHERE is_active = 1 ORDER BY type, key'
  ).all() as PromptVariant[];
}

export function deleteVariant(key: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM prompt_variants WHERE key = ? AND type = ?').run(key, 'custom');
  return result.changes > 0;
}

// â”€â”€ Assignment management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function assignVariantToUser(userId: number, variantKey: string): void {
  ensureTable();
  const variant = getVariant(variantKey);
  if (!variant) throw new Error(`Variant "${variantKey}" not found`);

  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO prompt_variant_assignments (user_id, variant_key, variant_type) VALUES (?, ?, ?)'
  ).run(userId, variantKey, variant.type);
}

export function unassignVariant(userId: number, variantKey: string): void {
  const db = getDb();
  db.prepare(
    'DELETE FROM prompt_variant_assignments WHERE user_id = ? AND variant_key = ?'
  ).run(userId, variantKey);
}

export function getUserAssignments(userId: number): PromptVariantAssignment[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM prompt_variant_assignments WHERE user_id = ?'
  ).all(userId) as PromptVariantAssignment[];
}

export function renderUserVariants(userId: number): string {
  const assignments = getUserAssignments(userId);
  if (assignments.length === 0) return '';

  const parts = assignments.map(a => {
    const variant = getVariant(a.variant_key);
    if (!variant) return '';
    return [
      `<prompt_variant type="${a.variant_type}" key="${a.variant_key}">`,
      variant.content,
      '</prompt_variant>',
    ].join('\n');
  }).filter(Boolean);

  if (parts.length === 0) return '';

  return [
    '',
    '<assigned_prompt_variants>',
    'The following prompt variants are assigned to this user and override default behavior:',
    ...parts,
    '</assigned_prompt_variants>',
    '',
  ].join('\n');
}

// â”€â”€ Tool factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PromptVariantContext {
  userId: number;
}

export function createPromptVariantTool(ctx: PromptVariantContext) {
  return tool({
    description:
      'Manage prompt variants â€” create, list, assign, or unassign persona/tone/strategy variants. ' +
      'Available built-in variants: ' +
      Object.entries(BUILTIN_VARIANTS)
        .map(([key, v]) => `"${key}" â€” ${v.label} (${v.type})`)
        .join(', ') +
      '. Custom variants can also be created.',
    inputSchema: z.object({
      action: z.enum(['list', 'get', 'assign', 'unassign', 'create']).describe('Action to perform'),
      variantKey: z.string().optional().describe('The variant key (e.g. "persona:senior-engineer")'),
      label: z.string().optional().describe('Label for new custom variants'),
      content: z.string().optional().describe('Content for new custom variants'),
      description: z.string().optional().describe('Description for new custom variants'),
    }),
    execute: async ({ action, variantKey, label, content, description }) => {
      switch (action) {
        case 'list': {
          const all = listVariants();
          return all.map(v =>
            `[${v.type}] ${v.key}: ${v.label} â€” ${v.description}${v.is_active ? '' : ' (inactive)'}`
          ).join('\n') || 'No variants found.';
        }
        case 'get': {
          if (!variantKey) return 'Specify a variantKey.';
          const variant = getVariant(variantKey);
          return variant
            ? `[${variant.type}] ${variant.key}\n${variant.label}\n---\n${variant.content}\n---\n${variant.description}`
            : `Variant "${variantKey}" not found.`;
        }
        case 'assign': {
          if (!variantKey) return 'Specify a variantKey to assign.';
          try {
            assignVariantToUser(ctx.userId, variantKey);
            return `Assigned variant "${variantKey}" to your session.`;
          } catch (e) {
            return `Failed: ${(e as Error).message}`;
          }
        }
        case 'unassign': {
          if (!variantKey) return 'Specify a variantKey to unassign.';
          unassignVariant(ctx.userId, variantKey);
          return `Unassigned variant "${variantKey}".`;
        }
        case 'create': {
          if (!variantKey || !label || !content) return 'Specify variantKey, label, and content.';
          try {
            const v = createCustomVariant(variantKey, label, content, description || '');
            return `Created custom variant "${v.key}".`;
          } catch (e) {
            return `Failed: ${(e as Error).message}`;
          }
        }
        default:
          return `Unknown action: ${action}`;
      }
    },
  });
}
