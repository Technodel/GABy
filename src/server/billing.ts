import { evaluate } from 'mathjs';
import { getAdapter } from './db';

interface PricingMode {
  mode: string;
  markup_formula: string;
  input_token_base_cost: number;
  output_token_base_cost: number;
  global_max_tokens: number | null;
}

interface BillingResult {
  rawCost: number;
  chargedCost: number;
  newBalance: number;
  newWalletBalance: number;
}

/**
 * Deduct usage cost from a user's balance.
 * All values are internal — NEVER exposed to user clients.
 * Returns only the new balance total for the WebSocket suny:balance event.
 *
 * Cache pricing multipliers (vs. base input rate):
 *   cacheWriteTokens: 1.25x  (one-time cost to store block in Anthropic's cache)
 *   cacheReadTokens:  0.10x  (90% discount — the payoff on cached turns)
 */
export async function deductUsage(
  userId: number,
  sessionId: string,
  projectId: number | null,
  mode: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
  apiKeyId?: number
): Promise<BillingResult> {
  const db = getAdapter();

  const pricing = await db.get('SELECT * FROM pricing_modes WHERE mode = ?', [mode]) as PricingMode | undefined;

  if (!pricing) {
    throw new Error(`Unknown mode: ${mode}`);
  }

  let inputBase = pricing.input_token_base_cost;
  let outputBase = pricing.output_token_base_cost;
  let inputSale = inputBase;
  let outputSale = outputBase;

  // Use the actual API key's configured token rates if available
  if (apiKeyId) {
    const keyPricing = await db.get('SELECT base_cost_prompt, base_cost_completion, sale_price_prompt, sale_price_completion FROM api_keys WHERE id = ?', [apiKeyId]) as any;
    if (keyPricing) {
      if (keyPricing.base_cost_prompt && keyPricing.base_cost_prompt > 0) inputBase = keyPricing.base_cost_prompt / 1000000;
      if (keyPricing.base_cost_completion && keyPricing.base_cost_completion > 0) outputBase = keyPricing.base_cost_completion / 1000000;
      
      if (keyPricing.sale_price_prompt && keyPricing.sale_price_prompt > 0) {
        inputSale = keyPricing.sale_price_prompt / 1000000;
      } else {
        inputSale = inputBase;
      }

      if (keyPricing.sale_price_completion && keyPricing.sale_price_completion > 0) {
        outputSale = keyPricing.sale_price_completion / 1000000;
      } else {
        outputSale = outputBase;
      }
    }
  }

  // Calculate raw cost using per-token base costs from DB.
  // This is what we ACTUALLY pay the provider — used for internal P&L only.
  // Cache write = 1.25x input rate (one-time); cache read = 0.10x input rate (provider discount).
  const rawCost =
    inputTokens * inputBase +
    outputTokens * outputBase +
    cacheWriteTokens * inputBase * 1.25 +
    cacheReadTokens * inputBase * 0.10;

  // USER-VISIBLE COST: users get a 40% discount on cache reads (we keep 50% of provider's 90% saving).
  // Cache reads are billed to the user at 0.6x input rate (vs 0.10x we pay the provider).
  const userVisibleCost =
    inputTokens * inputSale +
    outputTokens * outputSale +
    cacheWriteTokens * inputSale * 1.25 +
    cacheReadTokens * inputSale * 0.6;

  // Apply admin markup formula (mathjs expression) — applied to the USER-VISIBLE cost,
  // not the actual provider cost, so the cache discount stays with the platform.
  let chargedCost: number;
  try {
    chargedCost = evaluate(pricing.markup_formula, {
      cost: userVisibleCost,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens: cacheReadTokens,
    }) as number;
    if (typeof chargedCost !== 'number' || isNaN(chargedCost) || chargedCost < 0) {
      chargedCost = userVisibleCost;
    }
  } catch {
    chargedCost = userVisibleCost;
  }

  // Deduct from user balances:
  // 1. Always deduct from wallet_balance first (the bot's dedicated fuel tank).
  // 2. If wallet runs out, overflow to main balance regardless of auto_spend.
  //    auto_spend only controls whether the UX shows a warning — billing integrity
  //    must never allow undercharging since the AI provider was already called.
  const userRow = await db.get('SELECT wallet_balance, wallet_auto_spend, balance FROM users WHERE id = ?', [userId]) as { wallet_balance: number; wallet_auto_spend: number; balance: number } | undefined;

  const currentWallet = userRow?.wallet_balance ?? 0;

  const walletDeduct = Math.min(chargedCost, currentWallet);
  const balanceDeduct = Math.max(0, chargedCost - walletDeduct);

  await db.run('UPDATE users SET wallet_balance = MAX(0, wallet_balance - ?) WHERE id = ?', [walletDeduct, userId]);
  if (balanceDeduct > 0) {
    await db.run('UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?', [balanceDeduct, userId]);
  }

  // Log usage (internal only)
  await db.run(`
    INSERT INTO usage_log (user_id, session_id, project_id, mode, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, raw_cost, charged_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [userId, sessionId, projectId, mode, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, rawCost, chargedCost]);

  const updated = await db.get('SELECT balance, wallet_balance FROM users WHERE id = ?', [userId]) as { balance: number; wallet_balance: number };

  return { rawCost, chargedCost, newBalance: updated?.balance ?? 0, newWalletBalance: updated?.wallet_balance ?? 0 };
}

/**
 * Check if a user has sufficient funds to proceed.
 * True if wallet_balance > 0, OR (wallet_auto_spend is on AND main balance > 0).
 */
export async function hasSufficientBalance(userId: number): Promise<boolean> {
  const db = getAdapter();
  const user = await db.get('SELECT balance, wallet_balance, wallet_auto_spend FROM users WHERE id = ?', [userId]) as { balance: number; wallet_balance: number | null; wallet_auto_spend: number } | undefined;
  if (!user) return false;
  const wallet = user.wallet_balance ?? 0;   // guard against NULL rows pre-migration
  const balance = user.balance ?? 0;
  if (wallet > 0) return true;
  if (user.wallet_auto_spend === 1 && balance > 0) return true;
  return false;
}

/**
 * Transfer credits from main balance to wallet (bot fuel tank).
 */
export async function transferToWallet(userId: number, amount: number): Promise<{ newBalance: number; newWalletBalance: number }> {
  const db = getAdapter();
  const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]) as { balance: number } | undefined;
  if (!user) throw new Error('User not found');
  const actual = Math.min(amount, user.balance);
  if (actual <= 0) throw new Error('Insufficient credits to transfer');
  await db.get('UPDATE users SET balance = balance - ?, wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?', [actual, actual, userId]);
  const updated = await db.get('SELECT balance, wallet_balance FROM users WHERE id = ?', [userId]) as { balance: number; wallet_balance: number };
  return { newBalance: updated.balance, newWalletBalance: updated.wallet_balance };
}

/**
 * Get a user's current balance (for top-bar display).
 * Returns only the number — nothing else.
 */
export async function getUserBalance(userId: number): Promise<number> {
  const db = getAdapter();
  const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]) as { balance: number } | undefined;
  return user?.balance ?? 0;
}

/**
 * Translate internal token limit to a user-friendly label.
 * Raw token numbers are NEVER shown to users.
 */
export function friendlySessionLimit(maxTokens: number | null): string {
  if (!maxTokens || maxTokens === 0) return "Unlimited — go wild! 🚀";
  if (maxTokens <= 8000) return "Short session";
  if (maxTokens <= 32000) return "Medium session";
  if (maxTokens <= 100000) return "Long session";
  return "Extended session";
}
