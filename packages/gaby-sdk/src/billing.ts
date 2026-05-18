/**
 * @gaby/sdk — Billing plugin interface.
 * Custom billing and cost calculation backends.
 */

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  rawCost: number;
  chargedCost: number;
  currency: string;
}

export interface UsageRecord {
  id: string;
  userId: number;
  sessionId: string;
  mode: string;
  inputTokens: number;
  outputTokens: number;
  rawCost: number;
  chargedCost: number;
  timestamp: string;
}

export interface BillingPlugin {
  /** Calculate cost for a usage event */
  estimateCost(params: {
    mode: string;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  }): CostEstimate;

  /** Check if a user has sufficient balance */
  hasSufficientBalance(userId: number, estimatedCost: number): Promise<boolean>;

  /** Deduct from user balance */
  deductUsage(userId: number, cost: number, record: Omit<UsageRecord, 'id'>): Promise<UsageRecord>;

  /** Get user balance */
  getBalance(userId: number): Promise<number>;

  /** Get plugin metadata */
  getMetadata(): { name: string; version: string };
}

/**
 * Create a custom billing plugin.
 */
export function createBillingPlugin(plugin: BillingPlugin): BillingPlugin {
  return plugin;
}
