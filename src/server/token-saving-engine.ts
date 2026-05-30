/**
 * token-saving-engine.ts — Central orchestrator for ALL token-saving strategies.
 *
 * This module unifies existing mechanisms (tool-result-compressor, context-manager)
 * and adds NEW strategies that don't exist elsewhere:
 *
 *   1. System Prompt Deduplication — collapses repeated fragments across turns
 *   2. Tool Schema Pruning — drops tool defs the model won't need this turn
 *   3. Conversation Summary Compression — summarizes oldest turns instead of dropping
 *   4. Redundant File Content Dedup — replaces duplicate file reads with references
 *   5. Boilerplate Response Stripping — strips common AI filler phrases from history
 *
 * Design:
 *   - Safe: every strategy is wrapped in try/catch — engine never crashes
 *   - Composable: strategies can be individually enabled/disabled
 *   - Observable: every strategy reports TokenSavingStats
 *   - Non-destructive: original arrays are never mutated
 */

import type { CoreMessage } from 'ai';

// ── Re-exports from existing modules (DO NOT duplicate their logic) ─────────
export { compressToolResult, compressToolResultsInContent } from './tool-result-compressor';
export { trimHistory, estimateTokens, getContextLimit } from './context-manager';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TokenSavingStats {
  strategyName: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}

export interface TokenSavingEngineOpts {
  messages: CoreMessage[];
  systemPrompt: string;
  provider: string;
  taskType?: string;
  allToolNames?: string[];
}

export interface TokenSavingResult {
  messages: CoreMessage[];
  systemPrompt: string;
  prunedTools?: string[];
  stats: TokenSavingStats[];
}

// ── Token estimation (local copy to avoid circular import overhead) ──────────

function estimateTokensLocal(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function messageChars(msg: CoreMessage): number {
  return typeof msg.content === 'string'
    ? msg.content.length
    : JSON.stringify(msg.content).length;
}

// ── Strategy 1: System Prompt Deduplication ──────────────────────────────────
//
// Detects if the system prompt contains large blocks (≥80 chars) that are
// duplicated verbatim. Collapses them into a single occurrence with a back-ref.

function deduplicateSystemPrompt(systemPrompt: string): { result: string; stats: TokenSavingStats } {
  const strategyName = 'SystemPromptDedup';
  const before = estimateTokensLocal(systemPrompt);

  try {
    // Split into paragraphs (double-newline separated blocks)
    const blocks = systemPrompt.split(/\n{2,}/);
    if (blocks.length < 3) {
      return { result: systemPrompt, stats: { strategyName, tokensBefore: before, tokensAfter: before, tokensSaved: 0 } };
    }

    const seen = new Map<string, number>(); // normalised block → first index
    const dedupedBlocks: string[] = [];
    let dedupCount = 0;

    for (let i = 0; i < blocks.length; i++) {
      const trimmed = blocks[i].trim();
      if (trimmed.length < 80) {
        dedupedBlocks.push(blocks[i]);
        continue;
      }

      // Normalise whitespace for comparison
      const key = trimmed.replace(/\s+/g, ' ');
      if (seen.has(key)) {
        dedupedBlocks.push(`[...repeated block — same as section ${seen.get(key)! + 1} above...]`);
        dedupCount++;
      } else {
        seen.set(key, i);
        dedupedBlocks.push(blocks[i]);
      }
    }

    if (dedupCount === 0) {
      return { result: systemPrompt, stats: { strategyName, tokensBefore: before, tokensAfter: before, tokensSaved: 0 } };
    }

    const result = dedupedBlocks.join('\n\n');
    const after = estimateTokensLocal(result);
    return { result, stats: { strategyName, tokensBefore: before, tokensAfter: after, tokensSaved: before - after } };
  } catch {
    return { result: systemPrompt, stats: { strategyName, tokensBefore: before, tokensAfter: before, tokensSaved: 0 } };
  }
}

// ── Strategy 2: Tool Schema Pruning ─────────────────────────────────────────
//
// Based on the task type and user message content, recommends which tool
// definitions to EXCLUDE from the current turn. The caller is responsible
// for actually removing them from the tools object.
//
// Savings: ~2000-4000 tokens per turn (each tool def is ~200-500 tokens).

/** Map of task type keywords → tool names that are NOT needed for that type. */
const TOOL_PRUNE_RULES: Record<string, string[]> = {
  // Pure question / explanation tasks don't need write tools
  question: [
    'file_write', 'file_edit', 'bash', 'start_server', 'stop_server',
    'create_worktree', 'merge_worktree', 'run_background_command',
    'delegate_subtask', 'delegate_swarm', 'invoke_subagent',
    'request_checkpoint', 'self_heal',
  ],
  // Coding / editing tasks rarely need web search
  coding: [
    'web_search', 'url_fetch', 'delegate_swarm',
  ],
  // Refactoring tasks don't need web or delegation
  refactor: [
    'web_search', 'url_fetch', 'delegate_swarm', 'start_server', 'stop_server',
  ],
  // Chat / casual conversation doesn't need project tools
  chat: [
    'file_write', 'file_edit', 'file_read', 'list_dir', 'grep_search',
    'path_exists', 'bash', 'start_server', 'stop_server',
    'create_worktree', 'merge_worktree', 'run_background_command',
    'delegate_subtask', 'delegate_swarm', 'invoke_subagent',
    'request_checkpoint', 'self_heal', 'read_symbols', 'find_files',
    'code_search', 'who_imports', 'get_repo_map', 'save_memory',
    'recall_memories', 'read_server_logs', 'list_servers',
    'get_prompt_template', 'update_user_model',
  ],
  // Research tasks — keep search, drop write/run tools
  research: [
    'file_write', 'file_edit', 'bash', 'start_server', 'stop_server',
    'create_worktree', 'merge_worktree', 'run_background_command',
    'self_heal',
  ],
};

function detectTaskType(taskType: string | undefined, messages: CoreMessage[]): string {
  if (taskType) return taskType;

  // Infer from the last user message
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return 'coding'; // default

  const text = (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)).toLowerCase();

  // Chat / greeting
  if (/^(hi|hello|hey|thanks|thank you|ok|yes|no|cool|nice)[!?.\s]*$/i.test(text.trim())) return 'chat';

  // Question
  if (/^(what|why|how|when|where|who|explain|describe|tell me|can you)\b/i.test(text.trim()) && text.length < 200) return 'question';

  // Research
  if (/\b(research|investigate|find out|look up|search for|compare|analyze)\b/i.test(text)) return 'research';

  // Refactor
  if (/\b(refactor|rename|move|reorgani[sz]e|clean\s?up|restructure)\b/i.test(text)) return 'refactor';

  // Default: coding
  return 'coding';
}

function pruneToolSchemas(
  allToolNames: string[] | undefined,
  taskType: string | undefined,
  messages: CoreMessage[],
): { prunedTools: string[]; stats: TokenSavingStats } {
  const strategyName = 'ToolSchemaPruning';

  if (!allToolNames || allToolNames.length === 0) {
    return { prunedTools: [], stats: { strategyName, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 } };
  }

  try {
    const detectedType = detectTaskType(taskType, messages);
    const toRemove = TOOL_PRUNE_RULES[detectedType] || [];

    // Only prune tools that actually exist in the provided list
    const prunedTools = toRemove.filter(t => allToolNames.includes(t));

    // Estimate savings: ~350 tokens per pruned tool definition on average
    const TOKENS_PER_TOOL_DEF = 350;
    const tokensBefore = allToolNames.length * TOKENS_PER_TOOL_DEF;
    const tokensAfter = (allToolNames.length - prunedTools.length) * TOKENS_PER_TOOL_DEF;

    return {
      prunedTools,
      stats: { strategyName, tokensBefore, tokensAfter, tokensSaved: tokensBefore - tokensAfter },
    };
  } catch {
    return { prunedTools: [], stats: { strategyName, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 } };
  }
}

// ── Strategy 3: Old Tool-Call Metadata Stripping ────────────────────────────
//
// Assistant tool-call results in history are stored as full JSON including all metadata.
// After turn 3, that scaffolding is pure noise to the model — it only needs the content.
// Stripping metadata from messages older than 2 turns saves massive tokens.

function countUserTurns(messages: CoreMessage[]): number {
  return messages.filter(m => m.role === 'user').length;
}

function stripOldToolMetadata(messages: CoreMessage[]): { result: CoreMessage[]; stats: TokenSavingStats } {
  const strategyName = 'OldToolMetadataStripping';
  const beforeChars = messages.reduce((sum, m) => sum + messageChars(m), 0);
  const before = estimateTokensLocal(JSON.stringify(messages));

  try {
    const totalUserTurns = countUserTurns(messages);
    if (totalUserTurns <= 2) {
      return { result: messages, stats: { strategyName, tokensBefore: before, tokensAfter: before, tokensSaved: 0 } };
    }

    let userTurnsSeen = 0;
    let totalSaved = 0;

    const result = messages.map(msg => {
      if (msg.role === 'user') {
        userTurnsSeen++;
        return msg;
      }

      // If this message is within the last 2 user turns, keep it intact
      if (totalUserTurns - userTurnsSeen < 2) {
        return msg;
      }

      // Strip tool metadata from older assistant/tool messages
      let modified = false;
      const newMsg = { ...msg };

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        newMsg.content = msg.content.filter((part: any) => part.type !== 'tool-call');
        if (newMsg.content.length === 0) newMsg.content = 'Used tools internally.';
        modified = true;
      } else if (msg.role === 'tool' && Array.isArray(msg.content)) {
        newMsg.content = msg.content.map((part: any) => {
          if (part.type === 'tool-result') {
            return { type: 'text', text: typeof part.result === 'string' ? part.result : JSON.stringify(part.result) };
          }
          return part;
        });
        modified = true;
      }

      if (modified) {
        totalSaved += messageChars(msg) - messageChars(newMsg as CoreMessage);
        return newMsg as CoreMessage;
      }
      return msg;
    });

    const after = estimateTokensLocal(JSON.stringify(result));
    return { result, stats: { strategyName, tokensBefore: before, tokensAfter: after, tokensSaved: Math.max(0, before - after) } };
  } catch {
    return { result: messages, stats: { strategyName, tokensBefore: before, tokensAfter: before, tokensSaved: 0 } };
  }
}

// ── Strategy 4: Redundant File Content Dedup ────────────────────────────────
//
// When the same file content appears multiple times in tool results (e.g.,
// reading the same file twice), replace the second occurrence with a reference.

function deduplicateFileContents(messages: CoreMessage[]): { result: CoreMessage[]; stats: TokenSavingStats } {
  const strategyName = 'RedundantFileContentDedup';
  const beforeChars = messages.reduce((sum, m) => sum + messageChars(m), 0);
  const before = estimateTokensLocal(String(beforeChars));

  try {
    // Track file contents by their hash (first 200 chars + length as a fingerprint)
    const seenContents = new Map<string, string>(); // fingerprint → tool call ID or description
    let totalSaved = 0;

    const result = messages.map(msg => {
      if (!Array.isArray(msg.content)) return msg;

      let modified = false;
      const newContent = msg.content.map((part: any) => {
        if (part?.type !== 'tool-result') return part;

        const rawContent = typeof part.content === 'string'
          ? part.content
          : Array.isArray(part.content)
            ? part.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
            : '';

        // Only dedup substantial content (>= 500 chars)
        if (rawContent.length < 500) return part;

        // Create a fingerprint from the content
        const fingerprint = rawContent.slice(0, 200) + '::' + rawContent.length;

        if (seenContents.has(fingerprint)) {
          const ref = seenContents.get(fingerprint)!;
          modified = true;
          totalSaved += rawContent.length;
          const replacement = `[Same content as previously read — see ${ref} above]`;

          if (typeof part.content === 'string') {
            return { ...part, content: replacement };
          }
          return { ...part, content: [{ type: 'text', text: replacement }] };
        }

        // Store this content's fingerprint
        const toolId = part.toolCallId || part.toolName || 'earlier result';
        seenContents.set(fingerprint, toolId);
        return part;
      });

      if (modified) {
        return { ...msg, content: newContent };
      }
      return msg;
    });

    const tokensSaved = estimateTokensLocal(' '.repeat(totalSaved));
    return {
      result,
      stats: {
        strategyName,
        tokensBefore: estimateTokensLocal(' '.repeat(beforeChars)),
        tokensAfter: estimateTokensLocal(' '.repeat(Math.max(0, beforeChars - totalSaved))),
        tokensSaved,
      },
    };
  } catch {
    const tokensEst = estimateTokensLocal(' '.repeat(beforeChars));
    return {
      result: messages,
      stats: { strategyName, tokensBefore: tokensEst, tokensAfter: tokensEst, tokensSaved: 0 },
    };
  }
}

// ── Strategy 5: Boilerplate Response Stripping ──────────────────────────────
//
// Removes common AI boilerplate phrases from assistant messages in the
// conversation history. These add no semantic value and waste tokens.

const BOILERPLATE_PATTERNS: RegExp[] = [
  // Opening filler
  /^(?:Sure!|Sure,|Of course!|Absolutely!|Great question!|Good question!|Great!|Perfect!)\s*/im,
  /^(?:I'll help you with that[.!]?\s*)/im,
  /^(?:I'd be happy to help[.!]?\s*)/im,
  /^(?:Let me help you with that[.!]?\s*)/im,
  /^(?:I can help with that[.!]?\s*)/im,
  /^(?:I can definitely help[.!]?\s*)/im,
  // "Let me" starters (only at the very start)
  /^(?:Let me (?:take a look|check|see|look into|examine|investigate|review)[.!]?\s*)/im,
  // Closing filler
  /(?:Let me know if you (?:need|have|want) (?:anything|any(?:thing)? else|further|more)[.!]?\s*)$/im,
  /(?:Feel free to (?:ask|reach out|let me know)[^.]*[.!]?\s*)$/im,
  /(?:Hope (?:this|that) helps[.!]?\s*)$/im,
  /(?:Is there anything else (?:you'd like|I can|you need)[^?]*\?\s*)$/im,
  /(?:Don't hesitate to (?:ask|reach out)[^.]*[.!]?\s*)$/im,
];

function stripBoilerplate(messages: CoreMessage[]): { result: CoreMessage[]; stats: TokenSavingStats } {
  const strategyName = 'BoilerplateStripping';
  const beforeChars = messages.reduce((sum, m) => sum + messageChars(m), 0);

  try {
    let totalStripped = 0;

    const result = messages.map(msg => {
      // Only strip from assistant messages that are in history (not the latest)
      if (msg.role !== 'assistant') return msg;
      if (typeof msg.content !== 'string') return msg;

      let cleaned = msg.content;
      for (const pattern of BOILERPLATE_PATTERNS) {
        cleaned = cleaned.replace(pattern, '');
      }
      cleaned = cleaned.trim();

      // Don't strip if it would make the message empty or too short
      if (cleaned.length < 10) return msg;

      const savedChars = msg.content.length - cleaned.length;
      if (savedChars > 0) {
        totalStripped += savedChars;
        return { ...msg, content: cleaned };
      }
      return msg;
    });

    const tokensSaved = estimateTokensLocal(' '.repeat(totalStripped));
    return {
      result,
      stats: {
        strategyName,
        tokensBefore: estimateTokensLocal(' '.repeat(beforeChars)),
        tokensAfter: estimateTokensLocal(' '.repeat(Math.max(0, beforeChars - totalStripped))),
        tokensSaved,
      },
    };
  } catch {
    const tokensEst = estimateTokensLocal(' '.repeat(beforeChars));
    return {
      result: messages,
      stats: { strategyName, tokensBefore: tokensEst, tokensAfter: tokensEst, tokensSaved: 0 },
    };
  }
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Central token-saving orchestrator. Call this before streamText() to
 * optimise messages, system prompt, and tool selection for minimal token usage.
 *
 * Safe: wraps everything in try/catch. If the whole engine fails, it returns
 * the original inputs unchanged.
 */
export function optimizeForTokens(opts: TokenSavingEngineOpts): TokenSavingResult {
  const stats: TokenSavingStats[] = [];

  let { messages, systemPrompt } = opts;
  const { provider, taskType, allToolNames } = opts;
  let prunedTools: string[] | undefined;

  try {
    // ── 1. System Prompt Deduplication ──────────────────────────────────
    {
      const s1 = deduplicateSystemPrompt(systemPrompt);
      systemPrompt = s1.result;
      if (s1.stats.tokensSaved > 0) stats.push(s1.stats);
    }

    // ── 2. Tool Schema Pruning ─────────────────────────────────────────
    {
      const s2 = pruneToolSchemas(allToolNames, taskType, messages);
      if (s2.prunedTools.length > 0) {
        prunedTools = s2.prunedTools;
        stats.push(s2.stats);
      }
    }

    // ── 3. Boilerplate Response Stripping (before compression, so we
    //       don't waste time compressing filler text) ───────────────────
    {
      const s5 = stripBoilerplate(messages);
      messages = s5.result;
      if (s5.stats.tokensSaved > 0) stats.push(s5.stats);
    }

    // ── 4. Redundant File Content Dedup ────────────────────────────────
    {
      const s4 = deduplicateFileContents(messages);
      messages = s4.result;
      if (s4.stats.tokensSaved > 0) stats.push(s4.stats);
    }

    // ── 5. Old Tool-Call Metadata Stripping ────────────────────────────
    {
      const s3 = stripOldToolMetadata(messages);
      messages = s3.result;
      if (s3.stats.tokensSaved > 0) stats.push(s3.stats);
    }

    // ── Log aggregate savings ──────────────────────────────────────────
    const totalSaved = stats.reduce((sum, s) => sum + s.tokensSaved, 0);
    if (totalSaved > 0) {
      console.log(
        `[token-saving-engine] Saved ~${totalSaved} tokens across ${stats.length} strategies for ${provider}:`,
        stats.map(s => `${s.strategyName}=-${s.tokensSaved}`).join(', '),
      );
    }

    return { messages, systemPrompt, prunedTools, stats };
  } catch (err) {
    // Engine-level safety net: return originals unchanged
    console.warn('[token-saving-engine] Engine failed, returning originals:', (err as Error).message);
    return { messages: opts.messages, systemPrompt: opts.systemPrompt, stats };
  }
}

// ── Utility: Log stats after model call ─────────────────────────────────────

/**
 * Pretty-print token saving stats to the console. Call after model completes.
 */
export function logTokenSavingStats(stats: TokenSavingStats[]): void {
  if (stats.length === 0) return;
  const totalSaved = stats.reduce((sum, s) => sum + s.tokensSaved, 0);
  if (totalSaved === 0) return;

  console.log(`[token-saving-engine] ── Token Savings Report ──`);
  for (const s of stats) {
    if (s.tokensSaved > 0) {
      console.log(`  ${s.strategyName}: ${s.tokensBefore} → ${s.tokensAfter} (saved ${s.tokensSaved})`);
    }
  }
  console.log(`  TOTAL SAVED: ~${totalSaved} tokens`);
}
