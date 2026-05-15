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

const PORT = parseInt(process.env.GABY_PORT || '3000', 10);
const ALLOWED_ORIGIN = process.env.GABY_ALLOWED_ORIGIN || 'http://localhost:5173';

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
    req.headers.cookie?.split(';').find(c => c.trim().startsWith('gaby_token='))?.split('=')[1];

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
  ws.send(JSON.stringify({ event: 'connected', message: 'GABy is ready!' }));

  // ── Track active requests for cancellation ──────────────────────────────
  let currentAbortController: AbortController | null = null;
  let isProcessing = false;

  ws.on('message', async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Handle cancel request
    if (msg.type === 'chat:cancel') {
      if (currentAbortController) {
        currentAbortController.abort(new Error('Request cancelled by user'));
        currentAbortController = null;
        isProcessing = false;
        userClientManager.pushToUser(userId, 'gaby:narration', { message: pickRandom('cancel', "Got it — I've stopped! What's next? 😊") });
        // Also tell the bridge to kill any running process
        const { killBridgeRequest } = require('./bridge-manager');
        killBridgeRequest(userId, (msg.requestId as string) || '');
      }
      return;
    }

    if (msg.type !== 'chat:message') return;
    if (isProcessing) {
      userClientManager.pushToUser(userId, 'gaby:narration', { message: pickRandom('busy', "I'm still working on your last message — hang tight! 😊") });
      return;
    }

    isProcessing = true;
    currentAbortController = new AbortController();
    try {
      if (!hasSufficientBalance(userId)) {
        userClientManager.pushToUser(userId, 'gaby:narration', { message: pickRandom('no_balance', "Looks like you're out of credits! Reach out and we'll top you right up 😊") });
        return;
      }

      const db = getDb();
      const userRow = db.prepare('SELECT selected_mode, max_tokens_per_session, display_name FROM users WHERE id = ?')
        .get(userId) as { selected_mode: string; max_tokens_per_session: number | null; display_name: string | null } | undefined;

      const mode = (msg.mode as string) || userRow?.selected_mode || 'fast';
      const sessionId = (msg.sessionId as string) || `ws_${userId}`;
      const history = (msg.history as AgentMessage[]) || [];
      const displayName = userRow?.display_name;

      // ── Session-level token cap ──────────────────────────────────────
      if (userRow?.max_tokens_per_session && userRow.max_tokens_per_session > 0) {
        const sessStats = db.prepare(
          'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used FROM usage_log WHERE user_id = ? AND session_id = ?'
        ).get(userId, sessionId) as { total_used: number };
        const remaining = userRow.max_tokens_per_session - sessStats.total_used;
        if (remaining <= 0) {
          userClientManager.pushToUser(userId, 'gaby:narration', {
            message: pickRandom('session_limit', "You've reached the session token limit. Start a new session to continue! 😊"),
          });
          return;
        }
      }

      const bridgeOnline = isBridgeConnected(userId);

      const systemLines = [
        'You are GABy — an expert AI coding agent.',
        bridgeOnline
          ? 'You have native tools to read, write, and edit files, run shell commands, search code, list directories, and more.'
          : 'The user\'s local bridge is currently offline, so file/shell tools are unavailable. You can still reason, review code snippets the user pastes, answer questions, explain concepts, and help plan solutions.',
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
        '=== REPO MAP ===',
        'A <repo_map> section below shows all project files and their exported symbols.',
        'Use it to understand the codebase before reading files. Paths are relative to WorkingDirectory.',
        '',
        bridgeOnline ? '=== GIT ===' : '',
        bridgeOnline ? 'All file changes are automatically committed to git after each turn. Do NOT run git commands manually unless the user asks.' : '',
        '',
        '=== RESPONSE STYLE ===',
        '- Be concise and action-oriented. One sentence between tool calls is enough.',
        '- NEVER fabricate file contents. NEVER claim to have made a change without calling a tool.',
        '- NEVER ask for permission. Just do it.',
        '- Respond warmly but professionally.',
      ].filter(l => l !== '');
      if (displayName) {
        systemLines.push(`The user's name is ${displayName}. Address them by name occasionally in a warm, friendly way.`);
      }

      userClientManager.pushToUser(userId, 'gaby:thinking', {});

      // Resolve project path + persona if a project is active
      const projectId = msg.projectId as number | undefined;
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
      // Build Aider-style repo map and inject into system prompt
      if (projectPath) {
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

      // Inject per-project .gaby-rules if present
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
        talkMode: msg.talkMode === true,
        signal: currentAbortController.signal,
        onChunk: (chunk) => {
          userClientManager.pushToUser(userId, 'gaby:stream_chunk', { chunk });
        },
        });
      } finally {
        stopDidYouKnow();
      }

      const billing = deductUsage(
        userId, sessionId, result.resolvedMode ?? mode,
        result.inputTokens, result.outputTokens,
        result.cacheWriteTokens, result.cacheReadTokens,
      );

      const sessStats = db.prepare(
        'SELECT SUM(input_tokens + output_tokens) as total_used FROM usage_log WHERE user_id = ? AND session_id = ?'
      ).get(userId, sessionId) as { total_used: number | null };

      // Signal end of stream with final content + billing info
      userClientManager.pushToUser(userId, 'gaby:stream_end', {
        content: result.content,
        sess_used: sessStats?.total_used ?? 0,
        sess_limit: userRow?.max_tokens_per_session ?? null,
        iterations: result.iterations,
      });
      userClientManager.pushToUser(userId, 'gaby:balance', {
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
      userClientManager.pushToUser(userId, 'gaby:narration', { message: friendly });
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
  console.log(`GABy server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
