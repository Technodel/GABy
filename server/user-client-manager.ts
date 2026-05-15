import WebSocket from 'ws';
import { buildUserEvent } from './sanitizer';

/**
 * Manages WebSocket connections from user browser tabs.
 * Separate from bridge-manager (which tracks local agent bridges).
 *
 * One active connection per user (latest-wins). This prevents duplicate
 * message delivery caused by React StrictMode double-mounting effects.
 */
class UserClientManager {
  private clients = new Map<number, WebSocket>();

  register(userId: number, ws: WebSocket): void {
    // Close the previous connection if any (handles StrictMode double-connect)
    const existing = this.clients.get(userId);
    if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
      existing.close(1000, 'replaced_by_new_connection');
    }
    this.clients.set(userId, ws);

    ws.on('close', () => {
      if (this.clients.get(userId) === ws) this.clients.delete(userId);
    });
    ws.on('error', () => {
      if (this.clients.get(userId) === ws) this.clients.delete(userId);
    });
  }

  /**
   * Push a sanitized event to the user's active browser tab.
   * Payload passes through the Information Firewall automatically.
   */
  pushToUser(userId: number, event: string, payload: Record<string, unknown>): void {
    const ws = this.clients.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(buildUserEvent(event, payload));
  }

  /**
   * Push a balance update to the user — sends ONLY the new balance total.
   * No cost breakdown, no token counts.
   */
  pushBalance(userId: number, balance: number): void {
    this.pushToUser(userId, 'gaby:balance', { balance });
  }

  /**
   * Push a narrated message to the user's chat window.
   */
  pushNarration(userId: number, message: string): void {
    this.pushToUser(userId, 'gaby:narration', { message });
  }
}

export const userClientManager = new UserClientManager();
