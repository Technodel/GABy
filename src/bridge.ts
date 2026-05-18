import WebSocket from 'ws';
import { handleExec } from './executor';
import { registerPath } from './config';

const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;

export class GabyBridge {
  private ws: WebSocket | null = null;
  private token: string;
  private server: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private stopped = false;

  constructor(token: string, server: string) {
    this.token = token;
    this.server = server;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    const url = `${this.server}/bridge`;

    try {
      this.ws = new WebSocket(url, [this.token]);
    } catch (err) {
      console.error('[GABy Bridge] Failed to create connection:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[GABy Bridge] Connected to GABy server ✓');
      this.reconnectDelay = RECONNECT_DELAY;
      this.startHeartbeat();
    });

    this.ws.on('message', (raw) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', (code, reason) => {
      this.clearTimers();
      if (code === 4001) {
        console.error('[GABy Bridge] Authentication failed. Please check your token.');
        if (reason.toString().includes('expired')) {
          this.openBrowserForReauth();
        }
        // Don't reconnect on auth failure
        return;
      }
      if (!this.stopped) {
        console.log(`[GABy Bridge] Disconnected (code ${code}). Reconnecting in ${this.reconnectDelay / 1000}s...`);
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[GABy Bridge] Connection error:', err.message);
    });
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, id, payload } = msg as {
      type: string;
      id?: string;
      payload?: Record<string, unknown>;
    };

    if (type === 'bridge:disconnect') {
      console.log('[GABy Bridge] Server requested disconnect:', (payload as { reason?: string })?.reason);
      this.stopped = true;
      this.ws?.close();
      return;
    }

    if (type === 'bridge:token_expired') {
      console.log('[GABy Bridge] Session expired. Please log in again.');
      this.openBrowserForReauth();
      return;
    }

    if (type === 'bridge:ping') {
      this.send({ type: 'bridge:pong' });
      return;
    }

    // Register a project directory path so the sandbox allows file operations
    if (type === 'bridge:register_path' && payload?.path) {
      const targetPath = payload.path as string;
      registerPath(targetPath);
      console.log(`[GABy Bridge] Registered project path: ${targetPath}`);
      if (id) {
        this.send({ type: 'bridge:ack', id, payload: { success: true } });
      }
      return;
    }

    if (type?.startsWith('exec:') && id) {
      handleExec(type, id, (payload || {}) as Record<string, unknown>, (msg) => this.send(msg));
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'bridge:ping' });
    }, HEARTBEAT_INTERVAL);
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, this.reconnectDelay);
    // Exponential backoff with cap
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private openBrowserForReauth(): void {
    const { server } = this;
    const loginUrl = server.replace(/^wss?:\/\//, 'https://').replace('/bridge', '/login');
    console.log(`[GABy Bridge] Open this URL to log in again: ${loginUrl}`);
    // Try to open browser
    try {
      const { exec } = require('child_process');
      const cmd = process.platform === 'win32' ? `start "" "${loginUrl}"` :
        process.platform === 'darwin' ? `open "${loginUrl}"` : `xdg-open "${loginUrl}"`;
      exec(cmd);
    } catch {
      // ignore if browser open fails
    }
  }
}
