/**
 * hook-system.ts â€” Ruflo-inspired hook/event system for SUNy's agent loop.
 *
 * Replaces inline code injection (e.g., interaction memory stuffing, training
 * scorer calls, behavioral rule extraction) with clean, registerable hooks
 * that fire at defined points in the agent loop lifecycle.
 *
 * â”€â”€ Usage â”€â”€
 *   const hookSystem = new HookSystem();
 *
 *   // Register a hook
 *   hookSystem.register('postResponse', 'myHook', async (ctx) => { ... }, { priority: 10 });
 *
 *   // Fire all hooks for an event
 *   await hookSystem.fire('postResponse', { userId, projectId, ... });
 *
 * â”€â”€ Events â”€â”€
 *   preToolUse     â€” before each tool call (ctx: { toolName, args, userId })
 *   postToolUse    â€” after each tool call (ctx: { toolName, args, result, userId })
 *   preResponse    â€” before sending the response to the user (ctx: { userId, content })
 *   postResponse   â€” after response is complete (ctx: { userId, projectId, sessionId, content, changedFiles, ... })
 *   onError        â€” when an error occurs (ctx: { userId, error, phase })
 */

export type HookEvent =
  | 'preToolUse'
  | 'postToolUse'
  | 'preResponse'
  | 'postResponse'
  | 'onError';

export interface HookContext {
  userId: number;
  projectId?: number | null;
  sessionId?: string;
  mode?: string;
  event: HookEvent;
  timestamp: number;
  // Event-specific data
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  content?: string;
  changedFiles?: string[];
  error?: Error;
  phase?: string;
  // Allow extensibility
  [key: string]: unknown;
}

export type HookHandler = (ctx: HookContext) => Promise<void> | void;

export interface HookRegistration {
  name: string;
  handler: HookHandler;
  priority: number;
  once: boolean;
}

// â”€â”€ Hook System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class HookSystem {
  private hooks: Map<HookEvent, HookRegistration[]> = new Map();
  private firedOnce: Set<string> = new Set();  // "event:name" â†’ has fired

  /**
   * Register a hook handler for a specific event.
   */
  register(
    event: HookEvent,
    name: string,
    handler: HookHandler,
    options: { priority?: number; once?: boolean } = {},
  ): void {
    const priority = options.priority ?? 10;
    const once = options.once ?? false;

    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }

    const registrations = this.hooks.get(event)!;

    // Remove existing with same name (allows re-registration)
    const existingIdx = registrations.findIndex(r => r.name === name);
    if (existingIdx >= 0) {
      registrations.splice(existingIdx, 1);
    }

    registrations.push({ name, handler, priority, once });

    // Sort by priority (lower = runs first)
    registrations.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Unregister a hook by event and name.
   */
  unregister(event: HookEvent, name: string): void {
    const registrations = this.hooks.get(event);
    if (!registrations) return;

    const idx = registrations.findIndex(r => r.name === name);
    if (idx >= 0) {
      registrations.splice(idx, 1);
    }

    if (registrations.length === 0) {
      this.hooks.delete(event);
    }
  }

  /**
   * Fire all hooks for an event. Runs sequentially in priority order.
   * Never throws â€” errors are caught and logged.
   */
  async fire(event: HookEvent, ctx: Partial<HookContext>): Promise<void> {
    const registrations = this.hooks.get(event);
    if (!registrations || registrations.length === 0) return;

    const fullCtx: HookContext = {
      userId: ctx.userId ?? 0,
      event,
      timestamp: Date.now(),
      ...ctx,
    };

    const toRemove: string[] = [];

    for (const reg of registrations) {
      // Check once semantics
      const firedKey = `${event}:${reg.name}`;
      if (reg.once && this.firedOnce.has(firedKey)) continue;

      try {
        await reg.handler(fullCtx);
        if (reg.once) {
          this.firedOnce.add(firedKey);
        }
      } catch (err) {
        console.warn(`[hook-system] Error in "${reg.name}" handler for ${event}:`, (err as Error).message);
      }

      // Remove once handlers after they fire
      if (reg.once) {
        toRemove.push(reg.name);
      }
    }

    // Clean up once handlers (for next event fire)
    for (const name of toRemove) {
      this.unregister(event, name);
    }
  }

  /**
   * Get all registrations for debugging/display.
   */
  getRegistrations(): Record<HookEvent, string[]> {
    const result: Record<string, string[]> = {};
    for (const [event, regs] of this.hooks.entries()) {
      result[event] = regs.map(r => `${r.name} (priority=${r.priority})`);
    }
    return result as Record<HookEvent, string[]>;
  }

  /**
   * Reset all hooks (useful for testing).
   */
  reset(): void {
    this.hooks.clear();
    this.firedOnce.clear();
  }
}

// â”€â”€ Singleton â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Global hook system instance. */
export const hookSystem = new HookSystem();
