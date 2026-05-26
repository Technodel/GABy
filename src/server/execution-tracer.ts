/**
 * SUNy Execution Tracer â€” opt-in stdout/stderr/exitCode enrichment for failed commands.
 *
 * When enabled (via session flag or feature flag), captures enriched execution
 * data for every shell command. On failure, the data feeds into the self_heal
 * tool so the AI sees exact stdout, stderr, and exit code â€” not just an error message.
 *
 * Design:
 *   - Per-session in-memory ring buffer holds the last N failed executions
 *   - Respects ff_execution_tracing feature flag + per-session opt-in
 *   - Redacts secrets using the same patterns as security-guard.ts
 *   - Self_heal tool automatically checks for latest trace
 */

import { scanForCredentials } from './security-guard';
import { isFeatureEnabled } from './feature-flags';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ExecutionTrace {
  userId: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timestamp: number;
  cwd?: string;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// In-memory ring buffer (per-user, auto-evicts old entries)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MAX_TRACES_PER_USER = 5;

/** userId â†’ circular buffer of failed execution traces */
const traceStore = new Map<number, ExecutionTrace[]>();

/** Per-session opt-in flag (default: off). Set via agent session start. */
const sessionOptIn = new Set<string>(); // key: `${userId}:${sessionId}`

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public API
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Enable tracing for a specific session.
 */
export function enableTracing(userId: number, sessionId: string): void {
  sessionOptIn.add(`${userId}:${sessionId}`);
}

/**
 * Disable tracing for a specific session.
 */
export function disableTracing(userId: number, sessionId: string): void {
  sessionOptIn.delete(`${userId}:${sessionId}`);
}

/**
 * Check if tracing is active for this userId.
 * Tracing is active if: feature flag is ON AND (session opted in OR no sessionId specified).
 */
export function isTracingEnabled(userId: number, sessionId?: string): boolean {
  if (!isFeatureEnabled('ff_execution_tracing')) return false;
  if (sessionId && !sessionOptIn.has(`${userId}:${sessionId}`)) return false;
  return true;
}

/**
 * Record a failed execution for later retrieval.
 * Automatically redacts credentials from stored data.
 */
export function recordFailedExecution(trace: ExecutionTrace): void {
  const { userId } = trace;

  // Redact credentials from stored output
  const redactedTrace: ExecutionTrace = {
    ...trace,
    stdout: redactCredentials(trace.stdout),
    stderr: redactCredentials(trace.stderr),
    command: redactCredentials(trace.command),
  };

  let traces = traceStore.get(userId);
  if (!traces) {
    traces = [];
    traceStore.set(userId, traces);
  }

  traces.push(redactedTrace);

  // Evict oldest if over limit
  if (traces.length > MAX_TRACES_PER_USER) {
    traces.shift();
  }
}

/**
 * Get the latest failed execution trace for a user.
 * Returns null if no traces available or tracing is disabled.
 */
export function getLatestTrace(userId: number, sessionId?: string): ExecutionTrace | null {
  if (!isTracingEnabled(userId, sessionId)) return null;
  const traces = traceStore.get(userId);
  if (!traces || traces.length === 0) return null;
  return traces[traces.length - 1];
}

/**
 * Get all failed execution traces for a user (newest first).
 */
export function getTraces(userId: number, limit = 3): ExecutionTrace[] {
  const traces = traceStore.get(userId);
  if (!traces) return [];
  return traces.slice(-limit).reverse();
}

/**
 * Format the latest trace as context for the self_heal tool.
 */
export function formatTraceForHeal(userId: number, sessionId?: string): string {
  const trace = getLatestTrace(userId, sessionId);
  if (!trace) return '';

  const cmdPreview = trace.command.length > 200
    ? trace.command.slice(0, 200) + '...'
    : trace.command;

  const stdoutPreview = trace.stdout.length > 500
    ? trace.stdout.slice(0, 500) + '\n... [truncated]'
    : trace.stdout;

  const stderrPreview = trace.stderr.length > 500
    ? trace.stderr.slice(0, 500) + '\n... [truncated]'
    : trace.stderr;

  return [
    `<execution_trace>`,
    `  <command>${escapeXml(cmdPreview)}</command>`,
    `  <exit_code>${trace.exitCode ?? 'unknown'}</exit_code>`,
    `  <duration_ms>${trace.durationMs}</duration_ms>`,
    trace.stdout ? `  <stdout>${escapeXml(stdoutPreview)}</stdout>` : '',
    trace.stderr ? `  <stderr>${escapeXml(stderrPreview)}</stderr>` : '',
    `</execution_trace>`,
  ].filter(Boolean).join('\n');
}

/**
 * Clear all traces for a user (on session end).
 */
export function clearTraces(userId: number): void {
  traceStore.delete(userId);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function redactCredentials(text: string): string {
  const result = scanForCredentials(text);
  if (!result.hasCredentials) return text;

  let redacted = text;
  for (const match of result.matches) {
    // Mask the matched line's sensitive portion
    const linePattern = match.preview.replace(/***/g, '***');
    redacted = redacted.replace(
      new RegExp(match.preview.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\*/g, '.*?'), 'g'),
      match.preview,
    );
  }
  return redacted;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
