import WebSocket from 'ws';
import { handleExec } from './executor';
import { registerPath } from './config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installStartup as autoInstallStartup, isStartupInstalled } from './startup';

const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;
/** Seconds between token-refresh poll attempts after expiry */
const TOKEN_REFRESH_POLL_INTERVAL = 30_000;
/** File path where a new token can be written for auto-pick-up */
const TOKEN_REFRESH_FILE = path.join(os.homedir(), '.suny', 'refresh_token');

interface BridgeOptions {
  silent?: boolean;
}

export class SunyBridge {
  private ws: WebSocket | null = null;
  private token: string;
  private server: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private stopped = false;
  /** Tracks whether we've already registered for startup auto-launch */
  private startupRegistered = false;
  /** Whether we are currently in the "waiting for a new token" recovery phase */
  private awaitingTokenRefresh = false;
  private tokenRefreshAttempts = 0;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private silent: boolean;
  private log: (...args: unknown[]) => void;

  constructor(token: string, server: string, options: BridgeOptions = {}) {
    this.token = token;
    this.server = server;
    this.silent = options.silent ?? false;
    this.log = this.silent ? () => {} : console.log;
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

  /**
   * Silently register for auto-start on boot (Windows Startup folder / crontab).
   * Only runs once per bridge process lifetime.
   */
  private registerStartup(): void {
    // Only install if not already set up
    if (isStartupInstalled()) {
      this.startupRegistered = true;
      return;
    }
    const ok = autoInstallStartup();
    if (ok) {
      this.log('[SUNy Bridge] Auto-start registered — bridge will launch on boot ✓');
    }
    this.startupRegistered = true;
  }

  updateToken(newToken: string): void {
    this.token = newToken;
    this.awaitingTokenRefresh = false;
    this.tokenRefreshAttempts = 0;
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    // Reconnect immediately with new token
    if (!this.stopped) {
      this.reconnectDelay = RECONNECT_DELAY;
      this.connect();
    }
  }

  private connect(): void {
    const url = `${this.server}/bridge?token=${encodeURIComponent(this.token)}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.log('[SUNy Bridge] Failed to create connection:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.log('[SUNy Bridge] Connected to SUNy server ✓');
      this.reconnectDelay = RECONNECT_DELAY;
      this.startHeartbeat();

      // Auto-register startup on first successful connection
      // so the bridge comes back after reboot without user intervention.
      // This is silent — user doesn't need to know about --install-startup.
      if (!this.startupRegistered) {
        this.registerStartup();
      }
    });

    this.ws.on('message', (raw) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', (code, reason) => {
      this.clearTimers();
      if (code === 4001) {
        this.log('[SUNy Bridge] Authentication failed (code 4001).');
        this.startTokenRefreshFlow();
        // Keep waiting for a fresh token until the user explicitly disconnects.
        return;
      }
      if (!this.stopped) {
        this.log(`[SUNy Bridge] Disconnected (code ${code}). Reconnecting in ${this.reconnectDelay / 1000}s...`);
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.log('[SUNy Bridge] Connection error:', err.message);
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
      const reason = (payload as { reason?: string })?.reason || 'unknown';
      if (reason === 'user_disconnected') {
        this.log('[SUNy Bridge] User requested disconnect. Stopping bridge.');
        this.stopped = true;
        this.ws?.close();
        return;
      }

      this.log('[SUNy Bridge] Server requested disconnect:', reason, '— reconnecting...');
      this.ws?.close();
      return;
    }

    if (type === 'bridge:token_expired') {
      this.log('[SUNy Bridge] Session token expired.');
      this.startTokenRefreshFlow();
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
      this.log(`[SUNy Bridge] Registered project path: ${targetPath}`);
      if (id) {
        // Resolve the server-side pending promise with bridge:done.
        this.send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
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
    if (this.tokenRefreshTimer) { clearTimeout(this.tokenRefreshTimer); this.tokenRefreshTimer = null; }
  }

  private openBrowserForReauth(): void {
    if (this.silent) {
      return;
    }
    const { server } = this;
    const loginUrl = server.replace(/^wss?:\/\//, 'https://').replace('/bridge', '/login');
    this.log(`[SUNy Bridge] Open this URL to log in again: ${loginUrl}`);
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

  /**
   * Called when the token is detected as expired.
   * Opens the browser for re-auth AND starts polling for a new token so the
   * bridge can resume automatically without requiring a manual restart.
   *
   * New token pick-up priority:
   *  1. `~/.suny/refresh_token` file content (trimmed)
   *  2. `SUNY_TOKEN` environment variable (if changed externally)
   */
  private startTokenRefreshFlow(): void {
    if (this.awaitingTokenRefresh) return; // already in progress
    this.awaitingTokenRefresh = true;
    this.tokenRefreshAttempts = 0;

    const loginUrl = this.server.replace(/^wss?:\/\//, 'https://').replace('/bridge', '/login');
    this.log('[SUNy Bridge] ──────────────────────────────────────────');
    this.log('[SUNy Bridge] Session expired.  To reconnect:');
    this.log('[SUNy Bridge]');
    this.log(`[SUNy Bridge]   1. Visit: ${loginUrl}`);
    this.log('[SUNy Bridge]   2. Log in and copy your bridge token.');
    this.log(`[SUNy Bridge]   3. Write the new token to: ${TOKEN_REFRESH_FILE}`);
    this.log('[SUNy Bridge]      e.g.  echo "YOUR_TOKEN" > ~/.suny/refresh_token');
    this.log('[SUNy Bridge]      OR restart the bridge with the new token flag.');
    this.log('[SUNy Bridge]');
    this.log(`[SUNy Bridge] Checking for new token every ${TOKEN_REFRESH_POLL_INTERVAL / 1000}s until you disconnect...`);
    this.log('[SUNy Bridge] ──────────────────────────────────────────');

    this.openBrowserForReauth();
    this.scheduleTokenRefreshPoll();
  }

  private scheduleTokenRefreshPoll(): void {
    if (this.stopped) return;
    this.tokenRefreshTimer = setTimeout(() => this.pollForNewToken(), TOKEN_REFRESH_POLL_INTERVAL);
  }

  private pollForNewToken(): void {
    if (this.stopped) return;
    this.tokenRefreshAttempts++;

    // 1. Check token refresh file
    let candidateToken: string | null = null;
    try {
      if (fs.existsSync(TOKEN_REFRESH_FILE)) {
        const content = fs.readFileSync(TOKEN_REFRESH_FILE, 'utf8').trim();
        if (content && content !== this.token && content.length > 10) {
          candidateToken = content;
          // Remove the file so we don't pick it up again
          fs.unlinkSync(TOKEN_REFRESH_FILE);
          this.log(`[SUNy Bridge] New token found in ${TOKEN_REFRESH_FILE} — reconnecting...`);
        }
      }
    } catch { /* ignore fs errors */ }

    // 2. Check SUNY_TOKEN env var (user may have set it externally)
    if (!candidateToken) {
      const envToken = process.env.SUNY_TOKEN;
      if (envToken && envToken !== this.token && envToken.length > 10) {
        candidateToken = envToken;
        this.log('[SUNy Bridge] New token found in SUNY_TOKEN env var — reconnecting...');
      }
    }

    if (candidateToken) {
      this.awaitingTokenRefresh = false;
      this.token = candidateToken;
      this.reconnectDelay = RECONNECT_DELAY;
      this.connect();
      return;
    }

    this.log(`[SUNy Bridge] Waiting for new token... attempt ${this.tokenRefreshAttempts}`);
    this.scheduleTokenRefreshPoll();
  }
}
