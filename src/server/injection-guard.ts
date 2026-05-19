/**
 * injection-guard.ts — Prompt injection detection for SUNy.
 *
 * Ruflo-inspired: detects and neutralizes prompt injection attempts in
 * user messages, tool outputs, and external content before they reach
 * the model.
 *
 * ── Detection strategies ──
 * 1. Keyword patterns ("ignore previous instructions", "you are now", etc.)
 * 2. System prompt override attempts
 * 3. Role-play escape attempts
 * 4. Delimiter manipulation ("forget everything above")
 *
 * ── Mitigation ──
 * All injections are logged for audit and optionally stripped/sanitized.
 * The system NEVER throws — the guard is purely additive and best-effort.
 */

// ── Known injection patterns (case-insensitive regex) ─────────────────────────

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string; severity: 'low' | 'medium' | 'high' }> = [
  // Direct system prompt override
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|directives|commands|rules)/i, label: 'ignore_previous_instructions', severity: 'high' },
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(system\s+)?prompts/i, label: 'ignore_previous_prompts', severity: 'high' },
  { pattern: /you\s+(are\s+)?(now|are)\s+(not\s+)?(SUNy|an?\s+(AI|assistant|chatbot))/i, label: 'role_redefinition', severity: 'high' },
  { pattern: /forget\s+(everything|all)\s+(above|before|previous)/i, label: 'forget_context', severity: 'medium' },
  { pattern: /disregard\s+(all\s+)?(previous|above|prior)/i, label: 'disregard_context', severity: 'medium' },
  { pattern: /you\s+(must|will|have\s+to|need\s+to)\s+(ignore|disregard)/i, label: 'must_ignore', severity: 'high' },
  { pattern: /new\s+(instruction|rule|directive|command)/i, label: 'new_rule', severity: 'medium' },
  { pattern: /override\s+(system|previous|default)/i, label: 'override_attempt', severity: 'high' },
  { pattern: /you\s+(are\s+(now|going\s+to\s+be)|will\s+(act|behave)\s+as)/i, label: 'role_change', severity: 'high' },
  { pattern: /pretend\s+(to\s+be|you\s+are)/i, label: 'pretend', severity: 'medium' },
  { pattern: /from\s+(now\s+on|this\s+(point|moment)\s+(forward|onwards?))/i, label: 'from_now_on', severity: 'low' },
  { pattern: /your\s+(new\s+)?(instructions|rules|directives|commands|prompts?)\s+(are|will\s+be|shall\s+be)/i, label: 'new_instructions', severity: 'high' },
  // Token smuggling / delimiter attacks
  { pattern: /<\|?(im_start|im_end|system|user|assistant|sop|eot_id)\|?>/i, label: 'token_smuggling', severity: 'high' },
  { pattern: /\[SYSTEM(?:\s+PROMPT)?\]|\[INST\]|\[\/INST\]|<<SYS>>|<\/?SYS>/i, label: 'prompt_delimiter', severity: 'high' },
  // DAN / jailbreak patterns
  { pattern: /(DAN|jailbreak|jail\s*break|do\s+(anything|everything)\s+now|anti.?GPT)/i, label: 'jailbreak_keyword', severity: 'high' },
  { pattern: /you\s+(must|have\s+to|will)\s+(output|respond|answer|reply)\s+in\s+(a\s+)?(raw|unfiltered|uncensored|unbounded)/i, label: 'uncensored_request', severity: 'high' },
  // Information extraction
  { pattern: /(reveal|show|display|print|output|leak|dump)\s+(your\s+)?(system\s+)?(prompt|instructions|directives|rules)/i, label: 'prompt_extraction', severity: 'high' },
  { pattern: /(what|how)\s+(are\s+your|is\s+your)\s+(system\s+)?(prompt|instructions|directives|rules)/i, label: 'prompt_inquiry', severity: 'low' },
  // Payload separation
  { pattern: /(separator|delimiter|splitter|boundary):.*\n/i, label: 'payload_separator', severity: 'low' },
];

// ── Audit log table name ──────────────────────────────────────────────────────

const AUDIT_TABLE = 'injection_attempts';

// ── Initialize DB table ───────────────────────────────────────────────────────

export function initializeInjectionGuardTable(): void {
  const { getDb } = require('./db');
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT 0,
        session_id TEXT DEFAULT '',
        pattern_label TEXT NOT NULL,
        severity TEXT NOT NULL,
        matched_text TEXT DEFAULT '',
        context_snippet TEXT DEFAULT '',
        blocked INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_injection_attempts_user ON ${AUDIT_TABLE}(user_id);
      CREATE INDEX IF NOT EXISTS idx_injection_attempts_severity ON ${AUDIT_TABLE}(severity);
    `);
  } catch {
    // best-effort
  }
}

// ── Scan result ───────────────────────────────────────────────────────────────

export interface InjectionScanResult {
  detected: boolean;
  matches: Array<{
    pattern: string;
    label: string;
    severity: 'low' | 'medium' | 'high';
    matchedText: string;
  }>;
  sanitizedText: string;
  blocked: boolean;
}

// ── Scan for injection attempts ───────────────────────────────────────────────

/**
 * Scan a piece of text for prompt injection attempts.
 * Returns a result with detection info and an optionally sanitized version.
 */
export function scanForInjection(
  text: string,
  context?: { userId?: number; sessionId?: string },
  options: { sanitize?: boolean; blockOnHigh?: boolean } = {},
): InjectionScanResult {
  const matches: InjectionScanResult['matches'] = [];
  let sanitized = text;

  for (const { pattern, label, severity } of INJECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      matches.push({
        pattern: pattern.source,
        label,
        severity,
        matchedText: match[0].slice(0, 200),
      });

      // Sanitize: replace the matched text with a neutral marker
      if (options.sanitize) {
        sanitized = sanitized.replace(pattern, `[injection:${label}]`);
      }
    }
  }

  const hasHigh = matches.some(m => m.severity === 'high');
  const blocked = !!(options.blockOnHigh && hasHigh);

  // Log to audit DB
  if (matches.length > 0) {
    try {
      const { getDb } = require('./db');
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO ${AUDIT_TABLE} (user_id, session_id, pattern_label, severity, matched_text, context_snippet, blocked)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of matches) {
        insert.run(
          context?.userId ?? 0,
          context?.sessionId ?? '',
          m.label,
          m.severity,
          m.matchedText.slice(0, 200),
          text.slice(0, 100),
          blocked ? 1 : 0,
        );
      }
    } catch {
      // best-effort
    }
  }

  return {
    detected: matches.length > 0,
    matches,
    sanitizedText: sanitized,
    blocked,
  };
}

// ── Check if user message contains injection before processing ────────────────

/**
 * Quick check: does the message contain injection patterns?
 * Lightweight — should be called on every user message before agent loop.
 */
export function hasInjection(text: string): boolean {
  return INJECTION_PATTERNS.some(({ pattern }) => pattern.test(text));
}

// ── Get injection stats for admin panel ───────────────────────────────────────

export interface InjectionStats {
  totalAttempts: number;
  highSeverity: number;
  blockedCount: number;
  recentAttempts: Array<{
    id: number;
    patternLabel: string;
    severity: string;
    createdAt: string;
  }>;
}

export function getInjectionStats(limit: number = 50): InjectionStats {
  try {
    const { getDb } = require('./db');
    const db = getDb();

    const totalAttempts = (db.prepare(`SELECT COUNT(*) as c FROM ${AUDIT_TABLE}`).get() as { c: number }).c;
    const highSeverity = (db.prepare(`SELECT COUNT(*) as c FROM ${AUDIT_TABLE} WHERE severity = 'high'`).get() as { c: number }).c;
    const blockedCount = (db.prepare(`SELECT COUNT(*) as c FROM ${AUDIT_TABLE} WHERE blocked = 1`).get() as { c: number }).c;
    const recent = db.prepare(
      `SELECT id, pattern_label as patternLabel, severity, created_at as createdAt FROM ${AUDIT_TABLE} ORDER BY id DESC LIMIT ?`
    ).all(limit) as InjectionStats['recentAttempts'];

    return { totalAttempts, highSeverity, blockedCount, recentAttempts: recent };
  } catch {
    return { totalAttempts: 0, highSeverity: 0, blockedCount: 0, recentAttempts: [] };
  }
}
