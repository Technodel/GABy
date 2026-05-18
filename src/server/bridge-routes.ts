import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { authenticateBridgeToken, registerBridge, isBridgeConnected } from './bridge-manager';
import { userClientManager } from './user-client-manager';

/**
 * Attach the /bridge WebSocket endpoint to an HTTP server.
 * Handles JWT auth handshake and hands off to bridge-manager.
 */
export function attachBridgeWebSocket(wss: WebSocketServer): void {
  // This is invoked per-connection by the main server
}

export function handleBridgeUpgrade(ws: WebSocket, req: IncomingMessage): void {
  // Extract token from: (1) Sec-WebSocket-Protocol subprotocol, (2) Authorization header, (3) query string (legacy)
  const url = new URL(req.url || '', 'http://localhost');
  const protocol = req.headers['sec-websocket-protocol'] as string | undefined;
  const token = protocol?.split(',').map(s => s.trim()).filter(Boolean)[0]
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)
    || url.searchParams.get('token');

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
}
