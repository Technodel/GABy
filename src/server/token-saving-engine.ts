/**
 * token-saving-engine.ts — Central orchestrator for ALL token-saving strategies.
 *
 * Strategies:
 *   1. XML Comment/Boilerplate Compression — shrinks repetitive XML comment blocks in system prompt
 *   2. Tool Schema Pruning — drops tool defs the model won't need this turn
 *   3. Selective Tool-Call Compression — keeps tool names but strips args from old turns
 *   4. Redundant File Content Dedup (cross-turn) — replaces duplicate file reads with references
 *   5. Boilerplate Response Stripping (multilingual) — strips common AI filler phrases
 *
 * Design:
 *   - Safe: every strategy is wrapped in try/catch — engine never crashes
 *   - Composable: strategies can be individually enabled/disabled
 *   - Observable: every strategy reports TokenSavingStats
 *   - Non-destructive: original arrays are never mutated
 *   - Provider-aware: token estimation adapts to the provider's tokenizer
 */

import type { CoreMessage } from 'ai';

// ── Re-exports from existing modules (DO NOT duplicate their logic) ─────────
export { compressToolResult, compressToolResultsInContent } from './tool-result-compressor';
export { trimHistory, estimateTokens, getContextLimit } from './context-manager';

// ── Cross-turn dedup cache (module-level, survives across optimizeForTokens calls) ──
const CROSS_TURN_FILE_CACHE = new Map<string, { fingerprint: string; firstSeen: string; timestamp: number }>();
const CROSS_TURN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let lastCacheCleanup = Date.now();

function cleanupCache(): void {
  const now = Date.now();
  if (now - lastCacheCleanup < 60_000) return; // once per minute max
  lastCacheCleanup = now;
  for (const [key, val] of CROSS_TURN_FILE_CACHE) {
    if (now - val.timestamp > CROSS_TURN_CACHE_TTL_MS) CROSS_TURN_FILE_CACHE.delete(key);
  }
}

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

// ── Provider-aware token estimation ─────────────────────────────────────────
// Different providers use different tokenizers. These ratios are approximate
// averages based on each model family's known chars/token.

const PROVIDER_RATIOS: Record<string, number> = {
  anthropic: 3.2,
  claude: 3.2,
  openai: 4.0,
  gpt: 4.0,
  deepseek: 3.5,
  groq: 3.5,
  gemini: 3.8,
  openrouter: 3.5,
  ollama: 3.5,
  huggingface: 3.5,
};

function getRatio(provider: string): number {
  const lower = provider.toLowerCase();
  for (const [key, ratio] of Object.entries(PROVIDER_RATIOS)) {
    if (lower.includes(key)) return ratio;
  }
  return 3.5; // default fallback
}

function estimateTokensLocal(text: string, provider: string): number {
  return Math.ceil(text.length / getRatio(provider));
}

function messageChars(msg: CoreMessage): number {
  return typeof msg.content === 'string'
    ? msg.content.length
    : JSON.stringify(msg.content).length;
}

// ── Strategy 1: XML Comment/Boilerplate Compression ─────────────────────────
//
// The system prompt contains repetitive XML-style comment blocks like:
//   ╔══════════════════════════════════════════════════════════════════╗
//   ║  SECTION TITLE                                                 ║
//   ╚══════════════════════════════════════════════════════════════════╝
// These are ~200 chars each and contain no semantic content.
// This strategy compresses them into terse markers: ─── SECTION TITLE ───

const XML_COMMENT_LINE_RX = /^[╔╗╚╝║═╗╔╚╝║═\s\-]+$/;
const BOXED_HEADER_RX = /║\s+(.+?)\s+║/;

function compressXmlBoilerplate(systemPrompt: string, provider: string): { result: string; stats: TokenSavingStats } {
  const strategyName = 'XmlBoilerplateCompression';
  const before = estimateTokensLocal(systemPrompt, provider);

  try {
    const lines = systemPrompt.split('\n');
    const out: string[] = [];
    let skipped = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect box-drawing comment blocks: lines composed entirely of box chars
      if (XML_COMMENT_LINE_RX.test(line)) {
        skipped++;
        continue;
      }

      // If we just skipped some box-art and found a header line like "║  TEXT  ║"
      if (skipped > 0 && BOXED_HEADER_RX.test(line)) {
        const headerMatch = line.match(BOXED_HEADER_RX);
        if (headerMatch) {
          // Calculate how much of the previous block we're replacing
          out.push(`─── ${headerMatch[1].trim()} ───`);
          skipped = 0;
          continue;
        }
      }

      // If we skipped box lines and hit a normal line, we were in a non-header box
      if (skipped > 0) {
        // collapsed → just emit the normal line
        skipped = 0;
      }

      out.push(line);
    }

    const result = out.join('\n');
    const after = estimateTokensLocal(result, provider);
    return { result, stats: { strategyName, tokensBefore: before, tokensAfter: after, tokensSaved: Math.max(0, before - after) } };
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

const TOOL_PRUNE_RULES: Record<string, string[]> = {
  question: [
    'file_write', 'file_edit', 'bash', 'start_server', 'stop_server',
    'create_worktree', 'merge_worktree', 'run_background_command',
    'delegate_subtask', 'delegate_swarm', 'invoke_subagent',
    'request_checkpoint', 'self_heal',
  ],
  coding: [
    'web_search', 'url_fetch', 'delegate_swarm',
  ],
  refactor: [
    'web_search', 'url_fetch', 'delegate_swarm', 'start_server', 'stop_server',
  ],
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
  research: [
    'file_write', 'file_edit', 'bash', 'start_server', 'stop_server',
    'create_worktree', 'merge_worktree', 'run_background_command',
    'self_heal',
  ],
};

function detectTaskType(taskType: string | undefined, messages: CoreMessage[]): string {
  if (taskType) return taskType;

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return 'coding';

  const text = (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)).toLowerCase();

  if (/^(hi|hello|hey|thanks|thank you|ok|yes|no|cool|nice)[!?.\s]*$/i.test(text.trim())) return 'chat';
  if (/^(what|why|how|when|where|who|explain|describe|tell me|can you)\b/i.test(text.trim()) && text.length < 200) return 'question';
  if (/\b(research|investigate|find out|look up|search for|compare|analyze)\b/i.test(text)) return 'research';
  if (/\b(refactor|rename|move|reorgani[sz]e|clean\s?up|restructure)\b/i.test(text)) return 'refactor';

  return 'coding';
}

function pruneToolSchemas(
  allToolNames: string[] | undefined,
  taskType: string | undefined,
  messages: CoreMessage[],
  provider: string,
): { prunedTools: string[]; stats: TokenSavingStats } {
  const strategyName = 'ToolSchemaPruning';
  const TOKENS_PER_TOOL_DEF = Math.round(350 * (3.5 / getRatio(provider))); // provider-adjusted

  if (!allToolNames || allToolNames.length === 0) {
    return { prunedTools: [], stats: { strategyName, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 } };
  }

  try {
    const detectedType = detectTaskType(taskType, messages);
    const toRemove = TOOL_PRUNE_RULES[detectedType] || [];
    const prunedTools = toRemove.filter(t => allToolNames.includes(t));

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

// ── Strategy 3: Selective Tool-Call Compression ─────────────────────────────
//
// Instead of removing entire tool-call parts from old assistant messages
// (which loses context about WHAT tools were used), this strategy:
//   - Keeps the tool NAME
//   - Strips the tool ARGUMENTS (which are often very large JSON blobs)
//   - Preserves tool RESULTS from 'tool' role messages
//
// Adaptive threshold: keeps the last N user turns intact (N = max(3, totalTurns/6))
// so shorter conversations preserve more context and longer ones save more.

function getKeepTurns(totalUserTurns: number): number {
  // Adaptive: keep at least 3, at most 6, or ~most recent 25% of turns
  const adaptive = Math.max(3, Math.min(6, Math.round(totalUserTurns / 4)));
  return adaptive;
}

function compressOldToolCalls(messages: CoreMessage[], provider: string): { result: CoreMessage[]; stats: TokenSavingStats } {
  const strategyName = 'SelectiveToolCallCompression';
  const beforeChars = messages.reduce((sum, m) => sum + messageChars(m), 0);
  const before = estimateTokensLocal(JSON.stringify(messages), provider);

  try {
    const totalUserTurns = messages.filter(m => m.role === 'user').length;
    const keepTurns = getKeepTurns(totalUserTurns);

    if (totalUserTurns <= keepTurns) {
      return { result: messages, stats: { strategyName, tokensBefore: before, tokensAfter: before, tokensSaved: 0 } };
    }

    let userTurnsSeen = 0;
    let totalSaved = 0;

    const result = messages.map(msg => {
      if (msg.role === 'user') {
        userTurnsSeen++;
        return msg;
      }

      // Keep recent turns intact
      if (totalUserTurns - userTurnsSeen < keepTurns) {
        return msg;
      }

      let modified = false;
      const newMsg = { ...msg };

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // Compress tool-call parts: keep the tool NAME but strip the ARGUMENTS
        newMsg.content = msg.content.map((part: any) => {
          if (part.type === 'tool-call') {
            modified = true;
            const argsSummary = part.args
              ? `{${Object.keys(part.args).slice(0, 2).join(', ')}${Object.keys(part.args).length > 2 ? ', ...' : ''}}`
              : '{}';
            return {
              type: 'text' as const,
              text: `[tool: ${part.toolName || part.name}(${argsSummary})]`,
            };
          }
          return part;
        });
      }

      if (modified) {
        totalSaved += messageChars(msg) - messageChars(newMsg as CoreMessage);
        return newMsg as CoreMessage;
      }
      return msg;
    });

    const after = estimateTokensLocal(JSON.stringify(result), provider);
    return { result, stats: { strategyName, tokensBefore: before, tokensAfter: after, tokensSaved: Math.max(0, before - after) } };
  } catch {
    return { result: messages, stats: { strategyName, tokensBefore: before, tokensAfter: before, tokensSaved: 0 } };
  }
}

// ── Strategy 4: Cross-Turn Redundant File Content Dedup ─────────────────────
//
// When the same file content appears multiple times (across turns and within
// the current turn), replace subsequent occurrences with a reference.
// Uses a module-level cache so previous turns' file reads are remembered.

function deduplicateFileContents(
  messages: CoreMessage[],
  provider: string,
  sessionLabel?: string,
): { result: CoreMessage[]; stats: TokenSavingStats } {
  const strategyName = 'RedundantFileContentDedup';
  const beforeChars = messages.reduce((sum, m) => sum + messageChars(m), 0);

  try {
    cleanupCache();

    // Per-turn seen map (for within-turn dedup)
    const turnSeen = new Map<string, string>();
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

        if (rawContent.length < 500) return part;

        const fingerprint = rawContent.slice(0, 200) + '::' + rawContent.length;
        const toolName = part.toolName || '';

        // Check cross-turn cache first
        if (CROSS_TURN_FILE_CACHE.has(fingerprint)) {
          const entry = CROSS_TURN_FILE_CACHE.get(fingerprint)!;
          modified = true;
          totalSaved += rawContent.length;
          const replacement = `[Same content — see ${entry.firstSeen}]`;
          return typeof part.content === 'string'
            ? { ...part, content: replacement }
            : { ...part, content: [{ type: 'text', text: replacement }] };
        }

        // Check per-turn cache
        if (turnSeen.has(fingerprint)) {
          const ref = turnSeen.get(fingerprint)!;
          modified = true;
          totalSaved += rawContent.length;
          const replacement = `[Same content as previously read — see ${ref} above]`;
          return typeof part.content === 'string'
            ? { ...part, content: replacement }
            : { ...part, content: [{ type: 'text', text: replacement }] };
        }

        // Store in both caches
        const label = toolName || `file_read_${turnSeen.size + 1}`;
        turnSeen.set(fingerprint, label);
        CROSS_TURN_FILE_CACHE.set(fingerprint, { fingerprint, firstSeen: label, timestamp: Date.now() });

        return part;
      });

      if (modified) {
        return { ...msg, content: newContent };
      }
      return msg;
    });

    const tokensSaved = estimateTokensLocal(' '.repeat(totalSaved), provider);
    return {
      result,
      stats: {
        strategyName,
        tokensBefore: estimateTokensLocal(' '.repeat(beforeChars), provider),
        tokensAfter: estimateTokensLocal(' '.repeat(Math.max(0, beforeChars - totalSaved)), provider),
        tokensSaved,
      },
    };
  } catch {
    const tokensEst = estimateTokensLocal(' '.repeat(beforeChars), provider);
    return {
      result: messages,
      stats: { strategyName, tokensBefore: tokensEst, tokensAfter: tokensEst, tokensSaved: 0 },
    };
  }
}

// ── Strategy 5: Multilingual Boilerplate Response Stripping ─────────────────
//
// Removes common AI boilerplate phrases from assistant messages in the
// conversation history. Supports English, French, Spanish, Arabic, and German.

interface LangPatterns {
  opening: RegExp[];
  closing: RegExp[];
}

const BOILERPLATES: LangPatterns = {
  opening: [
    // English
    /^(?:Sure[!,]?|Sure thing[!.]?|Of course[!.]?|Absolutely[!.]?|Great question[!.]?|Good question[!.]?|Great[!.]?|Perfect[!.]?|Awesome[!.]?|Exactly[!.]?)\s*/im,
    /^(?:I(?:'ll| would) be happy to (?:help|assist|explain)[^.!]*[.!]?\s*)/im,
    /^(?:Let me (?:help you|assist you|take a look|check|see|look into|examine|investigate|review|start|begin|explain|clarify|break this down)[^.!]*[.!]?\s*)/im,
    /^(?:I can (?:help|assist|explain|show|demonstrate)[^.!]*[.!]?\s*)/im,
    /^(?:I(?:'d be| would be) glad to (?:help|assist|explain)[^.!]*[.!]?\s*)/im,
    // French
    /^(?:Bien s[ûù]r[!.]?|Bien entendu[!.]?|Certainement[!.]?|Absolument[!.]?|Exactement[!.]?|Pas de probl[èe]me[!.]?|Je serais ravi de[^.!]*[.!]?\s*)/im,
    /^(?:Laissez-moi (?:v[ôo]us aider|v[ée]rifier|regarder|expliquer|commencer|jeter un coup d'[œoe]il)[^.!]*[.!]?\s*)/im,
    // Spanish
    /^(?:Claro[!.]?|Por supuesto[!.]?|Desde luego[!.]?|Absolutamente[!.]?|Exacto[!.]?|Sin problema[!.]?|Estar[ée] encantado de[^.!]*[.!]?\s*)/im,
    /^(?:D[ée]jame (?:ayudarte|verificar|mirar|explicar|empezar|echar un vistazo)[^.!]*[.!]?\s*)/im,
    // Arabic (simple common phrases)
    /^(?:طبعا[.!]?|بالتأكيد[.!]?|بالطبع[.!]?|لا مشكلة[.!]?|دعني (?:أساعدك|أتحقق|أنظر|أشرح)[^.!]*[.!]?\s*)/im,
    // German
    /^(?:Nat[üu]rlich[!.]?|Selbstverst[äa]ndlich[!.]?|Absolut[!.]?|Genau[!.]?|Kein Problem[!.]?|Gerne[!.]?|Ich helfe Ihnen gerne[^.!]*[.!]?\s*)/im,
    /^(?:Lassen Sie mich (?:Ihnen helfen|nachsehen|[üu]berpr[üu]fen|erkl[äa]ren|beginnen)[^.!]*[.!]?\s*)/im,
  ],
  closing: [
    // English
    /(?:Let me know if you (?:need|have|want) (?:anything|any(?:thing)? else|further assist|more help|more)[.!]?\s*)$/im,
    /(?:Feel free to (?:ask|reach out|let me know)[^.]*[.!]?\s*)$/im,
    /(?:Hope (?:this|that) helps[.!]?\s*)$/im,
    /(?:Is there anything else (?:you'd like|I can|you need)[^?]*\?\s*)$/im,
    /(?:Don't hesitate to (?:ask|reach out)[^.]*[.!]?\s*)$/im,
    /(?:Let me know how it goes[.!]?\s*)$/im,
    /(?:Happy (?:to help|coding|building)[!.]?\s*)$/im,
    // French
    /(?:N'h[ée]sitez pas (?:à demander|à me contacter|à me le faire savoir)[^.]*[.!]?\s*)$/im,
    /(?:Faites-moi savoir si vous avez (?:besoin|des questions)[^.]*[.!]?\s*)$/im,
    /(?:J'esp[èe]re que (?:cela|cette) vous aide[.!]?\s*)$/im,
    // Spanish
    /(?:No dude en (?:preguntar|contactarme|dec[íi]rmelo)[^.]*[.!]?\s*)$/im,
    /(?:Av[íi]same si (?:necesitas|tienes) (?:algo m[áa]s|m[áa]s ayuda|preguntas)[^.]*[.!]?\s*)$/im,
    /(?:Espero que (?:esto|te) ayude[.!]?\s*)$/im,
    // Arabic
    /(?:لا تتردد في (?:السؤال|التواصل معي|إخباري)[^.]*[.!]?\s*)$/im,
    /(?:أخبرني إذا (?:كنت|كان) (?:تحتاج|لديك)[^.]*[.!]?\s*)$/im,
    // German
    /(?:Lassen Sie es mich (?:wissen|h[oö]ren|erfahren)[^.]*[.!]?\s*)$/im,
    /(?:Z[öo]gern Sie nicht, (?:zu fragen|mich zu kontaktieren)[^.]*[.!]?\s*)$/im,
    /(?:Ich hoffe, (?:das|dies) hilft[.!]?\s*)$/im,
  ],
};

function stripBoilerplate(messages: CoreMessage[], provider: string): { result: CoreMessage[]; stats: TokenSavingStats } {
  const strategyName = 'MultilingualBoilerplateStripping';
  const beforeChars = messages.reduce((sum, m) => sum + messageChars(m), 0);

  try {
    let totalStripped = 0;

    const result = messages.map(msg => {
      if (msg.role !== 'assistant') return msg;
      if (typeof msg.content !== 'string') return msg;

      let cleaned = msg.content;

      // Apply all opening patterns
      for (const pattern of BOILERPLATES.opening) {
        cleaned = cleaned.replace(pattern, '');
      }
      // Apply all closing patterns
      for (const pattern of BOILERPLATES.closing) {
        cleaned = cleaned.replace(pattern, '');
      }
      cleaned = cleaned.trim();

      if (cleaned.length < 10) return msg;

      const savedChars = msg.content.length - cleaned.length;
      if (savedChars > 0) {
        totalStripped += savedChars;
        return { ...msg, content: cleaned };
      }
      return msg;
    });

    const tokensSaved = estimateTokensLocal(' '.repeat(totalStripped), provider);
    return {
      result,
      stats: {
        strategyName,
        tokensBefore: estimateTokensLocal(' '.repeat(beforeChars), provider),
        tokensAfter: estimateTokensLocal(' '.repeat(Math.max(0, beforeChars - totalStripped)), provider),
        tokensSaved,
      },
    };
  } catch {
    const tokensEst = estimateTokensLocal(' '.repeat(beforeChars), provider);
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
    // ── 1. XML Comment/Boilerplate Compression ──────────────────────────
    {
      const s1 = compressXmlBoilerplate(systemPrompt, provider);
      systemPrompt = s1.result;
      if (s1.stats.tokensSaved > 0) stats.push(s1.stats);
    }

    // ── 2. Tool Schema Pruning ─────────────────────────────────────────
    {
      const s2 = pruneToolSchemas(allToolNames, taskType, messages, provider);
      if (s2.prunedTools.length > 0) {
        prunedTools = s2.prunedTools;
        stats.push(s2.stats);
      }
    }

    // ── 3. Boilerplate Stripping (before compression, avoid wasting time on filler) ──
    {
      const s5 = stripBoilerplate(messages, provider);
      messages = s5.result;
      if (s5.stats.tokensSaved > 0) stats.push(s5.stats);
    }

    // ── 4. Redundant File Content Dedup (cross-turn) ───────────────────
    {
      const s4 = deduplicateFileContents(messages, provider);
      messages = s4.result;
      if (s4.stats.tokensSaved > 0) stats.push(s4.stats);
    }

    // ── 5. Selective Tool-Call Compression ─────────────────────────────
    {
      const s3 = compressOldToolCalls(messages, provider);
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

// ── Reset cross-turn cache (for testing) ────────────────────────────────────
export function resetFileCache(): void {
  CROSS_TURN_FILE_CACHE.clear();
}
