import http from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import { getAdapter } from './db';
import { env } from '../shared/env';
import { verifyToken } from './auth';
import { userClientManager } from './user-client-manager';
import { scanForInjection, initializeInjectionGuardTable } from './injection-guard';
import { AgentMessage } from './agent';
import { hasSufficientBalance, deductUsage } from './billing';
import { runAgentLoop, clearLoopDetector } from './agent-loop';
import { withUserQueue } from './user-queue';
import { initializeDesignIntentTable, getDesignIntentsPrompt, processDesignIntents } from './design-intent';
import { hookSystem } from './hook-system';
import { initializeInteractionPatternsTable } from './interaction-memory';
import { initializePresenceTable, getPresenceProfile, getPresenceInjection, updatePresenceProfile } from './presence-engineering';
import { generateBlueprintForSession, getBlueprintContext, getBlueprintSummary, storeBlueprintEntry, generateRulesFromPatterns } from './blueprint-memory';
import { loadAgentContext } from './agent-context-assembler';
import { AgentTurnLog, recordAgentTurn } from './metrics';
import { pickRandom, startDidYouKnowTimer } from './personality';
import { ERROR_REPLY_FALLBACKS, EXHAUSTED_REPLY_FALLBACKS, pickNonRepeatingFallback, normalizeFinalContent, quickProjectScan } from './fallbacks';
import { lockMessagesSent } from './lock-messages';
import { isForecastEnabled, isBudgetGateEnabled, getBudgetPerRun, buildForecast, trackSessionSpend, clearSessionSpend } from './cost-forecaster';
import { recordHealthScore } from './health-scorer';
import { logOperation } from './operation-audit';
import { isFeatureEnabled, isPlanFeatureEnabled } from './feature-flags';
import { loadTrainingAndRules } from './training-loader';
import { getSkillIndex } from './skill-loader';
import { formatGoalContext, getCurrentGoal, addGoalEvidence, incrementGoalAttempt, tryAutoCompleteGoal } from './goal-tracker';
import { searchChunks, formatChunksForPrompt, buildChunkVectors } from './code-chunks';
import { isDigestCached, buildProjectDigest, formatDigestForPrompt, markDigestCached, buildArchitectureGraph, formatGraphForPrompt, runHealthCheck, formatHealthCheckForPrompt } from './project-digest';
import { analyzeInteractionPatterns, formatPatternAnalysisForPrompt, silentCodeReview, postMergeValidation, formatValidationForPrompt, recordInteraction } from './verification-obsession';
import { captureSnapshot, detectDrift } from './change-guardian';
import { loadProjectRules, saveProjectRules, RULES_SYSTEM_SECTION } from './project-rules';
import { acquireLock, getLockInfo, releaseLock } from './project-lock';
import { updateCrossProjectPersona } from './cross-project-learning';
import { recordBenchmarkRun } from './benchmark';
import { indexProject } from './code-index';
import { buildStaticSystemPrompt } from './prompt-factory';
import { processManager } from './process-manager';
import { getCheckpointsByUser, rollbackWithRecord } from './checkpoint-manager';

import { z } from 'zod';

const ChatWebSocketMessageSchema = z.object({
  type: z.string(),
  message: z.string().optional(),
  newCap: z.number().optional(),
  projectId: z.number().optional(),
  projectPath: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  files: z.array(z.string()).optional(),
  mode: z.string().optional(),
  featureFlags: z.record(z.unknown()).optional(),
}).passthrough();

// ── Zero-Downtime Watchdog ────────────────────────────────────────────────────
// Listens for fatal dev-server crashes emitted by processManager.
// When detected: auto-rolls back to the last safe checkpoint and pushes
// the error into the active agent session so SUNy can self-correct silently.
(function bootstrapWatchdog() {
  const recentlyCrashed = new Set<string>(); // debounce per processId
  processManager.on('processCrash', async (event: { id: string; command: string; cwd: string; error: string; userId?: number; projectPath?: string }) => {
    const { id, error, userId, projectPath } = event;
    if (recentlyCrashed.has(id)) return; // act once per crash burst
    recentlyCrashed.add(id);
    setTimeout(() => recentlyCrashed.delete(id), 15_000); // 15s cooldown

    console.warn(`[watchdog] Crash detected in process ${id}: ${error.slice(0, 120)}`);

    if (!userId || !projectPath) {
      console.warn('[watchdog] Missing userId/projectPath — cannot auto-rollback.');
      return;
    }

    try {
      const checkpoints = await getCheckpointsByUser(userId, undefined, 1);
      if (!checkpoints.length) {
        console.warn('[watchdog] No checkpoints found — skipping rollback.');
        return;
      }
      const latest = checkpoints[0];
      const result = await rollbackWithRecord(userId, projectPath, latest.id);

      if (result.success) {
        console.log(`[watchdog] Auto-rolled back to "${latest.label}" (${result.sha.slice(0, 7)})`);
        userClientManager.pushChatContent(userId, 'suny:system_message', {
          message: `🛡️ **Watchdog Auto-Rollback**: Dev server crashed with: \`${error.slice(0, 200)}\`\n\nI automatically rolled back to checkpoint **"${latest.label}"** to restore your working state. Analysing the error now...`,
        });
        userClientManager.pushChatContent(userId, 'suny:watchdog_crash', {
          error,
          checkpoint: latest.label,
          sha: result.sha,
        });
      } else {
        console.error(`[watchdog] Rollback failed: ${result.message}`);
      }
    } catch (err) {
      console.error('[watchdog] Error during auto-rollback:', (err as Error).message);
    }
  });
})();

export function attachWebSockets(server: http.Server) {
  // ── WebSocket server ───────────────────────────────────────────────────────────



const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', `http://localhost`);
  const pathname = url.pathname;

  if (pathname === '/ws') {
    // Browser client connections (user's browser tab)
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleUserClientUpgrade(ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── WebSocket rate limiting: per-user, shared across connections ────────────
const WS_RATE_LIMIT = 20;            // max messages
const WS_RATE_WINDOW_MS = 60_000;    // per 60 seconds
const wsRateBuckets = new Map<number, number[]>();
const pendingBudgetExtensions = new Map<number, number>(); // userId -> newCap

function checkWsRateLimit(uid: number): boolean {
  const now = Date.now();
  const windowStart = now - WS_RATE_WINDOW_MS;
  let timestamps = wsRateBuckets.get(uid);
  if (!timestamps) {
    timestamps = [];
    wsRateBuckets.set(uid, timestamps);
  }
  // Prune old entries
  const valid = timestamps.filter(t => t > windowStart);
  wsRateBuckets.set(uid, valid);
  if (valid.length >= WS_RATE_LIMIT) {
    return false; // rate limited
  }
  valid.push(now);
  return true;
}

function handleUserClientUpgrade(ws: WebSocket, req: http.IncomingMessage): void {
  // Accept only HttpOnly cookie or Authorization Bearer header.
  // Query-string tokens are rejected: they leak JWTs into proxy logs, nginx
  // access logs, browser history, and crash reports.
  const cookieToken = req.headers.cookie?.split(';').find(c => c.trim().startsWith('suny_token='))?.split('=')[1];
  const headerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  const token = cookieToken || headerToken;

  if (!token) {
    ws.close(4001, 'Missing token');
    return;
  }

  const payload = verifyToken(decodeURIComponent(token));
  if (!payload) {
    ws.close(4001, 'Invalid token');
    return;
  }

  const userId = payload.id as number;
  userClientManager.register(userId, ws);
  ws.send(JSON.stringify({ event: 'connected', message: 'SUNy is ready!' }));

  // ── Track active requests for cancellation ──────────────────────────────
  let currentAbortController: AbortController | null = null;
  let isProcessing = false;
  let queuedMessage: Buffer | null = null;

  // ── WebSocket close: keep the agent loop alive ──────────────────────────
  // When the browser disconnects (tab closed, PC shutdown, connection lost),
  // we do NOT abort the in-flight agent task. Instead, userClientManager will
  // buffer any events the agent emits while the user is offline and flush them
  // the moment the user reconnects. This gives SUNy true session resilience.
  // We only abort if the user explicitly sends 'cancel' over the WS.
  ws.on('close', () => {
    // Do NOT call currentAbortController.abort() here.
    // The agent loop keeps running; buffered events will be flushed on reconnect.
    isProcessing = false;
    queuedMessage = null;
    // Clean up per-user rate bucket and loop detector to prevent unbounded memory growth
    wsRateBuckets.delete(userId);
    clearLoopDetector(userId);
  });

  ws.on('message', async (raw: Buffer) => {
    // Rate limit check
    if (!checkWsRateLimit(userId)) {
      userClientManager.pushChatContent(userId, 'suny:stream_end', {
        content: "Too many messages � please slow down a bit! ??",
        sess_used: null,
        sess_limit: null,
        iterations: 0,
      });
      return;
    }
    let msg: Record<string, unknown>;
    try { 
      const parsed = JSON.parse(raw.toString()); 
      msg = ChatWebSocketMessageSchema.parse(parsed);
    } catch { return; }

    // Handle cancel request
    if (msg.type === 'chat:cancel') {
      if (currentAbortController) {
        const cancelMessage = pickRandom('cancel', "Got it � I've stopped! What's next? ??");
        currentAbortController.abort(new Error('Request cancelled by user'));
        currentAbortController = null;
        isProcessing = false;
        userClientManager.pushChatContent(userId, 'suny:stream_end', {
          content: cancelMessage,
          sess_used: null,
          sess_limit: null,
          iterations: 0,
        });
      }
      return;
    }

    // Handle checkpoint responses
    if (msg.type === 'checkpoint:approve') {
      userClientManager.resolveCheckpoint(userId, true);
      return;
    }
    if (msg.type === 'checkpoint:abort') {
      userClientManager.resolveCheckpoint(userId, false);
      return;
    }

    // Handle budget gate responses
    if (msg.type === 'budget_gate:continue') {
      userClientManager.resolveBudgetGate(userId, 'continue');
      return;
    }
    if (msg.type === 'budget_gate:budget_mode') {
      userClientManager.resolveBudgetGate(userId, 'budget_mode');
      return;
    }
    if (msg.type === 'budget_gate:extend') {
      const newCap = typeof msg.newCap === 'number' ? msg.newCap : null;
      if (newCap) {
        // Store new cap temporarily for the onBudgetExtend callback
        pendingBudgetExtensions.set(userId, newCap);
      }
      userClientManager.resolveBudgetGate(userId, 'extend');
      return;
    }
    if (msg.type === 'budget_gate:stop') {
      userClientManager.resolveBudgetGate(userId, 'stop');
      return;
    }

    if (msg.type !== 'chat:message') return;

    

    // ── Injection guard: scan user message for prompt injection ──────────
    try {
      const msgText = String(msg.message ?? '');
      if (msgText.length > 0) {
        const result = scanForInjection(
          msgText,
          { userId, sessionId: msg.sessionId as string },
          { sanitize: false, blockOnHigh: true },
        );
        if (result.detected) {
          const highCount = result.matches.filter(m => m.severity === 'high').length;
          console.warn(`[injection-guard] ${result.matches.length} pattern(s) detected in message from user ${userId} (${highCount} high severity)`);
          if (result.blocked) {
            userClientManager.pushChatContent(userId, 'suny:stream_end', {
              content: "I couldn't process that message due to a security concern. Please rephrase your request.",
              sess_used: null,
              sess_limit: null,
              iterations: 0,
            });
            return;
          }
        }
      }
    } catch { /* best-effort */ }

    // ── Task interruption behavior: read user preference ──────────────
    if (isProcessing) {
      let behavior = 'interrupt';
      try {
        const rawSetting = await getAdapter().get("SELECT value FROM app_settings WHERE key = ?", [`user_${userId}_task_interruption_behavior`]) as { value: string } | undefined;
        if (rawSetting) behavior = rawSetting.value;
      } catch { /* best-effort */ }

      if (behavior === 'queue') {
        // Queue behind current task � don't abort, just enqueue
        queuedMessage = raw;
        return;
      }

      // Interrupt: cancel current work, then process the latest user update.
      // Conversation context/history is preserved; only the in-flight run is superseded.
      if (currentAbortController) {
        currentAbortController.abort(new Error('Request superseded by newer user message'));
        currentAbortController = null;
      }
      queuedMessage = raw;
      userClientManager.pushToUser(userId, 'suny:narration', {
        message: "Got your update. I'm switching to your latest request and keeping the task context.",
      });
      return;
    }

    isProcessing = true;
    const turnStart = Date.now();
    currentAbortController = new AbortController();
    try {
      const db = getAdapter();
      const userRow = await db.get('SELECT selected_mode, max_tokens_per_session, display_name, plan FROM users WHERE id = ?', [userId]) as { selected_mode: string; max_tokens_per_session: number | null; display_name: string | null; plan: string | null } | undefined;

      // Per-project default tier: if the user hasn't set msg.mode explicitly for this
      // turn, fall back to the active project's default_tier before user.selected_mode.
      let projectDefaultTier: string | null = null;
      const projectIdEarly = msg.projectId as number | undefined;
      if (projectIdEarly && !msg.mode) {
        try {
          const projTier = await db.get('SELECT default_tier FROM projects WHERE id = ? AND user_id = ?', [projectIdEarly, userId]) as { default_tier: string | null } | undefined;
          projectDefaultTier = projTier?.default_tier ?? null;
        } catch { /* column may not exist on older DBs */ }
      }

      const rawMode = ((msg.mode as string) || projectDefaultTier || userRow?.selected_mode || 'fast').toLowerCase();
      const requestedMode = ['free', 'fast', 'smart', 'pro', 'auto'].includes(rawMode) ? rawMode : 'fast';
      const dailyLimitRow = await db.get("SELECT value FROM app_settings WHERE key = 'daily_token_limit'", []) as { value: string } | undefined;
      const dailyTokenLimit = parseInt(dailyLimitRow?.value || '0', 10);
      const todayUsed = await db.get(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used FROM usage_log WHERE user_id = ? AND DATE(timestamp) = DATE('now')",
        [userId]
      ) as { total_used: number };
      const noCredits = !(await hasSufficientBalance(userId));
      const dailyCapApplies = noCredits || requestedMode === 'free';
      const dailyLimitReached = dailyCapApplies && dailyTokenLimit > 0 && todayUsed.total_used >= dailyTokenLimit;
      const freeTalkOnly = noCredits || dailyLimitReached;
      const effectiveMode = freeTalkOnly ? 'free' : requestedMode;

      // Surface the reason to the UI as a one-off banner so the user knows
      // why they're locked to free-talk mode (instead of silently downgrading).
      if (noCredits && requestedMode !== 'free') {
        userClientManager.pushToUser(userId, 'suny:out_of_balance', {
          reason: 'no_credits',
          message: 'Your balance is empty. I can still chat in free mode, but coding actions need credits. Ask an admin to top you up.',
        });
      } else if (dailyLimitReached) {
        userClientManager.pushToUser(userId, 'suny:out_of_balance', {
          reason: 'daily_limit',
          message: `You've used today's free tokens (${todayUsed.total_used}/${dailyTokenLimit}). It resets at midnight, or top up to keep going.`,
        });
      }

      // Generate routing reason (why this tier was selected � no model names)
      let routingReason = '';
      if (dailyLimitReached) {
        routingReason = 'Daily token limit reached';
      } else if (noCredits) {
        routingReason = 'Budget exhausted';
      } else if (requestedMode === 'free') {
        routingReason = 'Free tier (user preference)';
      } else if (requestedMode === 'fast') {
        routingReason = 'Fast tier (low complexity)';
      } else if (requestedMode === 'pro') {
        routingReason = 'Pro tier (maximum capability)';
      } else {
        routingReason = requestedMode;
      }
      
      const sessionId = (msg.sessionId as string) || `ws_${userId}`;
      const history = (msg.history as AgentMessage[]) || [];
      const displayName = userRow?.display_name;
      const showTechnicalDetails = msg.showTechnicalDetails === true;
      const requestedTalkMode = msg.talkMode === true;
      let talkMode = requestedTalkMode || freeTalkOnly;

      const scopedAutoApprove = await db.get('SELECT value FROM app_settings WHERE key = ?', [`user_${userId}_auto_approve`]) as { value: string } | undefined;
      const globalAutoApprove = await db.get("SELECT value FROM app_settings WHERE key = 'auto_approve'", []) as { value: string } | undefined;
      const userAutoApprove = (scopedAutoApprove?.value ?? globalAutoApprove?.value ?? 'true') === 'true';

      if (freeTalkOnly) {
        const taskish = /(create|scaffold|build|generate|edit|fix|implement|run|install|start|delete|rename|refactor|file|folder|project)/i.test(String(msg.message));
        if (taskish) {
          userClientManager.pushToUser(userId, 'suny:narration', {
            message: dailyLimitReached
              ? 'Daily token limit reached. SUNy is staying in free talk-only mode until the limit resets.'
              : "You're out of credits, so SUNy is staying in free talk-only mode. It can explain steps, but it can't run file or shell actions until you top up.",
          });
        }
      }

      // ── Session-level token cap ──────────────────────────────────────
      if (userRow?.max_tokens_per_session && userRow.max_tokens_per_session > 0) {
        const sessStats = await db.get(
          'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used FROM usage_log WHERE user_id = ? AND session_id = ?',
          [userId, sessionId]
        ) as { total_used: number };
        const remaining = userRow.max_tokens_per_session - sessStats.total_used;
        if (remaining <= 0) {
          const limitMessage = pickRandom('session_limit', "You've reached the session token limit. Start a new session to continue! ??");
          userClientManager.pushToUser(userId, 'suny:narration', {
            message: limitMessage,
          });
          userClientManager.pushChatContent(userId, 'suny:stream_end', {
            content: limitMessage,
            sess_used: sessStats.total_used,
            sess_limit: userRow.max_tokens_per_session,
            iterations: 0,
          });
          return;
        }
      }

      const requestedProjectId = msg.projectId as number | undefined;


      // Load plan info once � used in system prompt
      interface PricingMode { mode: string; display_name: string; description: string; }
      const pricingModes = await db.all('SELECT mode, display_name, description FROM pricing_modes ORDER BY id') as PricingMode[];

      // Resolve project path + persona if a project is active (must be before systemLines
      // construction because the training loader IIFE below references projectPath)
      const projectId = msg.projectId as number | undefined;
      const projectNames = msg.projectNames as string[] | undefined;
      let projectPath: string | undefined;
      let projectPersona: string | null = null;
      let projectAutoExecuteOverride: number | null = null;
      if (projectId) {
        try {
          const proj = await db.get('SELECT local_path, persona, auto_execute_override FROM projects WHERE id = ? AND user_id = ?', [projectId, userId]) as { local_path: string; persona: string | null; auto_execute_override: number | null } | undefined;
          projectPath = proj?.local_path;
          projectPersona = proj?.persona ?? null;
          projectAutoExecuteOverride = proj?.auto_execute_override ?? null;
        } catch {
          // Column may not exist on older DBs � fall back to query without it
          const proj = await db.get('SELECT local_path, persona FROM projects WHERE id = ? AND user_id = ?', [projectId, userId]) as { local_path: string; persona: string | null } | undefined;
          projectPath = proj?.local_path;
          projectPersona = proj?.persona ?? null;
        }
      }

      const effectiveAutoExecute = projectAutoExecuteOverride === null
        ? userAutoApprove
        : projectAutoExecuteOverride === 1;
      // Only force talk mode for credit/limit issues � never override the user's explicit Write Mode toggle
      const autoExecuteOff = !effectiveAutoExecute && !freeTalkOnly && !requestedTalkMode;

      // Fetch training/behavioral data async
      const trainingLoadResult = await loadTrainingAndRules({ userId, projectRoot: projectPath });

      // ── Freeze Brain: if this project is pinned to a memory snapshot,
      // load it and use its captured blueprint + behavioral rules instead
      // of live tables. Lets users lock SUNy's behavior to a known-good
      // moment without disabling memory entirely.
      interface FrozenSnapshot {
        uid: string;
        label: string;
        blueprint_json: string | null;
        behavioral_rules_json: string | null;
        tier: string | null;
      }
      let frozenSnapshot: FrozenSnapshot | null = null;
      if (projectId) {
        try {
          const proj = await db.get('SELECT frozen_snapshot_uid FROM projects WHERE id = ? AND user_id = ?', [projectId, userId]) as { frozen_snapshot_uid: string | null } | undefined;
          if (proj?.frozen_snapshot_uid) {
            frozenSnapshot = await db.get(
              `SELECT uid, label, blueprint_json, behavioral_rules_json, tier
               FROM memory_snapshots WHERE uid = ? AND user_id = ?`,
              [proj.frozen_snapshot_uid, userId]
            ) as FrozenSnapshot | null;
          }
        } catch { /* column missing → treat as unfrozen */ }
      }
      if (frozenSnapshot?.behavioral_rules_json) {
        try {
          const rules = JSON.parse(frozenSnapshot.behavioral_rules_json) as Array<{ category: string; rule_text: string; trigger_context: string | null }>;
          if (Array.isArray(rules) && rules.length > 0) {
            const wins = rules.filter(r => r.category === 'win');
            const mistakes = rules.filter(r => r.category === 'mistake');
            const lines = ['', '=== ?? FROZEN BEHAVIORAL RULES (snapshot: ' + frozenSnapshot.label + ') ==='];
            if (wins.length > 0) {
              lines.push('[Always:]');
              for (const r of wins) lines.push(`  ✓ ${r.rule_text}`);
            }
            if (mistakes.length > 0) {
              lines.push('[Avoid:]');
              for (const r of mistakes) lines.push(`  ✗ ${r.rule_text}`);
            }
            trainingLoadResult.behavioralBlock = lines.join('\n');
            console.log(`[freeze] Behavioral rules pinned to snapshot ${frozenSnapshot.uid}`);
          }
        } catch { /* malformed JSON → fall through to live rules */ }
      }

      const systemLines = buildStaticSystemPrompt({
        projectPath,
        getSkillIndex,
        trainingLoadResult
      });

      // ─────────────────────────────────────────────────────────────────────
      // BOUNDARY: above is the STATIC prefix (byte-identical across calls →
      // DeepSeek/Anthropic prompt-prefix caching kicks in here).
      // Below this point, only push DYNAMIC, per-user/per-project content.
      // Do NOT inject template-literal data into the array above this line.
      // ─────────────────────────────────────────────────────────────────────

      if (showTechnicalDetails) {
        systemLines.push(
          '',
          '=== USER OUTPUT PREFERENCE ===',
          'The user enabled technical details in chat.',
          'You may include code blocks, shell commands, and technical snippets when helpful.',
        );
      } else {
        systemLines.push(
          '',
          '=== USER OUTPUT PREFERENCE ===',
          'Beginner mode is active: keep replies code-free and prompt-free.',
          'Do NOT show code blocks, raw prompts, shell commands, or file trees unless the user explicitly asks for technical details.',
          'Explain what you did in simple friendly language focused on outcome.',
        );
      }

      if (talkMode) {
        systemLines.push(
          '',
          '=== TALK MODE BEHAVIOR ===',
          'Talk mode is ON: do not execute file/shell actions.',
          'CRITICAL: Do NOT open any response by announcing that you are in Talk Mode, that you cannot edit files, or that the user should switch modes. Never use a greeting that mentions mode restrictions.',
          'Silently respect the mode. Only mention it if the user explicitly asks you to create/edit/run/build something � in that case explain what you would do and mention Write Mode briefly at the end.',
        );
      }
      if (autoExecuteOff) {
        systemLines.push(
          '',
          '=== AUTO-EXECUTE IS OFF ===',
          'The user has Auto-Execute disabled. You ARE in Write Mode and CAN use file/shell tools.',
          'Before each destructive action (write_file, run_command, delete_file), briefly state what you are about to do and ask the user to confirm.',
          'Do NOT say you are in Talk Mode. Do NOT refuse to act. Just confirm before each action.',
        );
      }
      if (displayName) {
        systemLines.push(`The user's name is ${displayName}. Address them by name occasionally in a warm, friendly way.`);
      }

      // ── Inject user memories (global preferences/rules) ────────────────
      // Memories saved via Settings → SUNy's Memory should act as standing rules
      // for every conversation � both global chat and inside projects.
      try {
        const memSettingScoped = await db.get('SELECT value FROM app_settings WHERE key = ?', [`user_${userId}_memory_enabled`]) as { value: string } | undefined;
        const memSettingGlobal = await db.get("SELECT value FROM app_settings WHERE key = 'memory_enabled'", []) as { value: string } | undefined;
        const memoryEnabled = (memSettingScoped?.value ?? memSettingGlobal?.value ?? 'true') === 'true';
        if (memoryEnabled) {
          const userMemories = await db.all(
            'SELECT content FROM user_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
            [userId]
          ) as { content: string }[];
          if (userMemories.length > 0) {
            systemLines.push(
              '',
              '=== USER PREFERENCES & STANDING RULES ===',
              'The user saved these notes in Settings → SUNy\'s Memory. Treat them as standing rules that always apply (in chat and inside projects). Follow them on every response unless they conflict with safety policy.',
              ...userMemories.map(m => `- ${m.content}`),
            );
            console.log(`[index] Injected ${userMemories.length} user memories into system prompt`);
          }
        }
      } catch (err) {
        console.warn('[index] Failed to inject user memories:', err);
      }

      // Inject pricing plans so SUNy can answer questions about them
      if (pricingModes.length > 0) {
        systemLines.push(
          '',
          '=== PLANS / MODES ===',
          'These are the available chat modes the user can choose from (shown in the top bar):',
          ...pricingModes.map(p => `- ${p.display_name} (${p.mode}): ${p.description}`),
          'If the user asks about plans, pricing, or modes, answer based on the above. Do not invent details you don\'t have (like exact prices).',
        );
      }

      // -- User plan context -------------------------------------------------
      const userPlan: string = userRow?.plan ?? 'regular';
      const isProUser = userPlan === 'pro';
      {
        const planLabel = isProUser ? 'PRO' : 'Regular';
        const proOnlyFeatures = [
          { key: 'pf_advanced_visual_portal', label: 'Advanced Visual Portal' },
          { key: 'pf_parallel_agent_swarm',   label: 'Parallel Agent Swarm' },
          { key: 'pf_hypothesis_engine',       label: 'Parallel Hypothesis Testing' },
          { key: 'pf_scheduled_agents',        label: 'Scheduled Agents' },
        ];
        const available   = proOnlyFeatures.filter(f => isPlanFeatureEnabled(f.key, userPlan));
        const unavailable = proOnlyFeatures.filter(f => !isPlanFeatureEnabled(f.key, userPlan));
        systemLines.push('', '=== USER ACCOUNT PLAN ===', `The user is on the **${planLabel}** plan.`);
        if (available.length > 0) {
          systemLines.push(`Available PRO features for this user: ${available.map(f => f.label).join(', ')}.`);
        }
        if (unavailable.length > 0) {
          systemLines.push(
            `The following features are NOT available on this user's plan: ${unavailable.map(f => f.label).join(', ')}.`,
            "If the user asks about any unavailable feature, politely explain it requires the PRO plan and they should ask their administrator to upgrade their account.",
            "Do NOT attempt to simulate or workaround these features -- simply inform the user clearly.",
          );
        }
      }

      userClientManager.pushToUser(userId, 'suny:thinking', {});
      userClientManager.pushToUser(userId, 'suny:preparation_step', { step: 'Preparing context...' });

      // (projectPath/projectId/projectPersona are resolved above � before systemLines construction)

      // Inject custom persona if set for this project
      if (projectPersona) {
        systemLines.push('', '=== PERSONA ===', projectPersona);
      }

      // Global chat mode � user has no project open; inject project awareness
      if (!projectId && projectNames && projectNames.length > 0) {
        systemLines.push(
          '',
          '=== GLOBAL CONTEXT ===',
          `The user is in the global chat view (no specific project open). Their registered projects are: ${projectNames.join(', ')}.`,
          'You may discuss these projects at a high level � architecture, planning, questions, etc.',
          'If the user asks you to perform file edits, run commands, or make code changes in a specific project, politely let them know they need to click that project in the left sidebar to open its dedicated workspace first.',
        );
      }

      // No projects at all � user hasn't created one yet
      if (!projectId && (!projectNames || projectNames.length === 0)) {
        systemLines.push(
          '',
          '=== NO PROJECT ===',
          'The user does not have any projects yet and no project is currently selected.',
          'If the user asks you to "scan", "analyze", or "look at" a project, explain that they need to:',
          '  1. Click the project icon in the left sidebar to open the project panel.',
          '  2. Click "New Project" to register their project folder.',
          '  3. Enter a name and the full local path (e.g. D:\\Projects\\MyApp).',
          '  4. Open or create a project from the sidebar once the folder is selected.',
          'Then, once a project is selected, you can scan and analyze it.',
        );
      }

      // Inject SUNy Code Conscience blueprint memory (design context from past turns)
      if (projectPath) {
        userClientManager.pushToUser(userId, 'suny:preparation_step', { step: 'Loading project memory...' });
        if (frozenSnapshot?.blueprint_json) {
          // ?? Freeze Brain � use blueprint captured in the snapshot instead of live
          try {
            const entries = JSON.parse(frozenSnapshot.blueprint_json) as Array<{ category: string; intent: string; summary: string; affected_files?: string | null }>;
            if (Array.isArray(entries) && entries.length > 0) {
              const sections = entries.slice(0, 5).map((e, i) => {
                const tag = e.category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                const files = e.affected_files
                  ? (() => { try { return (JSON.parse(e.affected_files as string) as string[]).slice(0, 4).join(', '); } catch { return ''; } })()
                  : '';
                return `[${i + 1}] ${tag}\n    Intent: ${e.intent}\n    Summary: ${e.summary}\n` + (files ? `    Files: ${files}\n` : '');
              }).join('\n');
              systemLines.push(
                `\n\n=== ?? SUNy CODE CONSCIENCE � FROZEN MEMORY (snapshot: ${frozenSnapshot.label}) ===\n` +
                'The following design decisions are pinned from a saved snapshot. Live blueprint is ignored.\n\n' +
                sections +
                '\n=== END FROZEN MEMORY ===',
              );
              console.log(`[freeze] Blueprint pinned to snapshot ${frozenSnapshot.uid}`);
            }
          } catch { /* malformed → fall back to live blueprint */ }
        } else {
          const blueprintCtx = await getBlueprintContext({ userId, projectId, maxEntries: 5 });
          if (blueprintCtx) {
            if (blueprintCtx.length > 50000) {
              blueprintCtx = blueprintCtx.slice(0, 50000) + '\n... [Blueprint truncated to conserve tokens]';
            }
            systemLines.push(blueprintCtx);
            const summary = await getBlueprintSummary({ userId, projectId });
            if (summary) systemLines.push(summary);
            console.log(`[index] Blueprint memory injected`);
          }
        }
      }

      // Inject goal tracker context (current goal, progress, success criteria)
      if (projectPath && projectId && isFeatureEnabled('ff_goal_tracker')) {
        const goalCtx = await formatGoalContext(userId, projectId);
        if (goalCtx) {
          systemLines.push('', goalCtx);
          console.log('[index] Goal tracker context injected');
        }
      }

      // ── Phase 5: Presence Engineering ──────────────────────────────
      // Injects conversation flow, error vulnerability, attention awareness,
      // and celebration cues into the system prompt.
      {
        const profile = await getPresenceProfile(userId);
        const presencePrompt = await getPresenceInjection(
          userId,
          profile?.lastTaskDuration ?? 0,
          0, // changedFiles not known yet � will be updated post-turn
          !profile || profile.totalTasksCompleted === 0,
          false,
        );
        systemLines.push(presencePrompt);
        console.log('[index] Presence engineering injected');
      }

      // ── Pinned files: inject contents into system prompt ─────────────────
      // Injected BEFORE repo map so static pinned content stays in the cached
      // prefix. DeepSeek caches automatically on common prefix � repo map
      // (which changes every turn) would shift pinned positions and break cache.
      if (projectPath && projectId) {
        try {
          const pinnedRows = await getAdapter().all(
            'SELECT file_path FROM pinned_files WHERE user_id = ? AND project_id = ? ORDER BY created_at ASC',
            [userId, projectId]
          ) as Array<{ file_path: string }>;
          if (pinnedRows.length > 0) {
            const pinLines: string[] = ['', '=== PINNED FILES (always in context) ==='];
            for (const row of pinnedRows) {
              try {
                const absPath = require('path').join(projectPath, row.file_path);
                const content = require('fs').readFileSync(absPath, 'utf8');
                const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n... [truncated]' : content;
                pinLines.push(`\n--- ${row.file_path} ---\n${truncated}`);
              } catch {
                pinLines.push(`\n--- ${row.file_path} --- [could not read]`);
              }
            }
            systemLines.push(...pinLines);
            console.log(`[index] Injected ${pinnedRows.length} pinned file(s) into system prompt`);
          }
        } catch (err) {
          console.warn('[index] Pinned files injection failed:', (err as Error).message);
        }
      }

      // Repo map is now available as the get_repo_map tool � no longer auto-injected.
      // The agent calls it on-demand only when it needs to locate files, saving tokens.

      // ── Vector context: semantic chunk retrieval ──────────────────────────
      if (projectPath && projectId && isFeatureEnabled('ff_vector_context')) {
        try {
          const chunks = await searchChunks(msg.message as string, projectId, 8);
          if (chunks.length > 0) {
            systemLines.push(formatChunksForPrompt(chunks, projectPath));
            console.log(`[index] Vector context: injected ${chunks.length} relevant chunk(s)`);
          }
        } catch (err) {
          console.warn('[index] Vector context retrieval failed:', (err as Error).message);
        }
      }

      // ── Phase 3.1: Project Digest (first connect only) ──────────────────
      // Auto-reads README, package.json, tsconfig.json and caches result.
      if (projectPath) {
        try {
          if (!await isDigestCached(projectPath)) {
            const digest = buildProjectDigest(projectPath);
            if (digest) {
              systemLines.push(formatDigestForPrompt(digest));
              await markDigestCached(projectPath);
              console.log('[index] Project digest injected');
            }
          }
        } catch (err) {
          console.warn('[index] Project digest failed:', (err as Error).message);
        }

        // ── Phase 3.2: Architecture Graph ─────────────────────────────────
        try {
          const graph = buildArchitectureGraph(projectPath);
          if (graph.length > 0) {
            systemLines.push(formatGraphForPrompt(graph));
            console.log(`[index] Architecture graph injected (${graph.length} files)`);
          }
        } catch (err) {
          console.warn('[index] Architecture graph failed:', (err as Error).message);
        }

        // ── Phase 3.4: Health Check on Resume ─────────────────────────────
        try {
          const health = runHealthCheck(projectPath);
          if (health.hasUncommittedChanges || health.hasFailingTests) {
            systemLines.push(formatHealthCheckForPrompt(health));
            console.log('[index] Health check injected');
          }
        } catch (err) {
          console.warn('[index] Health check failed:', (err as Error).message);
        }
      }

      // ── Phase 3.3: Design Intent injection ───────────────────────────
      // Inject previously-learned user style/architecture preferences.
      try {
        const intentPrompt = await getDesignIntentsPrompt(userId);
        if (intentPrompt) {
          systemLines.push(intentPrompt);
          console.log('[index] Design intents injected');
        }
      } catch (err) {
        console.warn('[index] Design intents failed:', (err as Error).message);
      }

      // ── Phase 4.3: Interaction Pattern Analysis ───────────────────────
      // Analyze repeated error patterns and inject learnings.
      try {
        const patterns = await analyzeInteractionPatterns(userId);
        if (patterns.length > 0) {
          const patternPrompt = formatPatternAnalysisForPrompt(patterns);
          systemLines.push(patternPrompt);
          console.log(`[index] Pattern analysis injected (${patterns.length} patterns)`);
        }
      } catch (err) {
        console.warn('[index] Pattern analysis failed:', (err as Error).message);
      }

      // Capture pre-turn TypeScript snapshots for Change Guardian drift detection
      const SNAPSHOT_LABEL = `turn_${Date.now()}_${userId}`;
      if (projectPath) {
        try {
          const { glob } = require('glob');
          const tsFiles = await glob('**/*.{ts,tsx}', {
            cwd: projectPath,
            ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
          });
          const fullPaths = (tsFiles as string[]).slice(0, 30).map(f => path.join(projectPath, f));
          captureSnapshot(SNAPSHOT_LABEL, fullPaths);
          console.log(`[guardian] Captured pre-turn snapshot: ${fullPaths.length} TS files`);
        } catch {
          // Snapshot is best-effort
        }
      }

      // Inject per-project .suny-rules if present
      if (projectPath) {
        const rules = loadProjectRules(projectPath);
        if (rules) {
          systemLines.push('', RULES_SYSTEM_SECTION(rules));
          console.log('[index] Project rules injected');
        }

        // ── Background code index ─────────────────────────────────────────
        // Index the project on first access (fire-and-forget, non-blocking).
        if (isFeatureEnabled('ff_code_index')) {
          const indexKey = `indexed:${projectPath}`;
          const alreadyIndexed = await db.get("SELECT value FROM app_settings WHERE key = ?", [indexKey]) as { value: string } | undefined;
          if (!alreadyIndexed) {
            setImmediate(async () => {
              try {
                const stats = indexProject(projectPath);
                console.log(`[code-index] Indexed ${stats.filesIndexed} files (${stats.totalSymbols} symbols, ${stats.totalImports} imports)`);
                await db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, 'true')", [indexKey]);

                // Auto-generate .suny-rules with a project map from the index
                try {
                  const { searchCodeIndex } = require('./code-index');
                  const topExports = searchCodeIndex('', { limit: 50 });
                  if (topExports.length > 0) {
                    const grouped = new Map<string, string[]>();
                    for (const r of topExports) {
                      const f = r.filePath;
                      if (!grouped.has(f)) grouped.set(f, []);
                      grouped.get(f)!.push(`${r.symbol?.symbolName} (${r.symbol?.symbolType}, line ${r.symbol?.lineStart})`);
                    }
                    const lines = ['# Auto-generated project map � SUNy code index', ''];
                    for (const [file, symbols] of grouped) {
                      lines.push(`## ${file}`);
                      for (const s of symbols) lines.push(`- ${s}`);
                      lines.push('');
                    }
                    saveProjectRules(projectPath, lines.join('\n'));
                    console.log(`[code-index] Auto-generated .suny-rules for ${projectPath} (${topExports.length} symbols)`);
                  }
                } catch (rulesErr) {
                  console.warn('[code-index] .suny-rules generation failed:', (rulesErr as Error).message);
                }
              } catch (err) {
                console.warn('[code-index] Background indexing failed:', (err as Error).message);
              }
            });
          }
        }

        // ── Background vector chunk index ─────────────────────────────────
        // Runs after code_index (or independently for non-TS files).
        if (isFeatureEnabled('ff_vector_context') && projectId) {
          const chunkKey = `chunk_indexed:${projectPath}`;
          const alreadyChunked = await db.get("SELECT value FROM app_settings WHERE key = ?", [chunkKey]) as { value: string } | undefined;
          if (!alreadyChunked) {
            // Delay slightly to let code_index finish first
            setTimeout(async () => {
              try {
                // Ensure code_index ran first
                const indexKey = `indexed:${projectPath}`;
                const indexed = await db.get("SELECT value FROM app_settings WHERE key = ?", [indexKey]);
                if (!indexed) indexProject(projectPath);

                const stats = await buildChunkVectors(projectPath, projectId);
                console.log(`[code-chunks] Embedded ${stats.chunksIndexed} chunks across ${stats.filesProcessed} files`);
                await db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, 'true')", [chunkKey]);
                // Notify frontend
                userClientManager.pushToUser(userId, 'suny:vector_index_ready', {
                  projectId, chunks: stats.chunksIndexed, files: stats.filesProcessed,
                });
              } catch (err) {
                console.warn('[code-chunks] Background vector indexing failed:', (err as Error).message);
              }
            }, 3000);
          }
        }

        if (!talkMode) {
          systemLines.push(
            '',
            '=== SPEC-FIRST MODE (MANDATORY) ===',
            'Before editing or running commands, produce an internal spec block (not user-visible) with:',
            '1) Intent',
            '2) Acceptance criteria',
            '3) Relevant files',
            '4) Risk areas',
            '5) Verification plan',
            'After execution, explicitly verify each acceptance criterion before claiming success.',
          );
        }
      }
      // ── Project lock (prevents concurrent mutations) ─────────────────
      const projectLockHeld = projectPath && projectId
        ? await acquireLock(projectId, userId, sessionId)
        : true;
      if (!projectLockHeld) {
        const lockInfo = await getLockInfo(projectId!);
        const holder = lockInfo ? lockInfo.username : 'another session';
        const when = lockInfo ? lockInfo.lockedAt : 'unknown time';
        // Track whether this session has already seen a lock message
        const isRepeat = lockMessagesSent.has(sessionId);
        lockMessagesSent.add(sessionId);
        // Only push system_error toast on first occurrence � avoid spamming the user
        if (!isRepeat) {
          userClientManager.pushToUser(userId, 'suny:system_error', {
            message: `?? This project is locked by **${holder}** since ${when}. Please wait for their session to finish, or ask an admin to release the lock.`,
          });
        }
        // Embed lock details in the error message so the catch block can surface them.
        const detail = `LOCK_HOLDER:${holder}|LOCKED_AT:${when}|REPEAT:${isRepeat ? '1' : '0'}`;
        throw new Error(`Project is locked by another session (${detail})`);
      }
      // Lock acquired successfully � clear any stale repeat tracking
      lockMessagesSent.delete(sessionId);

      // ── Log session start ────────────────────────────────────────────
      logOperation({
        userId,
        projectId: projectId ?? null,
        sessionId,
        operation: 'session_start',
        status: 'started',
        detail: String(msg.message ?? '').slice(0, 200),
      });

      // -- Scan intent pre-check: guide user when no project is selected --
      const msgText = String(msg.message ?? '');
      const hasScanIntent = /\b(scan|analyze|explore|look at|check out|list|show me)\b/i.test(msgText) &&
        /\b(project|codebase|repo|folder|directory|root|src)\b/i.test(msgText);
      if (hasScanIntent && !projectPath) {
        userClientManager.pushChatContent(userId, 'suny:stream_end', {
          content: 'I\'d love to scan your project! First, please open or create a project from the sidebar.',
          sess_used: null, sess_limit: null, iterations: 0,
        });
        return;
      }

      // Run the full agent loop
      // Start "Did you know?" timer — fires every 60s for long tasks
      const stopDidYouKnow = startDidYouKnowTimer(userId, currentAbortController.signal);
      const maxTurnMs = projectPath ? 180_000 : 70_000;
      const turnTimeout = setTimeout(() => {
        if (currentAbortController && !currentAbortController.signal.aborted) {
          timedOutByGuard = true;
          currentAbortController.abort(new Error(`TURN_TIMEOUT_${maxTurnMs}`));
        }
      }, maxTurnMs);
      // -- Pre-run forecast gate ----------------------------------------------
      clearSessionSpend(sessionId);
      const forecastPlanAllowed = isPlanFeatureEnabled('pf_cost_forecast', userPlan);
      const budgetPlanAllowed = isPlanFeatureEnabled('pf_budget_gate', userPlan);
      if (!talkMode && effectiveMode !== 'free' && isForecastEnabled(userId) && forecastPlanAllowed) {
        try {
          userClientManager.pushToUser(userId, 'suny:forecast_loading', {});
          // We need a model reference � use the primary model from the mode
          const { getModelsForMode } = await import('./agent');
          // Wrap getModelsForMode in 5s timeout to prevent hanging
          const modelsPromise = getModelsForMode(effectiveMode);
          const modelsTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getModels timeout')), 5000)
          );
          const modelEntries = await Promise.race([modelsPromise, modelsTimeout]).catch(() => []);
          if (modelEntries.length > 0) {
            const firstEntry = modelEntries[0];
            // Add 30s timeout to prevent forecast from hanging forever
            const forecastPromise = buildForecast(
              userId, projectId ?? null, sessionId, effectiveMode,
              msg.message as string, firstEntry.model, firstEntry.provider,
            );
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Forecast timeout')), 30000)
            );
            const forecast = await Promise.race([forecastPromise, timeoutPromise]);
            const billing = await import('./billing');
            userClientManager.pushToUser(userId, 'suny:pre_run_estimate', {
              lowCredits: forecast.lowCredits,
              highCredits: forecast.highCredits,
              historicalSamples: forecast.historicalSamples,
              estimatedSteps: forecast.estimatedSteps,
              confidence: forecast.confidence,
              basedOn: forecast.basedOn,
              currentBalance: await billing.getUserBalance(userId),
              walletBalance: await billing.getUserWalletBalance(userId),
              mode: effectiveMode,
            });
            // Wait for user to approve or cancel via the Run/Cancel buttons
            const approved = await userClientManager.waitForCheckpoint(userId, 'Cost Estimate', 'Review the estimated cost and click Run to proceed or Cancel to abort.');
            if (!approved) {
              userClientManager.pushChatContent(userId, 'suny:stream_end', { content: '', sess_used: null, sess_limit: null, iterations: 0 });
              return;
            }
          } else {
            // No models available - clear forecast loading state and proceed
            userClientManager.pushToUser(userId, 'suny:pre_run_estimate', null);
          }
        } catch (fe) {
          console.warn('[forecast] Failed, proceeding anyway:', (fe as Error).message);
          // Clear forecast loading state on error so UI doesn't get stuck
          userClientManager.pushToUser(userId, 'suny:pre_run_estimate', null);
        }
      }

      let result;
      let timedOutByGuard = false;
      try {
        // Budget gate callbacks (only attached when budget gate is enabled + plan allows)
        const budgetCap = (isBudgetGateEnabled(userId) && budgetPlanAllowed) ? getBudgetPerRun(userId) : null;
        const budgetCallbacks = budgetCap ? {
          budgetCapCredits: budgetCap,
          onBudgetWarning: (spent: number, cap: number, pct: number) => {
            userClientManager.pushToUser(userId, 'suny:budget_warning', {
              spent,
              cap,
              pct,
              message: `You've used ${Math.round(pct * 100)}% of your $${cap.toFixed(4)} run budget ($${spent.toFixed(4)} spent).`,
            });
          },
          onBudgetGate: async (spent: number, cap: number) => {
            return userClientManager.waitForBudgetGate(userId, spent, cap);
          },
          onBudgetExtend: async () => {
            const newCap = pendingBudgetExtensions.get(userId) ?? (budgetCap * 2);
            pendingBudgetExtensions.delete(userId);
            return newCap;
          },
        } : {};

        const runLoop = () => withUserQueue(userId, () => runAgentLoop({
          userId,
          mode: effectiveMode,
          systemPrompt: systemLines.join('\n'),
          projectId,
          projectPath,
          history,
          userMessage: msg.message as string,
          imageData: msg.imageData as string | undefined,
          sessionId,
          talkMode,
          autoExecuteOverride: projectAutoExecuteOverride === 1,
          signal: currentAbortController!.signal,
          onChunk: (chunk) => {
            userClientManager.pushChatContent(userId, 'suny:stream_chunk', { chunk });
          },
          ...budgetCallbacks,
        }));

        try {
          result = await runLoop();
        } catch (loopErr) {
          const loopMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
          if (loopMsg === 'BUDGET_STOP') {
            userClientManager.pushChatContent(userId, 'suny:stream_end', {
              content: '?? Run stopped at budget limit. Work completed up to this point has been saved.',
              sess_used: null, sess_limit: null, iterations: 0,
            });
            isProcessing = false;
            return;
          } else if (loopMsg.toLowerCase().includes('await is not defined')) {
            console.warn('[chat:retry] Retrying once after await-reference error');
            result = await runLoop();
          } else {
            throw loopErr;
          }
        }
      } finally {
        clearTimeout(turnTimeout);
        stopDidYouKnow();

        // Release project lock
        if (projectId) {
          await releaseLock(projectId, sessionId);
          lockMessagesSent.delete(sessionId);
        }

        // Log session end
        logOperation({
          userId,
          projectId: projectId ?? null,
          sessionId,
          operation: 'session_end',
          status: result ? 'success' : 'error',
          detail: result ? `files: ${result.changedFiles.length}` : 'error',
        });
      }

      // ── Post-turn: extract blueprint memory for SUNy Code Conscience ─────
      try {
        const changedFiles = result.changedFiles ?? [];
        let turnSummary: string;
        let turnDetails: string | undefined;

        if (changedFiles.length > 0) {
          turnSummary = `Modified ${changedFiles.length} file(s) for: ${(msg.message as string).slice(0, 120)}`;
          turnDetails = `Files changed:\n${changedFiles.map(f => `  - ${f}`).join('\n')}\n\nAI response preview: ${result.content.slice(0, 500)}`;
        } else {
          turnSummary = `Conversational turn: ${(msg.message as string).slice(0, 120)}`;
        }

        await storeBlueprintEntry({
          userId,
          projectId: projectId ?? null,
          sessionId,
          turnIndex: result.iterations,
          summary: turnSummary,
          details: turnDetails,
          intent: msg.message as string,
          affectedFiles: changedFiles.length > 0 ? changedFiles : undefined,
        });

        if (changedFiles.length > 0) {
          console.log(`[blueprint] Stored entry: ${changedFiles.length} files changed, ${result.content.length} chars response`);
        }

        // ── Phase 2.2: Blueprint → Rule Pipeline ──────────────────────
        // When blueprint memory detects repeated patterns (same file 3+ times),
        // auto-generate behavioral rules.
        try {
          const ruleResult = await generateRulesFromPatterns({ userId, projectId: projectId ?? null });
          if (ruleResult.generated > 0) {
            console.log(`[blueprint→rule] ${ruleResult.reason}`);
          }
        } catch (ruleErr) {
          console.warn('[blueprint→rule] Pattern detection error:', (ruleErr as Error).message);
        }

        // ── Phase 2.4: Cross-Project Persona Memory ────────────────────
        // Track user preferences (verbosity, formality, framework choices)
        // so they carry across projects.
        try {
          const personaResult = await updateCrossProjectPersona({
            userId,
            projectId: projectId ?? null,
            userMessage: msg.message as string,
            aiResponse: result.content,
          });
          if (personaResult.updated) {
            console.log(`[cross-project-persona] ${personaResult.reason}`);
          }
        } catch (personaErr) {
          console.warn('[cross-project-persona] Update error:', (personaErr as Error).message);
        }

        // ── Phase 3.3: Design Intent Tracker ───────────────────────────
        // Harvest explicit user design preferences from conversation.
        try {
          const intentResult = await processDesignIntents(userId, msg.message as string);
          if (intentResult) {
            console.log('[design-intent] Detected new user preferences');
          }
        } catch (intentErr) {
          console.warn('[design-intent] Extraction error:', (intentErr as Error).message);
        }
      } catch (bpErr) {
        // Blueprint extraction is best-effort � never block the main flow
        console.warn('[blueprint] Extraction error:', (bpErr as Error).message);
      }

      // ── Post-turn: Goal tracker � update active goal with turn evidence ──
      if (projectId && isFeatureEnabled('ff_goal_tracker') && result.changedFiles?.length) {
        try {
          const activeGoal = getCurrentGoal(userId, projectId);
          if (activeGoal) {
            const changedSummary = result.changedFiles.slice(0, 5).join(', ');
            addGoalEvidence(activeGoal.id, `Modified ${result.changedFiles.length} file(s): ${changedSummary}`);
            incrementGoalAttempt(activeGoal.id);
            const completed = tryAutoCompleteGoal(activeGoal.id);
            if (completed) {
              console.log(`[goal-tracker] Auto-completed goal: ${activeGoal.description.slice(0, 80)}`);
            }
          }
        } catch (gErr) {
          console.warn('[goal-tracker] Post-turn update error:', (gErr as Error).message);
        }
      }

      // ── Post-turn: Change Guardian drift detection ─────────────────────
      if (result.changedFiles?.length) {
        try {
          // Filter to TypeScript files only (snapshot only captures .ts/.tsx)
          const tsChanged = result.changedFiles.filter((f: string) => /\.(ts|tsx)$/.test(f));
          if (tsChanged.length > 0) {
            const driftReport = detectDrift(SNAPSHOT_LABEL, tsChanged, msg.message as string);
            if (driftReport && driftReport.hasDrift) {
              console.log(`[guardian] Drift detected: ${driftReport.summary.slice(0, 200)}`);
              // Feed drift warning into narration so the user is aware
              const unintentional = driftReport.files.flatMap(f =>
                f.changes.filter(c => !c.isIntentional)
              );
              if (unintentional.length > 0) {
                const names = unintentional.map(c => `\`${c.name}\``).join(', ');
                userClientManager.pushToUser(userId, 'suny:narration', {
                  message: `🧠 Code Conscience: detected ${unintentional.length} change(s) that may drift from intent � ${names}`,
                });
              }
            } else {
              console.log(`[guardian] No drift detected across ${tsChanged.length} changed TS file(s)`);
            }
          }
        } catch (gdErr) {
          console.warn('[guardian] Drift detection error:', (gdErr as Error).message);
        }
      }

      // ── Phase 4: Verification Obsession ──────────────────────────────
      if (result.changedFiles?.length && projectPath) {
        // 4.1: Silent code review of changed files
        try {
          const review = silentCodeReview(projectPath, result.changedFiles);
          if (review.totalIssues > 0) {
            console.log(`[verify] Code review: ${review.summary}`);
          }
        } catch (reviewErr) {
          console.warn('[verify] Code review error:', (reviewErr as Error).message);
        }

        // 4.2: Post-merge validation (type check + test check)
        try {
          const validation = postMergeValidation(projectPath);
          if (!validation.typeCheckPassed || validation.testsPassed === false) {
            const valMsg = formatValidationForPrompt(validation);
            // Push validation failure as a narration to the user
            if (!validation.typeCheckPassed) {
              userClientManager.pushToUser(userId, 'suny:narration', {
                message: `?? TypeScript: ${validation.typeCheckErrors} error(s) detected after changes`,
              });
            }
            console.log(`[verify] Post-merge validation: ${valMsg.slice(0, 200)}`);
          }
        } catch (valErr) {
          console.warn('[verify] Post-merge validation error:', (valErr as Error).message);
        }
      }

      // 4.3: Record interaction events for pattern analysis
      if (result.lintErrors?.length) {
        for (const le of result.lintErrors) {
          try {
            await recordInteraction(userId, msg.id as string, 'lint_error', le.rule || le.message || 'unknown', le.file);
          } catch {}
        }
      }
      if (result.testFailures?.length) {
        for (const tf of result.testFailures) {
          try {
            await recordInteraction(userId, msg.id as string, 'test_failure', tf.name || tf.message || 'unknown', tf.file);
          } catch {}
        }
      }
      if (result.loopCount && result.loopCount > 1) {
        try {
          await recordInteraction(userId, msg.id as string, 'loop', `correction-loop-${result.loopCount}x`, '');
        } catch {}
      }

      // ── Phase 5: Presence profile update ────────────────────────────
      try {
        await updatePresenceProfile(
          userId,
          Math.round((Date.now() - turnStart) / 1000),
          !result.success,
        );
      } catch (presenceErr) {
        // Best-effort
      }

      let billing: { rawCost: number; chargedCost: number; newBalance: number; newWalletBalance: number; billingError?: string };
      try {
        billing = await deductUsage(
          userId, sessionId, projectId ?? null, result.resolvedMode ?? effectiveMode,
          result.inputTokens, result.outputTokens,
          result.cacheWriteTokens, result.cacheReadTokens,
          result.apiKeyId
        );
        // Track cumulative spend for budget gate
        const sessionTotal = trackSessionSpend(sessionId, billing.chargedCost);
        const budgetCap = isBudgetGateEnabled(userId) ? getBudgetPerRun(userId) : null;
        if (budgetCap && sessionTotal >= budgetCap) {
          userClientManager.pushToUser(userId, 'suny:budget_exceeded', {
            spent: sessionTotal,
            cap: budgetCap,
            message: `Run spent $${sessionTotal.toFixed(4)} � exceeded your $${budgetCap.toFixed(4)} per-run budget.`,
          });
        }
      } catch (billErr) {
        const billMsg = (billErr as Error).message;
        console.warn('[billing] deductUsage failed (non-fatal):', billMsg);
        billing = { rawCost: 0, chargedCost: 0, newBalance: 0, newWalletBalance: 0, billingError: billMsg };
      }

      if (isFeatureEnabled('ff_benchmark_mode')) {
        try {
          await recordBenchmarkRun({
            userId,
            projectId: projectId ?? null,
            sessionId,
            requestText: String(msg.message ?? ''),
            finalAnswer: result.content,
            mode: result.resolvedMode ?? effectiveMode,
            durationMs: result.proofSummary.durationMs,
            retries: Math.max(0, (result.proofSummary.steps ?? 1) - 1),
            toolCalls: result.proofSummary.toolCallCount,
            compilePass: !!result.proofSummary.lintPassed,
            testPass: !!result.proofSummary.testPassed,
            costUsd: billing.chargedCost,
            changedFiles: result.changedFiles ?? [],
          });
        } catch (benchErr) {
          console.warn('[benchmark] Failed to record benchmark run:', (benchErr as Error).message);
        }
      }

      const totalTokens = result.inputTokens + result.outputTokens + result.cacheWriteTokens + result.cacheReadTokens;
      const toolCalls = result.proofSummary.toolCallCount ?? 0;
      const filesChanged = result.proofSummary.filesChanged ?? 0;
      const steps = result.proofSummary.steps ?? 1;
      const durationMinutes = Math.max(0, result.proofSummary.durationMs / 60000);

      // ── Record success metric ─────────────────────────────────────────
      try {
        recordAgentTurn({
          userId,
          sessionId,
          projectId: projectId ?? null,
          mode: effectiveMode,
          toolCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: billing.chargedCost,
          success: true,
          durationMs: result.proofSummary.durationMs,
        });
      } catch { /* metrics must not crash the server */ }

      // Record codebase health delta (non-fatal)
      if (projectId) {
        recordHealthScore({
          userId,
          projectId,
          sessionId,
          changedFiles: result.changedFiles ?? [],
          lintPassed: result.proofSummary.lintPassed,
          lintErrorsFound: result.proofSummary.lintErrorsFound,
          testPassed: result.proofSummary.testPassed,
          testFailuresFound: result.proofSummary.testFailuresFound,
          testRuns: result.proofSummary.testRuns,
          projectPath,
        }).then(({ score, delta }) => {
          userClientManager.pushToUser(userId, 'suny:health_score', { score, delta, projectId });
        }).catch(() => {});
      }

      const sessStats = await db.get(
        'SELECT SUM(input_tokens + output_tokens) as total_used FROM usage_log WHERE user_id = ? AND session_id = ?',
        [userId, sessionId]
      ) as { total_used: number | null };

      const isSimpleReply = toolCalls === 0 && filesChanged === 0 && steps <= 1;
      const humanEstimateMinutes = isSimpleReply
        ? Math.max(0.5, Math.round(durationMinutes * 10) / 10)
        : Math.max(
            2,
            Math.round(
              durationMinutes * 3 +
              (toolCalls * 1.5) +
              (filesChanged * 2) +
              (Math.max(0, steps - 1) * 0.75),
            ),
          );
      const HOURLY_RATE_USD = 35;
      const humanEstimateCost = Math.round(((humanEstimateMinutes / 60) * HOURLY_RATE_USD) * 100) / 100;
      const finalContent = normalizeFinalContent(userId, result.content);

      // Signal end of stream with final content + billing info
      userClientManager.pushChatContent(userId, 'suny:stream_end', {
        content: finalContent,
        sess_used: sessStats?.total_used ?? 0,
        sess_limit: userRow?.max_tokens_per_session ?? null,
        iterations: result.iterations,
        proof_summary: result.proofSummary,
        routing_reason: routingReason,
        resolved_mode: effectiveMode,
        billing_error: billing.billingError,
        turn_report: {
          durationMs: result.proofSummary.durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheWriteTokens: result.cacheWriteTokens,
          cacheReadTokens: result.cacheReadTokens,
          totalTokens,
          rawCost: billing.rawCost,
          chargedCost: billing.chargedCost,
          humanEstimateMinutes,
          humanEstimateCost,
        },
      });
      userClientManager.pushToUser(userId, 'suny:balance', {
        balance: billing.newBalance,
        wallet_balance: billing.newWalletBalance,
        sess_used: sessStats?.total_used ?? 0,
        sess_limit: userRow?.max_tokens_per_session ?? null,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '';
      const isAbortLike = errMsg.includes('cancelled') || errMsg.includes('abort') || errMsg.includes('AbortError');
      const isTurnTimeout = timedOutByGuard || errMsg.includes('TURN_TIMEOUT_');
      // User-initiated cancel is already handled upstream and should not emit a second generic error.
      // Timeouts must continue through the error path so the client receives a stream_end message.
      if (isAbortLike && !isTurnTimeout) return;
      // All other errors � always respond so the client never gets stuck in thinking state
      let friendly = pickRandom('error', pickNonRepeatingFallback(userId, ERROR_REPLY_FALLBACKS));
      let errorCategory = 'unknown';
      if (errMsg.includes('No active API key')) { friendly = 'The AI service is not available right now. Please contact support.'; errorCategory = 'no_key'; }
      if (errMsg.includes('NO_VISION_MODEL_AVAILABLE')) { friendly = 'I\'m a text-only model and can\'t scan images. To analyze images, please add an API key for a vision-capable model (OpenAI, Anthropic, Groq, or OpenRouter) in the admin settings, then try again.'; errorCategory = 'no_vision_model'; }
      if (isTurnTimeout) { friendly = 'This task took too long and was safely stopped. Please try again, or ask in smaller steps.'; errorCategory = 'timeout'; }
      if (errMsg.includes('Project is locked by another session')) {
        // Extract lock holder details and repeat flag from the structured error message
        const holderMatch = errMsg.match(/LOCK_HOLDER:([^|]+)/);
        const whenMatch = errMsg.match(/LOCKED_AT:([^)]+)/);
        const repeatMatch = errMsg.match(/REPEAT:(\d)/);
        const holder = holderMatch ? holderMatch[1] : 'another session';
        const when = whenMatch ? whenMatch[1] : 'unknown time';
        const isRepeat = repeatMatch && repeatMatch[1] === '1';
        if (isRepeat) {
          friendly = `??� Still locked by **${holder}**. The lock auto-expires after 5 minutes of inactivity.`;
        } else {
          friendly = `??� This project is locked by **${holder}** since ${when}.\n\n` +
            'Only one session can work on a project at a time to prevent conflicts.\n' +
            'Options:\n' +
            '• Wait for their session to finish (the lock auto-expires after 5 minutes of inactivity).\n' +
            '• If this is a stale lock from a crashed session, ask an admin to clear it from the project_locks table.';
        }
        errorCategory = 'lock';
      }
      if (errMsg.includes('Too many pending requests')) { friendly = 'You have too many active requests. Please wait for the current ones to finish, then try again.'; errorCategory = 'rate_limit'; }
      if (errMsg.toLowerCase().includes('fetch failed') || errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('econn')) {
        friendly = 'AI provider is temporarily unavailable right now. Please retry in a few seconds.';
        errorCategory = 'api_error';
      }
      const msgText2 = String(msg.message ?? '').toLowerCase();
      const isScanIntent = /\b(scan|analyze|explore|look at|check)\b.*\b(project|codebase|repo|folder|directory|root)\b|\bscan\b/.test(msgText2);
      if (isScanIntent && !projectPath) {
        friendly = 'I tried to scan but no project is currently selected. Please click the project icon in the left sidebar, select or create a project, then ask me to scan again.';
        errorCategory = 'no_project';
      }
      // Also handle the old specific error for backward compatibility
      if (errMsg.toLowerCase().includes('await is not defined')) {
        friendly = 'I hit a temporary execution issue while scanning. I can still do a direct scan for you now � say: scan root, scan src, or scan bridge.';
        errorCategory = 'runtime';
      }
      if (errMsg.toLowerCase().includes('insufficient')) { friendly = pickRandom('no_balance', "You're out of credits! Reach out and we'll top you right up ??"); errorCategory = 'credits'; }
      if (errMsg.toLowerCase().includes('rate') && errMsg.toLowerCase().includes('limit')) { errorCategory = 'rate_limit'; }
      if (errMsg.includes('ALL PROVIDERS EXHAUSTED')) {
        friendly = pickNonRepeatingFallback(userId, EXHAUSTED_REPLY_FALLBACKS);
        errorCategory = 'exhausted';
      }

      // Record failure metric
      try {
        recordAgentTurn({
          userId,
          sessionId,
          projectId: projectId ?? null,
          mode: effectiveMode,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          success: false,
          errorCategory,
          durationMs: Date.now() - turnStart,
        });
      } catch { /* metrics must not crash the server */ }

      console.error('[chat:error]', err instanceof Error ? err.stack || err.message : err);
      // Include the real error message for debugging � the user/test needs to
      // know what actually broke, not just "internal hiccup". The friendly message
      // is shown for known patterns; unknown errors reveal their real message
      // so the test suite can diagnose tool failures vs API failures vs config.
      const detailSuffix = errorCategory === 'unknown' && errMsg
        ? `\n\n[Error details: ${errMsg.slice(0, 500)}]`
        : '';
      userClientManager.pushChatContent(userId, 'suny:stream_end', {
        content: friendly + detailSuffix,
        sess_used: null,
        sess_limit: null,
        iterations: 0,
      });
    } finally {
      isProcessing = false;
      currentAbortController = null;
    }

    // ── Queued message re-dispatch (AiderDesk-style interruption) ──
    if (queuedMessage) {
      const nextRaw = queuedMessage;
      queuedMessage = null;
      setImmediate(async () => { ws.emit('message', nextRaw); });
    }
  });
}
}