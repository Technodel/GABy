/**
 * SUNy Design Intent Tracker â€” Phase 3.3
 *
 * Harvests explicit user design preferences from conversation and stores them
 * as persistent behavioral rules. These are NOT learned from task outcomes â€”
 * they are distilled from what the user explicitly says they prefer.
 *
 * Examples of signals:
 *   "I prefer functional components"  â†’ rule: "Use functional components over classes"
 *   "Always use tab indentation"      â†’ rule: "Use tab indentation"
 *   "Never use any types"             â†’ rule: "Avoid 'any' types, use explicit types"
 *   "My style is minimal CSS"         â†’ rule: "Prefer minimal CSS, avoid heavy frameworks"
 */

import { getAdapter } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DesignIntent {
  id: number;
  userId: number;
  intent: string;         // The distilled rule (e.g., "Use functional components")
  category: string;       // style | convention | architecture | tooling | testing
  sourceMessage: string;  // The user message that triggered this (for traceability)
  confidence: number;     // 1.0 (explicitly stated), may decay on contradiction
  applicationCount: number;
  createdAt: string;
}

// â”€â”€ Initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function initializeDesignIntentTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS design_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      intent TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'style',
      source_message TEXT DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1.0,
      application_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, intent)
    );
    CREATE INDEX IF NOT EXISTS idx_design_intents_user ON design_intents(user_id);
    CREATE INDEX IF NOT EXISTS idx_design_intents_category ON design_intents(category);
  `);
}

// â”€â”€ Signal Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface IntentSignal {
  intent: string;
  category: string;
  pattern: RegExp;
  negativePattern?: RegExp; // If present, the intent is the OPPOSITE
}

/**
 * Pattern bank for detecting design preferences.
 * Each entry has a regex to match user speech and a distilled rule.
 */
const SIGNAL_PATTERNS: IntentSignal[] = [
  // â”€â”€ Code style â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Use functional components (not classes)',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(functional\s+components?|function\s+components?|hooks?)\b/i,
  },
  {
    intent: 'Use class components',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(class\s+components?)\b/i,
  },
  {
    intent: 'Use TypeScript strict mode conventions',
    category: 'convention',
    pattern: /\b(prefer|like|use|want|always)\s+(strict|typesafe|type.safe)\b/i,
  },
  {
    intent: 'Avoid "any" types â€” use explicit types',
    category: 'convention',
    pattern: /\b(never|don'?t|avoid|stop)\s+(use|using)?\s*(any\s+types?)\b/i,
  },
  {
    intent: 'Use explicit return types on functions',
    category: 'convention',
    pattern: /\b(prefer|like|use|want|always)\s+(explicit\s+return\s+types?)\b/i,
  },
  {
    intent: 'Prefer arrow functions',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(arrow\s+functions?|=>)\b/i,
  },

  // â”€â”€ Formatting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Use tab indentation',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(tabs?|tab\s+indent(?:ation)?)\b/i,
  },
  {
    intent: 'Use space indentation',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(spaces?|space\s+indent(?:ation)?)\b/i,
  },
  {
    intent: 'Use single quotes for strings',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(single\s+quotes?|')\b/i,
  },
  {
    intent: 'Use double quotes for strings',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(double\s+quotes?)\b/i,
  },
  {
    intent: 'Use semicolons',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(semicolons?|;)\b/i,
  },
  {
    intent: 'No semicolons',
    category: 'style',
    pattern: /\b(no|without|never|don'?t|avoid)\s+(semicolons?)\b/i,
  },

  // â”€â”€ Architecture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Prefer server actions over API routes',
    category: 'architecture',
    pattern: /\b(prefer|like|use|want|always)\s+(server\s+actions?)\b/i,
  },
  {
    intent: 'Use REST API patterns',
    category: 'architecture',
    pattern: /\b(prefer|like|use|want|always)\s+(REST|RESTful|API\s+routes?)\b/i,
  },
  {
    intent: 'Prefer monorepo structure',
    category: 'architecture',
    pattern: /\b(prefer|like|use|want|always)\s+(monorepo|mono.repo)\b/i,
  },
  {
    intent: 'Keep files small and focused (single responsibility)',
    category: 'architecture',
    pattern: /\b(prefer|like|use|want|always)\s+(small\s+files?|single\s+responsibility|SRP)\b/i,
  },
  {
    intent: 'Co-locate tests with source files',
    category: 'architecture',
    pattern: /\b(prefer|like|use|want|always)\s+(co.locate|tests?\s+near|tests?\s+next\s+to)\b/i,
  },
  {
    intent: 'Separate test directory (e.g., __tests__/)',
    category: 'architecture',
    pattern: /\b(prefer|like|use|want|always)\s+(separate\s+tests?|__tests__)\b/i,
  },

  // â”€â”€ Tooling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Use ESLint with strict config',
    category: 'tooling',
    pattern: /\b(prefer|like|use|want|always)\s+(eslint\s+strict|strict\s+eslint)\b/i,
  },
  {
    intent: 'Use Prettier for formatting',
    category: 'tooling',
    pattern: /\b(prefer|like|use|want|always)\s+(prettier)\b/i,
  },
  {
    intent: 'Use Biome for linting and formatting',
    category: 'tooling',
    pattern: /\b(prefer|like|use|want|always)\s+(biome)\b/i,
  },

  // â”€â”€ Testing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Write tests for all new features',
    category: 'testing',
    pattern: /\b(prefer|like|use|want|always)\s+(tests?|testing|TDD)\b/i,
  },
  {
    intent: 'Prefer integration tests over unit tests',
    category: 'testing',
    pattern: /\b(prefer|like|use|want|always)\s+(integration\s+tests?)\b/i,
  },
  {
    intent: 'Prefer unit tests',
    category: 'testing',
    pattern: /\b(prefer|like|use|want|always)\s+(unit\s+tests?)\b/i,
  },

  // â”€â”€ UI / CSS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Use Tailwind CSS for styling',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(tailwind|tailwindcss)\b/i,
  },
  {
    intent: 'Use CSS modules for styling',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(css\s+modules?|\.module\.css)\b/i,
  },
  {
    intent: 'Keep UI minimal â€” avoid heavy CSS frameworks',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(minimal|simple|lightweight)\s+(CSS|style|design)\b/i,
  },

  // â”€â”€ Error Handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Always handle errors explicitly (no silent failures)',
    category: 'convention',
    pattern: /\b(prefer|like|use|want|always)\s+(explicit\s+error|handle\s+errors?|no\s+silent)\b/i,
  },
  {
    intent: 'Use try/catch sparingly â€” prefer result types',
    category: 'convention',
    pattern: /\b(prefer|like|use|want|always)\s+(result\s+types?|either\s+monad)\b/i,
  },

  // â”€â”€ General preferences â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'Prioritize readability over cleverness',
    category: 'style',
    pattern: /\b(prefer|like|use|want|always)\s+(readab(?:le|ility)|clean\s+code|simple)\b/i,
  },
  {
    intent: 'Keep dependencies minimal',
    category: 'architecture',
    pattern: /\b(prefer|like|use|want|always)\s+(minimal\s+dependenc|few\s+dependenc|lightweight)\b/i,
  },
  {
    intent: 'Add comments for complex logic',
    category: 'convention',
    pattern: /\b(prefer|like|use|want|always)\s+(comments?|document|JSDoc)\b/i,
  },
];

// â”€â”€ Core Functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Analyze a user message for design preference signals and extract intents.
 * Called after each user message to harvest preferences.
 */
export function extractDesignIntents(message: string): Array<{ intent: string; category: string; sourceMessage: string }> {
  const results: Array<{ intent: string; category: string; sourceMessage: string }> = [];

  for (const signal of SIGNAL_PATTERNS) {
    if (signal.pattern.test(message)) {
      results.push({
        intent: signal.intent,
        category: signal.category,
        sourceMessage: message.slice(0, 500), // Truncate for storage
      });
    }
  }

  return results;
}

/**
 * Store extracted design intents for a user. Deduplicates by (user_id, intent).
 * Returns the number of NEW intents stored.
 */
export async function storeDesignIntents(
  userId: number,
  intents: Array<{ intent: string; category: string; sourceMessage: string }>,
): Promise<number> {
  const db = await getAdapter();
  let stored = 0;

  for (const di of intents) {
    // Try insert â€” if it already exists, bump confidence
    const insertResult = await db.run(`
      INSERT OR IGNORE INTO design_intents (user_id, intent, category, source_message, confidence)
      VALUES (?, ?, ?, ?, 1.0)
    `, [userId, di.intent, di.category, di.sourceMessage]);
    if (insertResult.changes > 0) {
      stored++;
    } else {
      // Already exists â€” bump confidence since user re-stated it
      await db.run(`
        UPDATE design_intents
        SET confidence = MIN(1.0, confidence + 0.1),
            application_count = application_count + 1,
            source_message = ?
        WHERE user_id = ? AND intent = ?
      `, [di.sourceMessage, userId, di.intent]);
    }
  }

  if (stored > 0) {
    console.log(`[design-intent] Stored ${stored} new design intents for user ${userId}`);
  }

  return stored;
}

/**
 * Get all design intents for a user, sorted by confidence.
 */
export async function getDesignIntents(userId: number): Promise<DesignIntent[]> {
  const db = await getAdapter();
  return db.all<DesignIntent[]>(
    'SELECT * FROM design_intents WHERE user_id = ? ORDER BY confidence DESC, category',
    [userId],
  );
}

/**
 * Format design intents for system prompt injection.
 */
export function formatDesignIntentsForPrompt(intents: DesignIntent[]): string {
  if (intents.length === 0) return '';

  // Group by category
  const byCategory = new Map<string, DesignIntent[]>();
  for (const di of intents) {
    if (!byCategory.has(di.category)) byCategory.set(di.category, []);
    byCategory.get(di.category)!.push(di);
  }

  const lines: string[] = [
    '',
    '=== USER DESIGN PREFERENCES (harvested from conversation) ===',
    'These are your preferences that SUNy has learned over time.',
    'Always follow them unless you explicitly ask otherwise.',
    '',
  ];

  byCategory.forEach((catIntents, category) => {
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`[${label}]`);
    for (const di of catIntents) {
      lines.push(`  â€¢ ${di.intent}`);
    }
    lines.push('');
  });

  lines.push('=== END DESIGN PREFERENCES ===');
  return lines.join('\n');
}

/**
 * Full pipeline: extract + store intents from a user message.
 * Returns the formatted prompt injection string for immediate use.
 */
export async function processDesignIntents(
  userId: number,
  message: string,
): Promise<string> {
  const extracted = extractDesignIntents(message);
  if (extracted.length === 0) return '';

  await storeDesignIntents(userId, extracted);

  // Return the intents for this turn's prompt
  const allIntents = await getDesignIntents(userId);
  return formatDesignIntentsForPrompt(allIntents);
}

/**
 * Get formatted design intents for prompt injection (without extraction).
 * Used at the START of a turn to inject previously-learned preferences.
 */
export async function getDesignIntentsPrompt(userId: number): Promise<string> {
  const intents = await getDesignIntents(userId);
  return formatDesignIntentsForPrompt(intents);
}
