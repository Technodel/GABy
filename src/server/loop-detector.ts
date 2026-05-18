/**
 * SUNy Loop Detector — detects when the AI is stuck in repetitive cycles.
 *
 * Adapted from ANUS loop detection. Works at the turn level:
 *   - Monitors consecutive tool calls for identical repeats
 *   - Detects content-level repetition in final responses
 *   - Injects guidance when a loop pattern is confirmed
 *
 * Integration: agent-loop.ts calls recordToolCall() after each streamText turn,
 * then checkAndIntervene() before the next turn.
 */

import crypto from 'crypto';

// -- Types --------------------------------------------------------------------

export interface ToolCallRecord {
  name: string;
  argsHash: string;
  timestamp: number;
}

export interface LoopReport {
  detected: boolean;
  type: LoopType | null;
  message: string;
  repeatedTool: string;
  repetitionCount: number;
}

export enum LoopType {
  IDENTICAL_TOOL_CALLS = 'consecutive_identical_tool_calls',
  ALTERNATING_TOOLS = 'alternating_tool_pattern',
  REPETITIVE_RESPONSE = 'repetitive_response',
}

// -- Configuration ------------------------------------------------------------

const CONSECUTIVE_IDENTICAL_THRESHOLD = 4;
// e.g., tool_a, tool_b, tool_a, tool_b, tool_a, tool_b
const ALTERNATING_PATTERN_LENGTH = 4;
const MAX_HISTORY_TURNS = 20;

// -- Service ------------------------------------------------------------------

export class LoopDetector {
  private turnHistory: ToolCallRecord[] = [];
  private consecutiveIdentical = 0;
  private lastToolCallKey: string | null = null;
  private loopReported = false;

  /** Hash tool name + args for identity comparison */
  private hashToolCall(name: string, args: Record<string, unknown>): string {
    return crypto
      .createHash('sha256')
      .update(`${name}:${JSON.stringify(args)}`)
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Record a tool call made during an agent turn.
   * Returns a LoopReport if a loop is detected.
   */
  recordToolCall(
    name: string,
    args: Record<string, unknown>,
  ): LoopReport | null {
    if (this.loopReported) return null; // Already handled

    const key = this.hashToolCall(name, args);
    const record: ToolCallRecord = {
      name,
      argsHash: key,
      timestamp: Date.now(),
    };

    this.turnHistory.push(record);
    if (this.turnHistory.length > MAX_HISTORY_TURNS) {
      this.turnHistory.shift();
    }

    // Check 1: Consecutive identical tool calls
    if (this.lastToolCallKey === key) {
      this.consecutiveIdentical++;
      if (this.consecutiveIdentical >= CONSECUTIVE_IDENTICAL_THRESHOLD) {
        this.loopReported = true;
        return {
          detected: true,
          type: LoopType.IDENTICAL_TOOL_CALLS,
          message: `You called "${name}" with identical arguments ${this.consecutiveIdentical} times in a row. This is a loop. Stop repeating yourself and try a different approach.`,
          repeatedTool: name,
          repetitionCount: this.consecutiveIdentical,
        };
      }
    } else {
      this.consecutiveIdentical = 1;
      this.lastToolCallKey = key;
    }

    // Check 2: Alternating pattern (a,b,a,b,a,b)
    if (this.turnHistory.length >= ALTERNATING_PATTERN_LENGTH) {
      const recent = this.turnHistory.slice(-ALTERNATING_PATTERN_LENGTH);
      const names = recent.map((r) => r.name);
      // Check a,b,a,b pattern
      if (
        names[0] === names[2] &&
        names[1] === names[3] &&
        names[0] !== names[1]
      ) {
        // Also check the args pattern matches
        const args = recent.map((r) => r.argsHash);
        if (args[0] === args[2] && args[1] === args[3]) {
          this.loopReported = true;
          return {
            detected: true,
            type: LoopType.ALTERNATING_TOOLS,
            message: `You are alternating between "${names[0]}" and "${names[1]}" with the same arguments. This is a loop. Step back and try a completely different approach.`,
            repeatedTool: `${names[0]} ↔ ${names[1]}`,
            repetitionCount: ALTERNATING_PATTERN_LENGTH,
          };
        }
      }
    }

    return null;
  }

  /**
   * Record all tool calls from a completed streamText turn.
   */
  recordTurn(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): LoopReport | null {
    for (const tc of toolCalls) {
      const report = this.recordToolCall(tc.name, tc.args);
      if (report) return report;
    }
    return null;
  }

  /** Reset state for a new conversation or after loop is handled */
  reset(): void {
    this.turnHistory = [];
    this.consecutiveIdentical = 0;
    this.lastToolCallKey = null;
    this.loopReported = false;
  }

  /** Allow loop detection to re-arm after the AI has acknowledged and changed behavior */
  rearm(): void {
    this.loopReported = false;
  }

  get isLoopReported(): boolean {
    return this.loopReported;
  }
}
