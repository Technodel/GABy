/**
 * @gaby/sdk — Extension system for building SUNy plugins.
 *
 * Extensions allow third-party developers to add custom tools,
 * hooks, and behaviors to the SUNy agent loop.
 */

import type { ToolDefinition } from './tool';

export interface ExtensionManifest {
  /** Package name (e.g. "@my-org/suny-slack") */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Semantic version */
  version: string;
  /** Short description */
  description: string;
  /** Author info */
  author?: string;
  /** Link to docs or repo */
  homepage?: string;
  /** Optional icon (emoji or URL) */
  icon?: string;
}

export type ExtensionEvent =
  | 'beforeRequest'
  | 'afterRequest'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'onError'
  | 'onStreamChunk';

export interface ExtensionHook<T = unknown> {
  event: ExtensionEvent;
  handler: (payload: T, context: ExtensionContext) => Promise<void> | void;
}

export interface ExtensionContext {
  userId: number;
  sessionId: string;
  projectId?: number;
  manifest: ExtensionManifest;
}

export interface Extension {
  manifest: ExtensionManifest;
  /** Tools this extension provides */
  tools?: ToolDefinition[];
  /** Event hooks */
  hooks?: ExtensionHook[];
  /** Called when the extension is activated */
  onActivate?: (context: ExtensionContext) => Promise<void>;
  /** Called when the extension is deactivated */
  onDeactivate?: (context: ExtensionContext) => Promise<void>;
}

/**
 * Create a typed extension definition.
 *
 * @example
 * ```ts
 * const slackExtension = createExtension({
 *   manifest: {
 *     name: '@gaby/slack',
 *     displayName: 'Slack Integration',
 *     version: '1.0.0',
 *     description: 'Post SUNy results to Slack channels',
 *   },
 *   tools: [postToSlackTool],
 *   hooks: [
 *     { event: 'afterRequest', handler: notifySlack },
 *   ],
 * });
 * ```
 */
export function createExtension(extension: Extension): Extension {
  return extension;
}
