import WebSocket from 'ws';
import { buildUserEvent, buildChatEvent } from './sanitizer';

/**
 * Manages WebSocket connections from user browser tabs.
 * Separate from bridge-manager (which tracks local agent bridges).
 *
 * One active connection per user (latest-wins). This prevents duplicate
 * message delivery caused by React StrictMode double-mounting effects.
 */
type CheckpointResolver = (approved: boolean) => void;
type BudgetGateResolver = (decision: 'continue' | 'budget_mode' | 'extend' | 'stop') => void;

class UserClientManager {
  private clients = new Map<number, WebSocket>();
  private checkpoints = new Map<number, CheckpointResolver>();
  private budgetGates = new Map<number, BudgetGateResolver>();

  register(userId: number, ws: WebSocket): void {
    // Close the previous connection if any (handles StrictMode double-connect)
    const existing = this.clients.get(userId);
    if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
      existing.close(1000, 'replaced_by_new_connection');
    }
    this.clients.set(userId, ws);

    ws.on('close', () => {
      if (this.clients.get(userId) === ws) this.clients.delete(userId);
    });
    ws.on('error', () => {
      if (this.clients.get(userId) === ws) this.clients.delete(userId);
    });
  }

  /**
   * Push a sanitized event to the user's active browser tab.
   * Payload passes through full sanitization (keys + string patterns).
   * Use for UI chrome: narration, tool calls, status, errors, etc.
   */
  pushToUser(userId: number, event: string, payload: Record<string, unknown>): void {
    const ws = this.clients.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(buildUserEvent(event, payload));
  }

  /**
   * Push chat content to the user's active browser tab.
   * Uses lightweight sanitization (keys only, no string patterns).
   * Use for AI conversational content: stream chunks, final responses.
   * This allows the AI to freely use model/provider names in natural language.
   */
  pushChatContent(userId: number, event: string, payload: Record<string, unknown>): void {
    const ws = this.clients.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(buildChatEvent(event, payload));
  }

  /**
   * Push a balance update to the user â€” sends ONLY the new balance total.
   * No cost breakdown, no token counts.
   */
  pushBalance(userId: number, balance: number): void {
    this.pushToUser(userId, 'suny:balance', { balance });
  }

  /**
   * Push a narrated message to the user's chat window.
   */
  pushNarration(userId: number, message: string): void {
    this.pushToUser(userId, 'suny:narration', { message });
  }

  /**
   * Pause the agent loop and ask the user to approve or abort.
   * Resolves true (proceed) or false (abort). Times out after 5 minutes.
   */
  waitForCheckpoint(userId: number, label: string, details: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.checkpoints.set(userId, resolve);
      this.pushToUser(userId, 'suny:checkpoint', { label, details });
      // Auto-approve after 5 min if user doesn't respond
      setTimeout(() => {
        if (this.checkpoints.has(userId)) {
          this.checkpoints.delete(userId);
          resolve(true);
        }
      }, 5 * 60_000);
    });
  }

  /**
   * Called when the user sends checkpoint:approve or checkpoint:abort.
   */
  resolveCheckpoint(userId: number, approved: boolean): void {
    const resolver = this.checkpoints.get(userId);
    if (resolver) {
      this.checkpoints.delete(userId);
      resolver(approved);
    }
  }

  hasPendingCheckpoint(userId: number): boolean {
    return this.checkpoints.has(userId);
  }

  /**
   * Pause the agent loop at 90% budget and ask user to choose:
   * continue | budget_mode | extend | stop
   * Times out after 5 minutes defaulting to 'budget_mode'.
   */
  waitForBudgetGate(userId: number, spent: number, cap: number): Promise<'continue' | 'budget_mode' | 'extend' | 'stop'> {
    return new Promise((resolve) => {
      this.budgetGates.set(userId, resolve);
      this.pushToUser(userId, 'suny:budget_gate', { spent, cap, pct: spent / cap });
      setTimeout(() => {
        if (this.budgetGates.has(userId)) {
          this.budgetGates.delete(userId);
          resolve('budget_mode');
        }
      }, 5 * 60_000);
    });
  }

  /**
   * Called when the user sends budget_gate:* messages.
   */
  resolveBudgetGate(userId: number, decision: 'continue' | 'budget_mode' | 'extend' | 'stop'): void {
    const resolver = this.budgetGates.get(userId);
    if (resolver) {
      this.budgetGates.delete(userId);
      resolver(decision);
    }
  }
}

export const userClientManager = new UserClientManager();
