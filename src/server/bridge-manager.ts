import WebSocket from 'ws';
import { verifyToken, AuthPayload } from './auth';
import { narrateMessage } from './narrator';
import { userClientManager } from './user-client-manager';
import { getAdapter } from './db';

interface BridgeConnection {
  ws: WebSocket;
  userId: number;
  username: string;
  connectedAt: Date;
  lastPing: Date;
  lastPong: Date;
  pingTimer?: NodeJS.Timeout;
  pongTimer?: NodeJS.Timeout;
}

interface PendingRequest {
  userId: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  // Stream accumulation for shell-style requests. `bridge:stream` lines are
  // appended here; `bridge:done` resolves with payload + output.
  streamLines: string[];
  // 'oneshot' resolves on bridge:done / bridge:file_content (file ops, exec:shell).
  // 'background' resolves on bridge:server_ready (process keeps running) and
  // the bridge request id is published as a background-process handle.
  mode: 'oneshot' | 'background';
}

interface BackgroundProcessRecord {
  userId: number;
  processId: string;       // bridge request id used as handle
  command: string;
  startedAt: Date;
  status: 'starting' | 'ready' | 'stopped' | 'crashed';
  logs: string[];          // rolling buffer (last N lines)
  exitCode?: number;
}

const MAX_BG_LOG_LINES = 500;
const MAX_BG_PROCESSES_PER_USER = 5;
const backgroundProcesses = new Map<string, BackgroundProcessRecord>();

const BRIDGE_PING_INTERVAL = 20_000;
const BRIDGE_PONG_TIMEOUT = 10_000;

interface QueuedRequest {
  type: string;
  payload: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeoutMs: number;
  attempts: number;
  enqueuedAt: number;
}

const replayQueue = new Map<number, QueuedRequest[]>();
const MAX_REPLAY_ATTEMPTS = 2;
const MAX_QUEUE_AGE_MS = 30_000;

// Map: userId → active bridge connection
const activeBridges = new Map<number, BridgeConnection>();

// Map: pending request id → resolve/reject callbacks (with userId tracking)
const pendingRequests = new Map<string, PendingRequest>();

export function registerBridge(userId: number, username: string, ws: WebSocket): void {
  // IMPORTANT: Disconnect existing bridge FIRST (before activeBridges.set).
  // Getting the existing after .set() would return the new connection instead.
  const existing = activeBridges.get(userId);
  if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
    existing.ws.send(JSON.stringify({ type: 'bridge:disconnect', payload: { reason: 'replaced_by_new_connection' } }));
    existing.ws.close();
  }

  // Set up the new bridge connection â€” handlers are attached synchronously
  // so they're ready before any async operation (e.g. DB write below).
  const conn: BridgeConnection = { ws, userId, username, connectedAt: new Date(), lastPing: new Date(), lastPong: new Date() };
  activeBridges.set(userId, conn);
  startBridgePingLoop(conn);

  ws.on('message', (raw) => handleBridgeMessage(userId, raw.toString()));
  ws.on('close', (code, reason) => {
    console.log(`[bridge-manager] Bridge DISCONNECTED for user ${userId} (code=${code}, reason=${reason?.toString() || 'none'})`);
    if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = undefined; }
    if (conn.pongTimer) { clearTimeout(conn.pongTimer); conn.pongTimer = undefined; }
    // Only clean up if this ws is still the active connection â€” prevents a
    // stale close handler from a replaced bridge from deleting the new bridge
    // AND from rejecting the new bridge's pending requests.
    const current = activeBridges.get(userId);
    if (current && current.ws === ws) {
      activeBridges.delete(userId);
      rejectAllPendingForUser(userId, 'Bridge disconnected');
    }
  });
  ws.on('error', (err) => {
    console.log(`[bridge-manager] Bridge ERROR for user ${userId}: ${err.message}`);
    if (conn.pingTimer) { clearInterval(conn.pingTimer); conn.pingTimer = undefined; }
    if (conn.pongTimer) { clearTimeout(conn.pongTimer); conn.pongTimer = undefined; }
    const current = activeBridges.get(userId);
    if (current && current.ws === ws) {
      activeBridges.delete(userId);
      rejectAllPendingForUser(userId, 'Bridge error');
    }
  });

  console.log(`[bridge-manager] Bridge CONNECTED for user ${userId} (${username})`);

  // Mark user as having ever connected a bridge (fire-and-forget)
  try { getAdapter().run('UPDATE users SET bridge_ever_connected = 1 WHERE id = ?', [userId]); } catch { /* best-effort */ }

  // Replay any queued requests that were buffered while this bridge was offline
  replayQueuedRequests(userId);
}

function startBridgePingLoop(conn: BridgeConnection): void {
  conn.pingTimer = setInterval(() => {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(JSON.stringify({ type: 'bridge:ping', ts: Date.now() }));
    conn.pongTimer = setTimeout(() => {
      const current = activeBridges.get(conn.userId);
      if (current && current.ws === conn.ws && current === conn) {
        console.warn(`[bridge-manager] Pong timeout for user ${conn.userId} — forcing reconnect`);
        conn.ws.terminate();
      }
    }, BRIDGE_PONG_TIMEOUT);
  }, BRIDGE_PING_INTERVAL);
}

function handleBridgeMessage(userId: number, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const { type, id } = msg as { type: string; id?: string };

  const conn = activeBridges.get(userId);

  // Handle pong from bridge (bidirectional heartbeat acknowledgment)
  if (type === 'bridge:pong') {
    if (conn) {
      conn.lastPong = new Date();
      if (conn.pongTimer) { clearTimeout(conn.pongTimer); conn.pongTimer = undefined; }
    }
    return;
  }

  // Update last ping time on any message
  if (conn) conn.lastPing = new Date();

  if (!id) return;

  const pending = pendingRequests.get(id as string);
  // Only process if request belongs to this user
  if (pending && pending.userId !== userId) return;

  // bridge:stream â€” append to pending request buffer AND background-process log buffer.
  if (type === 'bridge:stream') {
    const payload = msg.payload as { line?: string; stream?: string } | undefined;
    const line = payload?.line;
    if (typeof line === 'string') {
      if (pending) {
        pending.streamLines.push(line);
        // Cap buffer to avoid runaway memory on chatty processes.
        if (pending.streamLines.length > 2000) pending.streamLines.splice(0, pending.streamLines.length - 2000);
      }
      const bg = backgroundProcesses.get(id as string);
      if (bg) {
        bg.logs.push(line);
        if (bg.logs.length > MAX_BG_LOG_LINES) bg.logs.splice(0, bg.logs.length - MAX_BG_LOG_LINES);
      }
    }
    return;
  }

  // bridge:ack â€” request received. Do NOT resolve; just confirm we got it.
  if (type === 'bridge:ack') {
    return;
  }

  // bridge:server_ready â€” background mode: resolve early with collected logs.
  if (type === 'bridge:server_ready') {
    const bg = backgroundProcesses.get(id as string);
    if (bg) bg.status = 'ready';
    if (pending && pending.mode === 'background') {
      clearTimeout(pending.timeout);
      pendingRequests.delete(id as string);
      pending.resolve({
        processId: id,
        status: 'ready',
        output: pending.streamLines.join('\n'),
      });
    }
    return;
  }

  // bridge:server_crashed â€” background mode: reject; one-shot ignored (done arrives separately).
  if (type === 'bridge:server_crashed') {
    const bg = backgroundProcesses.get(id as string);
    if (bg) bg.status = 'crashed';
    if (pending && pending.mode === 'background') {
      clearTimeout(pending.timeout);
      pendingRequests.delete(id as string);
      const payload = msg.payload as { error?: string } | undefined;
      pending.reject(new Error(payload?.error || 'Server crashed during startup'));
    }
    return;
  }

  if (!pending) return;

  if (type === 'bridge:done') {
    clearTimeout(pending.timeout);
    pendingRequests.delete(id as string);
    // Mark background record as stopped (process exited) and store exit code.
    const bg = backgroundProcesses.get(id as string);
    if (bg) {
      const p = msg.payload as { exitCode?: number } | undefined;
      bg.status = 'stopped';
      bg.exitCode = p?.exitCode;
    }
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    pending.resolve({ ...payload, output: pending.streamLines.join('\n') });
    return;
  }

  if (type === 'bridge:file_content') {
    clearTimeout(pending.timeout);
    pendingRequests.delete(id as string);
    pending.resolve(msg.payload ?? true);
    return;
  }

  if (type === 'bridge:error') {
    clearTimeout(pending.timeout);
    pendingRequests.delete(id as string);
    const payload = msg.payload as { message?: string } | undefined;
    pending.reject(new Error(payload?.message || 'Bridge error'));
    return;
  }
}

/**
 * Send an instruction to the user's bridge and await the response.
 * For one-shot operations (file ops, bash) â€” resolves on bridge:done with
 * accumulated stream output included in the payload.
 */
export function sendToBridge(
  userId: number,
  type: string,
  payload: unknown,
  timeoutMs = 30000,
  _attempt = 0,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = activeBridges.get(userId);

    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      if (_attempt < MAX_REPLAY_ATTEMPTS && timeoutMs <= 60000) {
        const queue = replayQueue.get(userId) || [];
        queue.push({ type, payload, resolve, reject, timeoutMs, attempts: _attempt, enqueuedAt: Date.now() });
        replayQueue.set(userId, queue);
        return;
      }
      reject(new Error('Bridge not connected'));
      return;
    }

    const id = generateId();
    const message = JSON.stringify({ type, id, payload });

    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Bridge request timed out'));
    }, timeoutMs);

    pendingRequests.set(id, { userId, resolve, reject, timeout, streamLines: [], mode: 'oneshot' });
    conn.ws.send(message);
  });
}

/**
 * Start a long-running process on the bridge. Resolves early on
 * `bridge:server_ready` (or when the ready signal is matched). The process
 * keeps running until killed via stopBackgroundProcess. Returns a handle
 * { processId, status, output } that the agent can use to tail logs or stop.
 */
export function sendToBridgeBackground(
  userId: number,
  command: string,
  cwd: string,
  readySignal?: string,
  timeoutSeconds = 30,
): Promise<{ processId: string; status: string; output: string }> {
  return new Promise((resolve, reject) => {
    const conn = activeBridges.get(userId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Bridge not connected'));
      return;
    }

    // Enforce per-user cap on simultaneous background processes to prevent a
    // runaway agent from spawning many servers.
    const liveCount = Array.from(backgroundProcesses.values()).filter(
      p => p.userId === userId && (p.status === 'starting' || p.status === 'ready'),
    ).length;
    if (liveCount >= MAX_BG_PROCESSES_PER_USER) {
      reject(new Error(
        `Too many background processes (${liveCount}/${MAX_BG_PROCESSES_PER_USER}). ` +
        `Stop one with stop_server before starting another (use list_servers to see them).`,
      ));
      return;
    }

    const id = generateId();

    // Register the background-process record up front so stream lines are
    // captured into its rolling buffer immediately (not just into pending).
    backgroundProcesses.set(id, {
      userId,
      processId: id,
      command,
      startedAt: new Date(),
      status: 'starting',
      logs: [],
    });

    const timeout = setTimeout(() => {
      // Timeout: assume "started but no ready signal yet" â€” resolve with what we have.
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        const bg = backgroundProcesses.get(id);
        resolve({
          processId: id,
          status: bg?.status ?? 'starting',
          output: (bg?.logs ?? pending.streamLines).join('\n'),
        });
      }
    }, timeoutSeconds * 1000);

    pendingRequests.set(id, {
      userId,
      resolve: (val) => resolve(val as { processId: string; status: string; output: string }),
      reject,
      timeout,
      streamLines: [],
      mode: 'background',
    });

    const message = JSON.stringify({
      type: 'exec:start_dev_server',
      id,
      payload: { cwd, command, readySignal: readySignal || 'Local:', timeoutSeconds },
    });
    conn.ws.send(message);
  });
}

/**
 * Stop a running background process started via sendToBridgeBackground.
 */
export function stopBackgroundProcess(userId: number, processId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = activeBridges.get(userId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }
    const bg = backgroundProcesses.get(processId);
    if (!bg || bg.userId !== userId) {
      resolve(false);
      return;
    }
    conn.ws.send(JSON.stringify({ type: 'exec:kill', id: generateId(), payload: { processId } }));
    bg.status = 'stopped';
    resolve(true);
  });
}

/**
 * Read the rolling log buffer of a background process. `lines` returns the
 * last N lines (default 100). Does not consume â€” buffer remains intact.
 */
export function readBackgroundLogs(
  userId: number,
  processId: string,
  lines = 100,
): { found: boolean; status?: string; logs: string; exitCode?: number; command?: string } {
  const bg = backgroundProcesses.get(processId);
  if (!bg || bg.userId !== userId) return { found: false, logs: '' };
  const tail = bg.logs.slice(-lines).join('\n');
  return { found: true, status: bg.status, logs: tail, exitCode: bg.exitCode, command: bg.command };
}

/**
 * List background processes for a user (debugging / agent introspection).
 */
export function listBackgroundProcesses(userId: number): Array<{ processId: string; status: string; command: string; startedAt: string }> {
  const out: Array<{ processId: string; status: string; command: string; startedAt: string }> = [];
  for (const bg of backgroundProcesses.values()) {
    if (bg.userId !== userId) continue;
    out.push({ processId: bg.processId, status: bg.status, command: bg.command, startedAt: bg.startedAt.toISOString() });
  }
  return out;
}

export function isBridgeConnected(userId: number): boolean {
  const conn = activeBridges.get(userId);
  if (!conn) return false;
  if (conn.ws.readyState !== WebSocket.OPEN) return false;
  // Consider stale if no ping in 60 seconds (heartbeat interval is 30s, giving 2x buffer)
  const age = Date.now() - conn.lastPing.getTime();
  return age < 60000;
}

function rejectAllPendingForUser(userId: number, reason: string): void {
  for (const [id, pending] of pendingRequests.entries()) {
    if (pending.userId !== userId) continue;
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
    pendingRequests.delete(id);
  }
}

function replayQueuedRequests(userId: number): void {
  const queue = replayQueue.get(userId) || [];
  if (queue.length === 0) return;

  replayQueue.delete(userId);
  const now = Date.now();

  for (const req of queue) {
    if (now - req.enqueuedAt > MAX_QUEUE_AGE_MS) {
      req.reject(new Error('Bridge reconnected but request expired'));
      continue;
    }
    sendToBridge(userId, req.type, req.payload, req.timeoutMs, req.attempts + 1)
      .then(req.resolve)
      .catch(req.reject);
  }
}

export function authenticateBridgeToken(token: string): AuthPayload | null {
  return verifyToken(token);
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Send a bridge instruction with a friendly narrator message sent to the user first.
 */
export function sendToBridgeWithNarration(
  userId: number,
  type: string,
  payload: unknown,
  narratorType: 'file_edit' | 'search' | 'command' | 'test_running' | 'test_fixing' | 'plan' | 'server_starting',
  narratorContext?: Record<string, unknown>,
  timeoutMs = 30000
): Promise<unknown> {
  const friendly = narrateMessage('', narratorType, narratorContext);
  userClientManager.pushNarration(userId, friendly);
  return sendToBridge(userId, type, payload, timeoutMs);
}

/**
 * Register a project directory path with the user's bridge.
 * This tells the bridge's sandbox to allow file operations within this path.
 */
export function registerPathForUser(userId: number, projectPath: string): Promise<unknown> {
  return sendToBridge(userId, 'bridge:register_path', { path: projectPath }, 5000);
}

/**
 * Kill an active bridge request by its request id.
 * Returns true if the request was found and killed.
 */
/**
 * Gracefully disconnect a user's bridge and tell it to stop reconnecting.
 * Returns true if a bridge was actually disconnected.
 */
export function disconnectBridge(userId: number): boolean {
  const conn = activeBridges.get(userId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    // Not connected â€” remove stale entry if any
    if (conn) activeBridges.delete(userId);
    return false;
  }

  // Tell the bridge to stop (sets this.stopped = true so it won't reconnect)
  conn.ws.send(JSON.stringify({ type: 'bridge:disconnect', payload: { reason: 'user_disconnected' } }));
  conn.ws.close(1000, 'User requested disconnect');
  activeBridges.delete(userId);
  rejectAllPendingForUser(userId, 'Bridge disconnected by user');
  return true;
}

export function killBridgeRequest(userId: number, requestId: string): boolean {
  const pending = pendingRequests.get(requestId);
  if (!pending || pending.userId !== userId) return false;
  clearTimeout(pending.timeout);
  pending.reject(new Error('Request cancelled by user'));
  pendingRequests.delete(requestId);
  // Also tell the bridge to kill any running process for this request
  const conn = activeBridges.get(userId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify({ type: 'exec:kill', id: generateId(), payload: { processId: requestId } }));
  }
  return true;
}
