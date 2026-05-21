import WebSocket from 'ws';
import { verifyToken, AuthPayload } from './auth';
import { narrateMessage } from './narrator';
import { userClientManager } from './user-client-manager';
import { getDb } from './db';

interface BridgeConnection {
  ws: WebSocket;
  userId: number;
  username: string;
  connectedAt: Date;
  lastPing: Date;
}

interface PendingRequest {
  userId: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

// Map: userId → active bridge connection
const activeBridges = new Map<number, BridgeConnection>();

// Map: pending request id → resolve/reject callbacks (with userId tracking)
const pendingRequests = new Map<string, PendingRequest>();

export function registerBridge(userId: number, username: string, ws: WebSocket): void {
  // Disconnect existing bridge for this user if any
  const existing = activeBridges.get(userId);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    existing.ws.send(JSON.stringify({ type: 'bridge:disconnect', reason: 'replaced_by_new_connection' }));
    existing.ws.close();
  }

  // Mark user as having ever connected a bridge
  try {
    getDb().prepare('UPDATE users SET bridge_ever_connected = 1 WHERE id = ?').run(userId);
  } catch { /* best-effort */ }

  console.log(`[bridge-manager] Bridge CONNECTED for user ${userId} (${username})`);
  const conn: BridgeConnection = { ws, userId, username, connectedAt: new Date(), lastPing: new Date() };
  activeBridges.set(userId, conn);

  ws.on('message', (raw) => handleBridgeMessage(userId, raw.toString()));
  ws.on('close', (code, reason) => {
    console.log(`[bridge-manager] Bridge DISCONNECTED for user ${userId} (code=${code}, reason=${reason?.toString() || 'none'})`);
    activeBridges.delete(userId);
    rejectAllPendingForUser(userId, 'Bridge disconnected');
  });
  ws.on('error', (err) => {
    console.log(`[bridge-manager] Bridge ERROR for user ${userId}: ${err.message}`);
    activeBridges.delete(userId);
    rejectAllPendingForUser(userId, 'Bridge error');
  });
}

function handleBridgeMessage(userId: number, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const { type, id } = msg as { type: string; id?: string };

  // Update last ping time
  const conn = activeBridges.get(userId);
  if (conn) conn.lastPing = new Date();

  if (!id) return;

  const pending = pendingRequests.get(id as string);
  // Only process if request belongs to this user
  if (!pending || pending.userId !== userId) return;

  if (type === 'bridge:done' || type === 'bridge:file_content' || type === 'bridge:ack') {
    clearTimeout(pending.timeout);
    pendingRequests.delete(id as string);
    pending.resolve(msg.payload ?? true);
  } else if (type === 'bridge:error') {
    clearTimeout(pending.timeout);
    pendingRequests.delete(id as string);
    const payload = msg.payload as { message?: string } | undefined;
    pending.reject(new Error(payload?.message || 'Bridge error'));
  }
  // bridge:stream messages are handled separately via event emitters (not implemented here — stub for now)
}

/**
 * Send an instruction to the user's bridge and await the response.
 */
export function sendToBridge(userId: number, type: string, payload: unknown, timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = activeBridges.get(userId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Bridge not connected'));
      return;
    }

    const id = generateId();
    const message = JSON.stringify({ type, id, payload });

    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Bridge request timed out'));
    }, timeoutMs);

    pendingRequests.set(id, { userId, resolve, reject, timeout });
    conn.ws.send(message);
  });
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
    // Not connected — remove stale entry if any
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
