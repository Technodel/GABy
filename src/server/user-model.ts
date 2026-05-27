/**
 * SUNy User Model — structured per-user behavioral profile.
 *
 * Inspired by Honcho (Plastic Labs) dialectic user modeling, but implemented
 * locally without external dependencies. Instead of ad-hoc memory facts,
 * this maintains an explicit structured model with named dimensions:
 *
 *   communication_style   — how the user likes to receive responses
 *   tech_preferences      — languages, frameworks, tools they prefer
 *   working_style         — how they approach tasks (step-by-step vs. high-level)
 *   constraints           — things to never do (e.g., "never use semicolons")
 *   domain_expertise      — what they know well vs. need explained
 *   personality_notes     — tone, sense of humor, patience level, etc.
 *
 * The model is injected into the system prompt and updated by the AI
 * via the update_user_model tool when it observes strong signals.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getDb } from './db';

export type UserModelDimension =
  | 'communication_style'
  | 'tech_preferences'
  | 'working_style'
  | 'constraints'
  | 'domain_expertise'
  | 'personality_notes';

const VALID_DIMENSIONS: UserModelDimension[] = [
  'communication_style',
  'tech_preferences',
  'working_style',
  'constraints',
  'domain_expertise',
  'personality_notes',
];

// ── DB setup ──────────────────────────────────────────────────────────────────

export function initializeUserModelTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_model (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, dimension),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_model_user ON user_model(user_id);
  `);
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getUserModel(userId: number): Record<UserModelDimension, string> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT dimension, value FROM user_model WHERE user_id = ? ORDER BY updated_at DESC`
  ).all(userId) as Array<{ dimension: string; value: string }>;

  const model: Partial<Record<UserModelDimension, string>> = {};
  for (const row of rows) {
    model[row.dimension as UserModelDimension] = row.value;
  }
  return model as Record<UserModelDimension, string>;
}

export function formatUserModelForPrompt(userId: number): string {
  const model = getUserModel(userId);
  const entries = Object.entries(model).filter(([, v]) => v?.trim());
  if (!entries.length) return '';

  const lines = entries.map(([k, v]) => `  ${k.replace(/_/g, ' ')}: ${v}`);
  return `<user_model>\n${lines.join('\n')}\n</user_model>`;
}

// ── Write ─────────────────────────────────────────────────────────────────────

export function upsertUserModelDimension(
  userId: number,
  dimension: UserModelDimension,
  value: string,
  confidence = 0.7,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_model (user_id, dimension, value, confidence, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, dimension) DO UPDATE SET
      value = excluded.value,
      confidence = excluded.confidence,
      updated_at = datetime('now')
  `).run(userId, dimension, value.slice(0, 500), confidence);
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createUserModelTool(userId: number) {
  return tool({
    description:
      'Update your structured model of this user. Call this when you observe a strong, reliable signal about their preferences, style, or constraints — not on every interaction, only when you learn something new or clearly wrong needs correcting. This model is injected into your context every session.',
    inputSchema: z.object({
      dimension: z.enum([
        'communication_style',
        'tech_preferences',
        'working_style',
        'constraints',
        'domain_expertise',
        'personality_notes',
      ]).describe(
        'Which dimension to update:\n' +
        '  communication_style — how they like responses (terse, detailed, emoji-friendly, etc.)\n' +
        '  tech_preferences — preferred stack, tools, languages\n' +
        '  working_style — step-by-step vs. high-level, autonomous vs. collaborative\n' +
        '  constraints — hard rules (never use X, always Y)\n' +
        '  domain_expertise — what they know well vs. need explained\n' +
        '  personality_notes — tone, humor, patience, directness'
      ),
      value: z.string().max(300).describe('The new value for this dimension. Be concise and factual.'),
      confidence: z.number().min(0).max(1).default(0.7).describe('How confident you are (0-1). Only update if >= 0.6.'),
    }),
    execute: async ({ dimension, value, confidence }) => {
      if (confidence < 0.6) {
        return 'Skipped — confidence too low. Observe more before updating the user model.';
      }
      if (!VALID_DIMENSIONS.includes(dimension as UserModelDimension)) {
        return `Invalid dimension: ${dimension}`;
      }
      upsertUserModelDimension(userId, dimension as UserModelDimension, value, confidence);
      return `✅ User model updated: ${dimension} = "${value}"`;
    },
  });
}
