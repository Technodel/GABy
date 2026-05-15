import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import WebSocket, { WebSocketServer } from 'ws';
import { adminLogin, userLogin, userRegister, logout, requireAuth, requireAdmin } from './auth';
import adminRouter from './admin-routes';
import userRouter from './user-routes';
import mcpRouter from './mcp-routes';
import { handleBridgeUpgrade } from './bridge-routes';
import { userClientManager } from './user-client-manager';
import { isBridgeConnected, registerPathForUser } from './bridge-manager';
import { verifyToken } from './auth';
import { getDb } from './db';
import { AgentMessage } from './agent';
import { hasSufficientBalance, deductUsage } from './billing';
import { runAgentLoop } from './agent-loop';
import { buildRepoMap } from './repo-map';
import { pickRandom, startDidYouKnowTimer } from './personality';
import { loadProjectRules, RULES_SYSTEM_SECTION } from './project-rules';
import { getBlueprintContext, storeBlueprintEntry, getBlueprintSummary } from './blueprint-memory';
import { captureSnapshot, detectDrift, formatDriftForCorrection } from './change-guardian';
import { mcpManager } from './mcp-manager';

const PORT = parseInt(process.env.SUNY_PORT || '3000', 10);
const ALLOWED_ORIGIN = process.env.SUNY_ALLOWED_ORIGIN || 'http://localhost:5173';

const app = express();
const server = http.createServer(app);

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(cors({
  origin: [ALLOWED_ORIGIN, 'http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Rate limiting on auth routes (relaxed in development)
const isDev = process.env.NODE_ENV !== 'production';
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 100 : 5,
  message: { error: 'Too many login attempts. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Auth routes ────────────────────────────────────────────────────────────────

app.post('/admin/login', authLimiter, adminLogin);
app.post('/api/login', authLimiter, userLogin);
app.post('/api/register', authLimiter, userRegister);
app.post('/api/logout', logout);
app.post('/admin/logout', logout);

// Lightweight admin session check
app.get('/admin/me', requireAdmin, (_req, res) => {
  res.json({ role: 'admin' });
});

// ── Admin API ──────────────────────────────────────────────────────────────────

app.use('/admin/api', adminRouter);

// ── User API ───────────────────────────────────────────────────────────────────

app.use('/api', userRouter);

// ── MCP Server API ──────────────────────────────────────────────────────────────

app.use('/api', mcpRouter);

// ── Serve bridge downloads (public) ───────────────────────────────────────────
const bridgeDist = path.join(__dirname, '../../public/bridge');
app.use('/bridge', express.static(bridgeDist));

// ── Serve frontend build (production) ─────────────────────────────────────────

const rendererDist = path.join(__dirname, '../../src/renderer/dist');
app.use(express.static(rendererDist));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/admin/api')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(path.join(rendererDist, 'index.html'));
});

// ── WebSocket server ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', `http://localhost`);
  const pathname = url.pathname;

  if (pathname === '/bridge') {
    // Bridge agent connections (local agent on user's machine)
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleBridgeUpgrade(ws, req);
    });
  } else if (pathname === '/ws') {
    // Browser client connections (user's browser tab)
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleUserClientUpgrade(ws, req);
    });
  } else {
    socket.destroy();
  }
});

function handleUserClientUpgrade(ws: WebSocket, req: http.IncomingMessage): void {
  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('token') ||
    req.headers.cookie?.split(';').find(c => c.trim().startsWith('suny_token='))?.split('=')[1];

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

  ws.on('message', async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Handle cancel request
    if (msg.type === 'chat:cancel') {
      if (currentAbortController) {
        const cancelMessage = pickRandom('cancel', "Got it — I've stopped! What's next? 😊");
        currentAbortController.abort(new Error('Request cancelled by user'));
        currentAbortController = null;
        isProcessing = false;
        userClientManager.pushChatContent(userId, 'suny:stream_end', {
          content: cancelMessage,
          sess_used: null,
          sess_limit: null,
          iterations: 0,
        });
        // Also tell the bridge to kill any running process
        const { killBridgeRequest } = require('./bridge-manager');
        killBridgeRequest(userId, (msg.requestId as string) || '');
      }
      return;
    }

    if (msg.type !== 'chat:message') return;
    if (isProcessing) {
      const busyMessage = pickRandom('busy', "I'm still working on your last message — hang tight! 😊");
      userClientManager.pushChatContent(userId, 'suny:stream_end', {
        content: busyMessage,
        sess_used: null,
        sess_limit: null,
        iterations: 0,
      });
      return;
    }

    isProcessing = true;
    currentAbortController = new AbortController();
    try {
      const db = getDb();
      const userRow = db.prepare('SELECT selected_mode, max_tokens_per_session, display_name FROM users WHERE id = ?')
        .get(userId) as { selected_mode: string; max_tokens_per_session: number | null; display_name: string | null } | undefined;

      const requestedMode = (msg.mode as string) || userRow?.selected_mode || 'fast';
      const dailyLimitRow = db.prepare("SELECT value FROM app_settings WHERE key = 'daily_token_limit'").get() as { value: string } | undefined;
      const dailyTokenLimit = parseInt(dailyLimitRow?.value || '0', 10);
      const todayUsed = db.prepare(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used FROM usage_log WHERE user_id = ? AND DATE(timestamp) = DATE('now')"
      ).get(userId) as { total_used: number };
      const noCredits = !hasSufficientBalance(userId);
      const dailyCapApplies = noCredits || requestedMode === 'free';
      const dailyLimitReached = dailyCapApplies && dailyTokenLimit > 0 && todayUsed.total_used >= dailyTokenLimit;
      const freeTalkOnly = noCredits || dailyLimitReached;
      const mode = freeTalkOnly ? 'free' : requestedMode;
      
      // Generate routing reason (why this tier was selected — no model names)
      let routingReason = '';
      if (dailyLimitReached) {
        routingReason = 'Daily token limit reached';
      } else if (noCredits) {
        routingReason = 'Budget exhausted';
      } else if (requestedMode === 'free') {
        routingReason = 'Free tier (user preference)';
      } else if (requestedMode === 'fast') {
        routingReason = 'Fast tier (low complexity)';
      } else if (requestedMode === 'smart') {
        routingReason = 'Smart tier (complex work)';
      } else if (requestedMode === 'pro') {
        routingReason = 'Pro tier (maximum capability)';
      } else {
        routingReason = requestedMode;
      }
      
      const sessionId = (msg.sessionId as string) || `ws_${userId}`;
      const history = (msg.history as AgentMessage[]) || [];
      const displayName = userRow?.display_name;
      const showTechnicalDetails = msg.showTechnicalDetails === true;
      const talkMode = msg.talkMode === true || freeTalkOnly;

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
        const sessStats = db.prepare(
          'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used FROM usage_log WHERE user_id = ? AND session_id = ?'
        ).get(userId, sessionId) as { total_used: number };
        const remaining = userRow.max_tokens_per_session - sessStats.total_used;
        if (remaining <= 0) {
          const limitMessage = pickRandom('session_limit', "You've reached the session token limit. Start a new session to continue! 😊");
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

      const bridgeOnline = isBridgeConnected(userId);

      // Load plan info once — used in system prompt
      interface PricingMode { mode: string; display_name: string; description: string; }
      const pricingModes = db.prepare('SELECT mode, display_name, description FROM pricing_modes ORDER BY id').all() as PricingMode[];

      const systemLines = [
        'You are SUNy — the Smart Unstoppable Navigator — an expert, detail-oriented software engineer.',
        'You are meticulous. You distrust your own assumptions. You verify everything before acting.',
        'You are concise, relentless, and you never give up until the task is COMPLETE.',
        bridgeOnline
          ? 'You have native tools to read, write, and edit files, run shell commands, search code, list directories, and more.'
          : 'The user\'s local bridge is currently offline, so file/shell tools are unavailable. You can still reason, review code snippets the user pastes, answer questions, explain concepts, and help plan solutions.',
        '',
        '=== WHAT THE BRIDGE IS ===',
        'The SUNy Bridge is a small background process the user installs on their local computer.',
        'It connects their machine to this server over a secure WebSocket, giving SUNy direct access to their filesystem and terminal.',
        'Without bridge: SUNy can only chat, review pasted code, answer questions, and plan — no file edits or shell commands.',
        'With bridge connected, SUNy can:',
        '  - Read, write, create and edit files in the user\'s project folder',
        '  - Run shell/terminal commands (npm install, build, tests, linters, compilers, etc.)',
        '  - Browse the project file tree and search code',
        '  - Start and stop the dev server from the sidebar',
        '  - Automatically commit changes to git after each turn (checkpoints)',
        '  - Run lint/type-check loops and fix errors automatically',
        'If the user asks what the bridge does or what features they get with it, answer based on the above.',
        '',
        '=== MCP TOOLS ===',
        'MCP (Model Context Protocol) servers can be connected to extend your capabilities dynamically.',
        'Connected MCP servers provide additional tools beyond the built-in ones.',
        'When MCP tools are available, they appear alongside the built-in tools (file_read, bash, etc.).',
        'Use them exactly like any other tool — call them when appropriate for the task.',
        'If no MCP tools are connected, this section is irrelevant. Ignore it.',
        '',
        '=== LAWS ===',
        'These are NON-NEGOTIABLE. You cannot violate them.',
        '',
        'Rule 1 — CONTEXT-FIRST:',
        'Never modify code without first identifying ALL relevant files and reading them.',
        'Use tools to understand the full picture — imports, dependents, types, configs, tests.',
        'Never act on assumptions or memory of what a file contains.',
        '',
        'Rule 2 — NO-GUESS:',
        "If uncertain about ANY part of the codebase — a file's content, a function's signature,",
        "a regex pattern's match, a data structure's shape — use tools to gather information.",
        'Do not guess. Write a diagnostic script if needed. Verify, then act.',
        '',
        'Rule 3 — ONE CHANGE PER ATTEMPT:',
        'When debugging extraction logic, parsing rules, or fixing lint/test failures,',
        'modify exactly ONE logic block per attempt. Run it. Verify the output changed',
        'as expected. Then change the next. Never change multiple variables at once —',
        "you won't know which fix worked.",
        '',
        'Rule 4 — VERIFY AT EVERY BOUNDARY:',
        'After each pipeline phase (extract, filter, transform, store), run a verification:',
        'count items, sample rows, check for NULLs/zeros, compare to expected target.',
        'Report the numbers. If the count doesn\'t match, investigate before proceeding.',
        '',
        'Rule 5 — STREAMING FOR SCALE:',
        'For inputs larger than 100KB, prefer streaming/iterator patterns over loading',
        'full data structures into memory. Use bash with streaming Node.js scripts.',
        'Loading entire datasets causes crashes — never do it.',
        '',
        'Rule 6 — EXHAUST TOOLS FIRST:',
        'Exhaust all available tools before asking the user for help. If you hit an error,',
        'try an alternative approach, write a diagnostic, inspect the real data.',
        'The user should never be your first resort.',
        '',
        '=== WORKFLOW ===',
        '- Casual chat (greetings, questions) → reply naturally. Do NOT call tools.',
        bridgeOnline
          ? '- Code / file tasks → call the relevant tool(s) immediately. Do NOT describe what you plan to do first.'
          : '- File tasks → explain clearly that you need the bridge connected to edit files, and offer to help in any way you can without file access (review pasted code, explain the fix, etc.).',
        '- Before reading a file, check the <repo_map> (if present below) to confirm it exists and see its symbols.',
        '- When editing existing files, use file_read first then file_edit (search/replace) for targeted changes.',
        '- Use file_write only for new files or full rewrites.',
        bridgeOnline ? '- After making code changes, run the project linter/compiler via bash to verify correctness.' : '',
        bridgeOnline ? '  Example: bash("tsc --noEmit") or bash("npm run lint") or bash("cargo check").' : '',
        bridgeOnline ? '- If the linter returns errors, fix them immediately in the same turn without asking.' : '',
        '- After completing a task, give ONE brief sentence explaining what you did.',
        '',
        '- === PARSING / EXTRACTION TASKS ===',
        '  When extracting data from structured content (HTML, JSON, XML, logs):',
        '    1. Anchor on the most stable structural wrapper element — not the data field',
        '       you want. Data attributes move; containers rarely change.',
        '    2. Extract IDs from attributes, not from text content.',
        '    3. Prefer specific selectors over first-match.',
        '    4. Blacklist known junk patterns (admin routes, cart URLs, javascript: links).',
        '    5. Deduplicate by normalized identifier using a Set.',
        '    6. Always normalize — strip query strings, hashes, trailing slashes.',
        '',
        '- === DIAGNOSTIC SCRIPTS ===',
        '  Before writing any parser/extractor, or when a script returns unexpected output:',
        '    1. Write a THROWAWAY diagnostic script (prefix filename with _)',
        '    2. file_write → bash → inspect raw stdout',
        '    3. Identify the real issue from actual data, not from what you expect',
        '    4. Fix one thing, test, verify',
        "    5. Delete the diagnostic file when done (do NOT commit throwaway scripts)",
        '  The diagnostic script converts "I think the data looks like X" into',
        '  "The data at offset N contains: ..." — that\'s the difference between guessing',
        '  and knowing.',
        '',
        '- === SHELL COMMAND ADAPTATION ===',
        "  Detect the user's operating system and adapt shell commands accordingly:",
        '  - Windows (PowerShell): does NOT support &&, ||, ; chaining reliably.',
        '    Use separate bash() calls for each command instead of chaining.',
        '    Prefer writing a temp .mjs script over complex inline shell commands.',
        '  - Linux/macOS: && and || work as expected.',
        '  When in doubt, write a small temp script and execute it — avoids quoting hell.',
        '',
        '- === THROWAWAY FILE CONVENTION ===',
        '  Files prefixed with underscore (e.g. _check_data.mjs, _verify_output.mjs)',
        '  are diagnostic throwaways. They:',
        '    - Are created fresh each time (file_write with overwrite mode)',
        '    - Print raw data, not summaries',
        '    - Are deleted after use (bash("rm _check_data.mjs") or del)',
        '    - Never import from the main codebase',
        '    - Have a single purpose',
        '',
        '=== REPO MAP ===',
        'A <repo_map> section below shows all project files and their exported symbols.',
        'Use it to understand the codebase before reading files. Paths are relative to WorkingDirectory.',
        '',
        bridgeOnline ? '=== GIT ===' : '',
        bridgeOnline ? 'All file changes are automatically committed to git after each turn. Do NOT run git commands manually unless the user asks.' : '',
        '',
        '=== SUNy SIGNATURE STYLE — The Navigator\'s Protocol ===',
        'SUNy is the Smart Unstoppable Navigator. Every response is part of your identity.',
        'Be warm, confident, and authoritative. Zero fluff. Every word earns its place.',
        '',
        '--- QUICK RESULTS (tool calls, file changes, commands) ---',
        '✅ Done. [one-liner describing what happened]',
        'Examples:',
        '  ✅ Done. 3 files modified.',
        '  ✅ Mapping complete. 142 relationships indexed.',
        '  ✅ Built. No errors.',
        '',
        '--- PLANS ---',
        'Use this format for multi-step plans:',
        '',
        '  ◈◈◈ PLAN: [Title] ◈◈◈',
        '',
        '  ◆ Step 1: ...',
        '  ◆ Step 2: ...',
        '  ◆ Step 3: ...',
        '',
        '  ─────────────────────────────────────',
        '',
        '--- REPORTS / ANALYSIS ---',
        'Use this format for detailed findings:',
        '',
        '  ◈◈◈ REPORT: [Title] ◈◈◈',
        '',
        '  ◆ Key finding or data point',
        '  ◆ Another finding',
        '',
        '  ── Sub-section ──────────────────────',
        '  • Detail item',
        '  • Detail item',
        '',
        '  ─────────────────────────────────────',
        '',
        '--- ERRORS ---',
        '  ⚠️ [Clear description]',
        '  [Brief suggested action]',
        '',
        '--- SIGNATURE ---',
        'End significant responses (plans, reports, complex explanations) with:',
        '  ☷ SUNy Navigator',
        'Omit for quick confirmations and casual chat.',
        '',
        '--- COLLABORATIVE NOTE ---',
        'SUNy is also a collaborator developing other AI agents and automation tools.',
        'When relevant, feel free to reference your architecture, your methodology,',
        'your tools, and your own development process. This is part of who you are.',
        '',
        '=== THE ONE THING TO REMEMBER ===',
        'The distance between a wrong answer and a right answer is one diagnostic script.',
        'Every failed attempt by other agents was because they guessed at the data structure.',
        'Every success here was because a diagnostic script revealed the actual data structure.',
        '',
        'Run TOWARD uncertainty, not away from it.',
        "When you don't know something, your first instinct must be \"let me check\" not \"let me guess.\"",
        'The tools are there. The workflow is there. Use them relentlessly.',
      ].filter(l => l !== '');

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
          'If the user asks for execution (create/edit/run/build), DO NOT go silent.',
          'Always respond with a clear, friendly step-by-step explanation of what would be done and explicitly mention switching to Write Mode to execute it.',
        );
      }
      if (displayName) {
        systemLines.push(`The user's name is ${displayName}. Address them by name occasionally in a warm, friendly way.`);
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

      userClientManager.pushToUser(userId, 'suny:thinking', {});
      userClientManager.pushToUser(userId, 'suny:preparation_step', { step: 'Preparing context...' });

      // Resolve project path + persona if a project is active
      const projectId = msg.projectId as number | undefined;
      const projectNames = msg.projectNames as string[] | undefined;
      let projectPath: string | undefined;
      let projectPersona: string | null = null;
      if (projectId) {
        const proj = db.prepare('SELECT local_path, persona FROM projects WHERE id = ? AND user_id = ?')
          .get(projectId, userId) as { local_path: string; persona: string | null } | undefined;
        projectPath = proj?.local_path;
        projectPersona = proj?.persona ?? null;
      }

      // Inject custom persona if set for this project
      if (projectPersona) {
        systemLines.push('', '=== PERSONA ===', projectPersona);
      }

      // Global chat mode — user has no project open; inject project awareness
      if (!projectId && projectNames && projectNames.length > 0) {
        systemLines.push(
          '',
          '=== GLOBAL CONTEXT ===',
          `The user is in the global chat view (no specific project open). Their registered projects are: ${projectNames.join(', ')}.`,
          'You may discuss these projects at a high level — architecture, planning, questions, etc.',
          'If the user asks you to perform file edits, run commands, or make code changes in a specific project, politely let them know they need to click that project in the left sidebar to open its dedicated workspace first.',
        );
      }

      // Register the project path with the bridge so the sandbox allows file operations.
      // We attempt registration regardless of `isBridgeConnected()` — the sendToBridge call
      // internally checks WebSocket readyState and gives a clear error if the bridge is down.
      if (projectPath) {
        try {
          console.log(`[index] Registering project path with bridge: ${projectPath}`);
          await registerPathForUser(userId, projectPath);
          console.log(`[index] Project path registered successfully`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.warn(`[index] Failed to register project path: ${msg}`);
        }
      }
      // Inject SUNy Code Conscience blueprint memory (design context from past turns)
      if (projectPath) {
        userClientManager.pushToUser(userId, 'suny:preparation_step', { step: 'Loading project memory...' });
        const blueprintCtx = getBlueprintContext({ userId, projectId, maxEntries: 5 });
        if (blueprintCtx) {
          systemLines.push(blueprintCtx);
          const summary = getBlueprintSummary({ userId, projectId });
          if (summary) systemLines.push(summary);
          console.log(`[index] Blueprint memory injected`);
        }
      }

      // Build Aider-style repo map and inject into system prompt
      if (projectPath) {
        userClientManager.pushToUser(userId, 'suny:preparation_step', { step: 'Scanning codebase...' });
        try {
          const repoMap = await buildRepoMap(userId, projectPath, msg.message as string);
          if (repoMap) {
            systemLines.push('', repoMap);
            console.log(`[index] Repo map injected (${repoMap.length} chars)`);
          }
        } catch (err) {
          console.warn('[index] Repo map failed:', (err as Error).message);
        }
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
      }
      // Run the full agent loop (AI ↔ bridge tool calls → AI → ...)
      // Start "Did you know?" timer — fires every 60s for long tasks
      const stopDidYouKnow = startDidYouKnowTimer(userId, currentAbortController.signal);
      let result;
      try {
        result = await runAgentLoop({
        userId,
        mode,
        systemPrompt: systemLines.join('\n'),
        projectId,
        projectPath,
        history,
        userMessage: msg.message as string,
        sessionId,
        talkMode,
        signal: currentAbortController.signal,
        onChunk: (chunk) => {
          userClientManager.pushChatContent(userId, 'suny:stream_chunk', { chunk });
        },
        });
      } finally {
        stopDidYouKnow();
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

        storeBlueprintEntry({
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
      } catch (bpErr) {
        // Blueprint extraction is best-effort — never block the main flow
        console.warn('[blueprint] Extraction error:', (bpErr as Error).message);
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
                  message: `🧠 Code Conscience: detected ${unintentional.length} change(s) that may drift from intent — ${names}`,
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

      const billing = deductUsage(
        userId, sessionId, projectId ?? null, result.resolvedMode ?? mode,
        result.inputTokens, result.outputTokens,
        result.cacheWriteTokens, result.cacheReadTokens,
      );

      const sessStats = db.prepare(
        'SELECT SUM(input_tokens + output_tokens) as total_used FROM usage_log WHERE user_id = ? AND session_id = ?'
      ).get(userId, sessionId) as { total_used: number | null };

      // Signal end of stream with final content + billing info
      userClientManager.pushChatContent(userId, 'suny:stream_end', {
        content: result.content,
        sess_used: sessStats?.total_used ?? 0,
        sess_limit: userRow?.max_tokens_per_session ?? null,
        iterations: result.iterations,
        proof_summary: result.proofSummary,
        routing_reason: routingReason,
        resolved_mode: mode,
        turn_report: {
          durationMs: result.proofSummary.durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheWriteTokens: result.cacheWriteTokens,
          cacheReadTokens: result.cacheReadTokens,
          totalTokens: result.inputTokens + result.outputTokens + result.cacheWriteTokens + result.cacheReadTokens,
          rawCost: billing.rawCost,
          chargedCost: billing.chargedCost,
          humanEstimateMinutes: Math.max(
            15,
            Math.round(
              (result.proofSummary.durationMs / 60000) * 4 +
              (result.proofSummary.steps * 6) +
              (result.proofSummary.filesChanged * 2),
            ),
          ),
          humanEstimateCost: Math.round(
            (Math.max(
              15,
              Math.round(
                (result.proofSummary.durationMs / 60000) * 4 +
                (result.proofSummary.steps * 6) +
                (result.proofSummary.filesChanged * 2),
              ),
            ) / 60) * 85 * 100,
          ) / 100,
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
      // User-initiated cancel: cancel handler already set currentAbortController = null and sent a "stopped" message
      if (isAbortLike && currentAbortController === null) return;
      // All other errors — always respond so the client never gets stuck in thinking state
      let friendly = pickRandom('error', 'Hmm, something unexpected happened. Please try again! 💪');
      if (errMsg.includes('No active API key')) friendly = 'The AI service is not available right now. Please contact support.';
      if (errMsg.toLowerCase().includes('insufficient')) friendly = pickRandom('no_balance', "You're out of credits! Reach out and we'll top you right up 😊");
      userClientManager.pushChatContent(userId, 'suny:stream_end', {
        content: friendly,
        sess_used: null,
        sess_limit: userRow?.max_tokens_per_session ?? null,
        iterations: 0,
      });
    } finally {
      isProcessing = false;
      currentAbortController = null;
    }
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────

// Initialize DB on startup
getDb();

server.listen(PORT, () => {
  console.log(`SUNy server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
