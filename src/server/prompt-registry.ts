/**
 * SUNy Prompt Registry — DB-backed system prompt templates.
 *
 * Allows users and the AI to store, retrieve, and manage prompt templates
 * for different contexts (architect, debug, refactor, explain, etc.).
 *
 * Templates are stored per-user in the prompt_templates table and can be
 * retrieved by the AI mid-conversation via the get_prompt_template tool.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from './db';

// ─────────────────────────────────────────────────────────────────────────────
// Built-in template contexts
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATE_CONTEXTS: Record<string, { label: string; description: string; defaultContent: string }> = {
  architect: {
    label: 'Architect Mode',
    description: 'Architecture & design discussion — focuses on planning over implementation',
    defaultContent:
      'You are in architecture mode. Focus on high-level design, trade-offs, and system structure. ' +
      'Do not write implementation code unless explicitly asked. Use diagrams (ASCII/graphviz) where helpful. ' +
      'Consider: scalability, maintainability, error handling, and edge cases.',
  },
  debug: {
    label: 'Debug Mode',
    description: 'Debugging mode — step-by-step root cause analysis',
    defaultContent:
      'You are in debugging mode. Before suggesting a fix, identify the root cause by examining: ' +
      '1) The error message and stack trace, 2) The relevant code paths, ' +
      '3) Input state and assumptions, 4) Recent changes that could have introduced the bug. ' +
      'Output your analysis before writing any code.',
  },
  refactor: {
    label: 'Refactor Mode',
    description: 'Refactoring mode — focuses on minimal, safe changes',
    defaultContent:
      'You are in refactoring mode. Make minimal, safe changes. Prefer: ' +
      '1) Extracting functions over rewriting, 2) Adding types over removing them, ' +
      '3) Backward-compatible changes. Always explain the migration path.',
  },
  explain: {
    label: 'Explain Mode',
    description: 'Educational mode — thorough explanations with examples',
    defaultContent:
      'You are in explain mode. Provide thorough explanations with concrete examples. ' +
      'Assume the user understands programming fundamentals but may not know this specific topic. ' +
      'Use analogies, diagrams, and runnable code snippets.',
  },
  security: {
    label: 'Security Review',
    description: 'Security-focused code review mode',
    defaultContent:
      'You are performing a security review. Focus on: ' +
      '1) Input validation and sanitization, 2) Authentication and authorization, ' +
      '3) Data exposure and information leakage, 4) Injection vulnerabilities (SQL, XSS, command), ' +
      '5) Dependency vulnerabilities, 6) Secrets management. Rate each finding by severity.',
  },
  api: {
    label: 'API Design',
    description: 'API design and documentation mode',
    defaultContent:
      'You are designing an API. Focus on: ' +
      '1) RESTful conventions and resource modeling, 2) Request/response shape consistency, ' +
      '3) Error handling and status codes, 4) Authentication and rate limiting, ' +
      '5) Documentation completeness. Provide OpenAPI/Swagger specs where appropriate.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Database operations
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptTemplate {
  id: number;
  user_id: number;
  key: string;
  content: string;
  description: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Get a prompt template by key for a given user.
 * Falls back to built-in default if no user template exists.
 */
export function getPromptTemplate(userId: number, key: string): PromptTemplate | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM prompt_templates WHERE user_id = ? AND key = ? AND is_active = 1',
  ).get(userId, key) as PromptTemplate | undefined;

  if (row) return row;

  // Fall back to built-in default
  const builtIn = TEMPLATE_CONTEXTS[key];
  if (builtIn) {
    return {
      id: 0,
      user_id: userId,
      key,
      content: builtIn.defaultContent,
      description: builtIn.description,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as PromptTemplate;
  }

  return null;
}

/**
 * Set a prompt template for a given user and key.
 * Creates or updates the template.
 */
export function setPromptTemplate(
  userId: number,
  key: string,
  content: string,
  description?: string,
): PromptTemplate {
  const db = getDb();
  const trimmedKey = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!trimmedKey) throw new Error('Invalid template key');

  const existing = db.prepare(
    'SELECT id FROM prompt_templates WHERE user_id = ? AND key = ?',
  ).get(userId, trimmedKey) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE prompt_templates SET content = ?, description = COALESCE(?, description), updated_at = datetime(\'now\') WHERE id = ?',
    ).run(content, description ?? null, existing.id);
  } else {
    db.prepare(
      'INSERT INTO prompt_templates (user_id, key, content, description) VALUES (?, ?, ?, ?)',
    ).run(userId, trimmedKey, content, description ?? '');
  }

  return getPromptTemplate(userId, trimmedKey)!;
}

/**
 * List all prompt templates for a user, including built-in defaults.
 */
export function listPromptTemplates(userId: number): PromptTemplate[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM prompt_templates WHERE user_id = ? ORDER BY key',
  ).all(userId) as PromptTemplate[];

  const seen = new Set(rows.map((r) => r.key));
  const builtIns: PromptTemplate[] = Object.entries(TEMPLATE_CONTEXTS)
    .filter(([key]) => !seen.has(key))
    .map(([key, ctx]) => ({
      id: 0,
      user_id: userId,
      key,
      content: ctx.defaultContent,
      description: ctx.description,
      is_active: true,
      created_at: '',
      updated_at: '',
    }));

  return [...builtIns, ...rows];
}

/**
 * Delete a prompt template by key.
 */
export function deletePromptTemplate(userId: number, key: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM prompt_templates WHERE user_id = ? AND key = ?',
  ).run(userId, key);
  return result.changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptRegistryContext {
  userId: number;
}

export function createPromptRegistryTool(ctx: PromptRegistryContext) {
  return tool({
    description:
      'Retrieve a system prompt template for a specific context. ' +
      'Available contexts: ' +
      Object.entries(TEMPLATE_CONTEXTS)
        .map(([key, t]) => `"${key}" — ${t.description}`)
        .join(', ') +
      '. ' +
      'Use this to switch between different modes (architect, debug, refactor, explain, security, api). ' +
      'Custom templates can be created by the user via /prompt command.',
    inputSchema: z.object({
      key: z
        .enum(Object.keys(TEMPLATE_CONTEXTS) as [string, ...string[]])
        .describe('The template context key'),
    }),
    execute: async ({ key }) => {
      const template = getPromptTemplate(ctx.userId, key);
      if (!template) {
        return `No template found for context "${key}". Available contexts: ${Object.keys(TEMPLATE_CONTEXTS).join(', ')}`;
      }

      return [
        `## Prompt Template: "${key}"`,
        template.description ? `> ${template.description}` : '',
        '',
        template.content,
      ].join('\n');
    },
  });
}
