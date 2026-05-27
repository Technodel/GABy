import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { authenticateBridgeToken, registerBridge, registerPathForUser } from './bridge-manager';
import { userClientManager } from './user-client-manager';
import { getDb } from './db';

/**
 * Attach the /bridge WebSocket endpoint to an HTTP server.
 * Handles JWT auth handshake and hands off to bridge-manager.
 */
export function attachBridgeWebSocket(wss: WebSocketServer): void {
  // This is invoked per-connection by the main server
}

export function handleBridgeUpgrade(ws: WebSocket, req: IncomingMessage): void {
  // Extract token from: (1) Sec-WebSocket-Protocol subprotocol, (2) Authorization header.
  // Query-string token fallback removed — JWTs in URLs leak into proxy/nginx logs.
  const protocol = req.headers['sec-websocket-protocol'] as string | undefined;
  const token = protocol?.split(',').map(s => s.trim()).filter(Boolean)[0]
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

  if (!token) {
    ws.close(4001, 'Missing authentication token');
    return;
  }

  const payload = authenticateBridgeToken(token);
  if (!payload || payload.role !== 'user') {
    ws.close(4001, 'Invalid or expired token');
    return;
  }

  const userId = payload.id as number;

  // Register and track this bridge connection
  registerBridge(userId, payload.username, ws);

  // Acknowledge successful connection
  ws.send(JSON.stringify({ type: 'bridge:authenticated', userId, username: payload.username }));

  // Notify user's browser tab that bridge is now connected
  userClientManager.pushToUser(userId, 'bridge:connected', { connected: true });

  // Send all of this user's project paths to the bridge so the sandbox
  // allows file operations immediately â€” even if the paths were registered
  // while the bridge was offline and never reached the bridge process.
  // Fired asynchronously so the handshake isn't blocked.
  (async () => {
    try {
      const db = getDb();
      const projects = db.prepare(
        'SELECT local_path FROM projects WHERE user_id = ?'
      ).all(userId) as Array<{ local_path: string }>;

      let registered = 0;
      let failed = 0;
      for (const proj of projects) {
        if (proj.local_path) {
          try {
            await registerPathForUser(userId, proj.local_path);
            registered++;
          } catch (err) {
            failed++;
            // Older bridges acknowledged with `bridge:ack` only, causing this
            // call to time out even though the path was registered on the
            // bridge side. Log at debug-level only â€” the agent will retry
            // path registration before each shell op anyway.
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('timed out')) {
              console.warn(`[bridge-routes] Failed to register path "${proj.local_path}" for user ${userId}: ${msg}`);
            }
          }
        }
      }

      if (projects.length > 0) {
        console.log(`[bridge-routes] Path registration for user ${userId} on connect: ${registered} registered, ${failed} failed (${projects.length} total projects)`);
      }
    } catch (err) {
      console.warn(`[bridge-routes] Failed to send project paths on bridge connect: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
