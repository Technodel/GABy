import { evaluate, parse } from 'mathjs';
import { getAdapter } from './db';
import type { DbAdapter } from './db-types';

// Allowed identifiers in markup formulas — anything else is rejected at save time
// and stripped at evaluation time via a restricted scope.
export const FORMULA_ALLOWED_VARS = new Set(['cost', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens']);

/**
 * Validate a markup formula string without executing it.
 * Returns an error message if invalid, undefined if OK.
 */
export function validateMarkupFormula(formula: string): string | undefined {
  if (!formula || formula.trim().length === 0) return 'Formula cannot be empty';
  try {
    const node = parse(formula);
    // Walk AST and reject any symbol not in the allowed list
    const banned: string[] = [];
    node.traverse((n: any) => {
      if (n.type === 'SymbolNode' && !FORMULA_ALLOWED_VARS.has(n.name)) {
        banned.push(n.name);
      }
    });
    if (banned.length > 0) return `Formula uses disallowed identifiers: ${banned.join(', ')}. Only cost, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens are permitted.`;
    // Test-evaluate with safe values to catch runtime errors
    const testResult = evaluate(formula, { cost: 0.001, input_tokens: 1000, output_tokens: 500, cache_write_tokens: 0, cache_read_tokens: 0 });
    if (typeof testResult !== 'number' || isNaN(testResult)) return 'Formula must evaluate to a number';
  } catch (e) {
    return `Formula parse error: ${(e as Error).message}`;
  }
  return undefined;
}

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
 * All values are internal â€” NEVER exposed to user clients.
 * Returns only the new balance total for the WebSocket suny:balance event.
 *
 * Cache pricing multipliers (vs. base input rate):
 *   cacheWriteTokens: 1.25x  (one-time cost to store block in Anthropic's cache)
 *   cacheReadTokens:  0.10x  (90% discount â€” the payoff on cached turns)
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
  // This is what we ACTUALLY pay the provider â€” used for internal P&L only.
  // Cache write = 1.25x input rate (one-time); cache read = 0.10x input rate (provider discount).
  const rawCost =
    inputTokens * inputBase +
    outputTokens * outputBase +
    cacheWriteTokens * inputBase * 1.25 +
    cacheReadTokens * inputBase * 0.10;

  // USER-VISIBLE COST: user gets a 30% discount on cache reads (they pay 0.7x).
  const inputCost =
    inputTokens * inputSale +
    cacheWriteTokens * inputSale * 1.25 +
    cacheReadTokens * inputSale * 0.7;

  const outputCost = outputTokens * outputSale;

  // Apply admin markup formula (mathjs expression) to the INPUT cost only,
  // because output tokens are never discounted by the provider, and the user 
  // requested that output tokens remain at original price without markup.
  let chargedCost: number;
  try {
    // Evaluate with a restricted scope — only the named billing variables are
    // visible, preventing formula injection via mathjs built-ins like import().
    const scope = {
      cost: inputCost,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens: cacheReadTokens,
    };
    let markedUpInput = evaluate(pricing.markup_formula, scope) as number;
    if (typeof markedUpInput !== 'number' || isNaN(markedUpInput) || markedUpInput < 0) {
      markedUpInput = inputCost;
    }
    chargedCost = markedUpInput + outputCost;
  } catch {
    chargedCost = inputCost + outputCost;
  }

  // Deduct from user balances atomically.
  // All three writes (wallet deduct, balance deduct, usage_log insert) run inside
  // a single transaction so concurrent requests cannot double-bill or split charges.
  // 1. Always deduct from wallet_balance first (the bot's dedicated fuel tank).
  // 2. If wallet runs out, overflow to main balance regardless of auto_spend.
  //    auto_spend only controls whether the UX shows a warning — billing integrity
  //    must never allow undercharging since the AI provider was already called.
  const updated = await db.transaction(async (trx: DbAdapter) => {
    const userRow = await trx.get<{ wallet_balance: number; wallet_auto_spend: number; balance: number }>(
      'SELECT wallet_balance, wallet_auto_spend, balance FROM users WHERE id = ?', [userId]
    );

    const currentWallet = userRow?.wallet_balance ?? 0;
    const walletDeduct = Math.min(chargedCost, currentWallet);
    const balanceDeduct = Math.max(0, chargedCost - walletDeduct);

    await trx.run('UPDATE users SET wallet_balance = MAX(0, wallet_balance - ?) WHERE id = ?', [walletDeduct, userId]);
    if (balanceDeduct > 0) {
      await trx.run('UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?', [balanceDeduct, userId]);
    }

    // Log usage (internal only)
    await trx.run(`
      INSERT INTO usage_log (user_id, session_id, project_id, mode, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, raw_cost, charged_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, sessionId, projectId, mode, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, rawCost, chargedCost]);

    return trx.get<{ balance: number; wallet_balance: number }>(
      'SELECT balance, wallet_balance FROM users WHERE id = ?', [userId]
    );
  });

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
  const result = await db.transaction(async (trx: DbAdapter) => {
    await trx.run('UPDATE users SET balance = balance - ?, wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?', [actual, actual, userId]);
    return trx.get<{ balance: number; wallet_balance: number }>(
      'SELECT balance, wallet_balance FROM users WHERE id = ?', [userId]
    );
  });
  if (!result) throw new Error('Failed to read updated balances after transfer');
  return { newBalance: result.balance, newWalletBalance: result.wallet_balance };
}

/**
 * Get a user's current balance (for top-bar display).
 * Returns only the number â€” nothing else.
 */
export async function getUserBalance(userId: number): Promise<number> {
  const db = getAdapter();
  const user = await db.get('SELECT balance FROM users WHERE id = ?', [userId]) as { balance: number } | undefined;
  return user?.balance ?? 0;
}

/**
 * Get a user's bot wallet balance.
 * Returns only the number — nothing else.
 */
export async function getUserWalletBalance(userId: number): Promise<number> {
  const db = getAdapter();
  const user = await db.get('SELECT wallet_balance FROM users WHERE id = ?', [userId]) as { wallet_balance: number } | undefined;
  return user?.wallet_balance ?? 0;
}

/**
 * Translate internal token limit to a user-friendly label.
 * Raw token numbers are NEVER shown to users.
 */
export function friendlySessionLimit(maxTokens: number | null): string {
  if (!maxTokens || maxTokens === 0) return "Unlimited â€” go wild! ðŸš€";
  if (maxTokens <= 8000) return "Short session";
  if (maxTokens <= 32000) return "Medium session";
  if (maxTokens <= 100000) return "Long session";
  return "Extended session";
}
