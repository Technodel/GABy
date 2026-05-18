/**
 * @gaby/sdk — Official SUNy/GABy SDK for building extensions, tools, and integrations.
 *
 * Usage:
 *   import { createTool, createExtension, type AgentRequest, type AgentResponse } from '@gaby/sdk';
 *
 * The SDK is framework-agnostic but works seamlessly with Vercel AI SDK tools.
 */

export { createTool, type ToolDefinition, type ToolExecutor } from './tool';
export { createExtension, type Extension, type ExtensionManifest, type ExtensionHook } from './extension';
export {
  createMemoryAdapter,
  type MemoryAdapter,
  type MemoryEntry,
  type MemorySearchResult,
} from './memory';
export {
  createAuthProvider,
  type AuthProvider,
  type AuthSession,
  type AuthCredentials,
} from './auth';
export {
  createBillingPlugin,
  type BillingPlugin,
  type CostEstimate,
  type UsageRecord,
} from './billing';

// ── Core types ──────────────────────────────────────────────────────────────

export interface AgentRequest {
  userId: number;
  sessionId: string;
  projectId?: number;
  mode: 'free' | 'fast' | 'smart' | 'pro' | 'auto';
  message: string;
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  systemPrompt: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  changedFiles: string[];
  toolCalls: string[];
  error?: string;
}

export interface ProjectInfo {
  id: number;
  name: string;
  localPath: string;
  userId: number;
}

export interface UserInfo {
  id: number;
  username: string;
  displayName?: string;
  balance: number;
  mode: string;
}

// ── Version ─────────────────────────────────────────────────────────────────

export const VERSION = '1.0.0';

/**
 * Platform info for extension authors — helps extensions know
 * which capabilities are available at runtime.
 */
export const PLATFORM = {
  name: 'SUNy',
  version: '3.0',
  sdk: VERSION,
  hasBridge: true,
  hasMcp: true,
  supportsVision: true,
  supportsToolCalling: true,
  supportsStreaming: true,
} as const;

// ── Utility ─────────────────────────────────────────────────────────────────

export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

export function isNode(): boolean {
  return typeof process !== 'undefined' && process.versions?.node != null;
}
