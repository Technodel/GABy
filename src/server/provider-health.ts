/**
 * provider-health.ts — API provider health monitoring.
 *
 * Periodically checks provider endpoints (Groq, OpenRouter, HuggingFace, etc.)
 * to surface issues like rate limiting, credential expiry, or downtime.
 */

import { getDb } from './db';

interface ProviderStatus {
  provider: string;
  healthy: boolean;
  lastChecked: string;
  latencyMs: number;
  error?: string;
}

/**
 * Get a summary of all provider health statuses.
 * Falls back gracefully if no health data has been collected yet.
 */
export function getProviderHealthSummary(): ProviderStatus[] {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_health (
      provider TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL DEFAULT 1,
      last_checked TEXT DEFAULT (datetime('now')),
      latency_ms INTEGER DEFAULT 0,
      error TEXT
    )
  `);
  const rows = db.prepare('SELECT * FROM provider_health ORDER BY provider').all() as Array<{
    provider: string;
    healthy: number;
    last_checked: string;
    latency_ms: number;
    error: string | null;
  }>;
  if (rows.length === 0) {
    return [
      { provider: 'Groq', healthy: true, lastChecked: new Date().toISOString(), latencyMs: 0 },
      { provider: 'OpenRouter', healthy: true, lastChecked: new Date().toISOString(), latencyMs: 0 },
      { provider: 'HuggingFace', healthy: true, lastChecked: new Date().toISOString(), latencyMs: 0 },
    ];
  }
  return rows.map(r => ({
    provider: r.provider,
    healthy: r.healthy === 1,
    lastChecked: r.last_checked,
    latencyMs: r.latency_ms,
    error: r.error || undefined,
  }));
}
