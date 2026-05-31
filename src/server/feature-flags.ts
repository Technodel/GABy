/**
 * SUNy Feature Flags â€” DB-backed feature gating.
 *
 * Every risky or optional feature ships behind a flag.
 * Flags are stored in the feature_flags DB table and can be toggled
 * at runtime via the admin API or by direct DB update.
 *
 * Convention: flag keys start with "ff_"
 */

import { getDb } from './db';

export interface FeatureFlag {
  key: string;
  value: 'on' | 'off';
  label: string;
  description: string;
  updatedAt: string;
}

/**
 * Check if a feature flag is enabled.
 */
export function isFeatureEnabled(key: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT value FROM feature_flags WHERE key = ?',
  ).get(key) as { value: string } | undefined;

  if (!row) return false; // unknown flags are off by default
  return row.value === 'on';
}

/**
 * Get a feature flag's full record.
 */
export function getFeatureFlag(key: string): FeatureFlag | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT key, value, label, description, updated_at as updatedAt FROM feature_flags WHERE key = ?',
  ).get(key) as FeatureFlag | undefined;
  return row ?? null;
}

/**
 * Set a feature flag's value.
 */
export function setFeatureFlag(key: string, value: 'on' | 'off'): void {
  const db = getDb();

  const existing = db.prepare(
    'SELECT 1 FROM feature_flags WHERE key = ?',
  ).get(key);

  if (existing) {
    db.prepare(
      "UPDATE feature_flags SET value = ?, updated_at = datetime('now') WHERE key = ?",
    ).run(value, key);
  } else {
    db.prepare(
      "INSERT INTO feature_flags (key, value, label, description) VALUES (?, ?, '', '')",
    ).run(key, value);
  }
}

/**
 * Get all feature flags (for admin panel).
 */
export function getAllFeatureFlags(): FeatureFlag[] {
  const db = getDb();
  return db.prepare(
    'SELECT key, value, label, description, updated_at as updatedAt FROM feature_flags ORDER BY key',
  ).all() as FeatureFlag[];
}

/**
 * Check if operation audit logging is enabled.
 */
export function isOperationAuditEnabled(): boolean {
  return isFeatureEnabled('ff_operation_audit');
}

/**
 * Check if project locking is enabled.
 */
export function isProjectLockEnabled(): boolean {
  return isFeatureEnabled('ff_project_lock');
}

/**
 * Check if bridge setup codes are enabled.
 */
export function isBridgeSetupCodesEnabled(): boolean {
  return isFeatureEnabled('ff_bridge_setup_codes');
}

/**
 * Check if session replay is enabled.
 */
export function isSessionReplayEnabled(): boolean {
  return isFeatureEnabled('ff_session_replay');
}

/**
 * Check if activation controller (composable behavior profiles) is enabled.
 */
export function isActivationControllerEnabled(): boolean {
  return isFeatureEnabled('ff_activation_controller');
}

/**
 * Check if the token-saving engine is enabled.
 */
export function isTokenSavingEnabled(): boolean {
  return isFeatureEnabled('ff_token_saving');
}

// ── Plan-level feature flags ────────────────────────────────────────────────

export interface PlanFeatureFlag {
  key: string;
  plan: string;
  enabled: boolean;
  label: string;
  description: string;
  updatedAt: string;
}

/**
 * Check if a plan-gated feature is enabled for a given user plan.
 * Unknown features default to false (deny by default).
 */
export function isPlanFeatureEnabled(key: string, plan: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT enabled FROM plan_feature_flags WHERE key = ? AND plan = ?',
  ).get(key, plan) as { enabled: number } | undefined;
  if (!row) return false;
  return row.enabled === 1;
}

/**
 * Get all plan feature flags (for admin panel).
 */
export function getPlanFeatureFlags(): PlanFeatureFlag[] {
  const db = getDb();
  return db.prepare(
    `SELECT key, plan, enabled, label, description, updated_at as updatedAt
     FROM plan_feature_flags ORDER BY key, plan`,
  ).all() as PlanFeatureFlag[];
}

/**
 * Set a plan feature flag on or off.
 */
export function setPlanFeatureFlag(key: string, plan: string, enabled: boolean): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO plan_feature_flags (key, plan, enabled, label, description)
     VALUES (?, ?, ?, '', '')
     ON CONFLICT(key, plan) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
  ).run(key, plan, enabled ? 1 : 0);
}
