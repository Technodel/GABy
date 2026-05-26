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
