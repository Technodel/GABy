import WebSocket from 'ws';
import { handleExec } from './executor';
import { handleBrowser } from './browser';
import { registerPath, updateConfig } from './config';
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
  /** Whether this is the first successful connection (for first-time setup msg) */
  private isFirstConnection = true;
  /** Whether we are currently in the "waiting for a new token" recovery phase */
  private awaitingTokenRefresh = false;
  private tokenRefreshAttempts = 0;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private silent: boolean;
  private log: (...args: unknown[]) => void;
  private refreshToken: string | null = null;
  private tokenRefreshScheduled = false;

  constructor(token: string, server: string, options: BridgeOptions = {}) {
    this.token = token;
    this.server = server;
    this.silent = options.silent ?? false;
    this.log = this.silent ? () => {} : console.log;
    this.refreshToken = this.loadRefreshToken();
  }

  setRefreshToken(rt: string): void {
    this.refreshToken = rt;
    const rtFile = path.join(os.homedir(), '.suny', 'refresh_token.json');
    try {
      fs.mkdirSync(path.dirname(rtFile), { recursive: true });
      fs.writeFileSync(rtFile, JSON.stringify({ refreshToken: rt }), 'utf8');
    } catch { /* best-effort */ }
  }

  loadRefreshToken(): string | null {
    try {
      const rtFile = path.join(os.homedir(), '.suny', 'refresh_token.json');
      if (fs.existsSync(rtFile)) {
        const data = JSON.parse(fs.readFileSync(rtFile, 'utf8'));
        return data.refreshToken || null;
      }
    } catch { /* ignore */ }
    return null;
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

  private scheduleProactiveTokenRefresh(): void {
    if (this.tokenRefreshScheduled) return;
    try {
      const parts = this.token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const expiresAt = payload.exp * 1000;
      const refreshAt = expiresAt - (2 * 24 * 60 * 60 * 1000);
      let delay = Math.max(0, refreshAt - Date.now());
      // Cap to max safe 32-bit signed integer (~24.8 days) to avoid TimeoutOverflowWarning
      const MAX_SAFE_DELAY = 2147483647;
      if (delay > MAX_SAFE_DELAY) {
        delay = MAX_SAFE_DELAY;
      }
      this.tokenRefreshScheduled = true;
      setTimeout(() => this.proactiveTokenRefresh(), delay);
      this.log(`[SUNy Bridge] Token refresh scheduled in ${Math.round(Math.min(delay, refreshAt - Date.now()) / 3600000)}h`);
    } catch { /* ignore parse errors */ }
  }

  private async proactiveTokenRefresh(): Promise<void> {
    const rt = this.refreshToken || this.loadRefreshToken();
    if (!rt) { this.startTokenRefreshFlow(); return; }
    try {
      const serverUrl = this.server
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://')
        .replace('/bridge', '');
      const resp = await fetch(`${serverUrl}/api/bridge/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as { token: string; refreshToken: string };
      this.token = data.token;
      this.setRefreshToken(data.refreshToken);
      this.tokenRefreshScheduled = false;
      this.scheduleProactiveTokenRefresh();
      this.log('[SUNy Bridge] Token refreshed automatically ✓');
      this.ws?.close();
    } catch (err) {
      this.log('[SUNy Bridge] Auto-refresh failed, retrying in 1h:', err);
      setTimeout(() => this.proactiveTokenRefresh(), 3_600_000);
    }
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
    const url = `${this.server}/bridge`;

    try {
      // Send token via Sec-WebSocket-Protocol header (avoids leaking JWT in URL/query strings)
      this.ws = new WebSocket(url, [this.token]);
    } catch (err) {
      this.log('[SUNy Bridge] Failed to create connection:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.log('[SUNy Bridge] Connected to SUNy server ✓');
      this.reconnectDelay = RECONNECT_DELAY;
      this.startHeartbeat();

      if (!this.startupRegistered) {
        this.registerStartup();
      }

      // Schedule proactive token refresh before expiry
      this.scheduleProactiveTokenRefresh();

      // Show first-time setup instructions
      if (this.isFirstConnection) {
        this.showFirstTimeSetup();
        this.isFirstConnection = false;
      }
    });

    this.ws.on('message', (raw) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', (code, reason) => {
      this.clearTimers();
      if (code === 4001) {
        this.log('[SUNy Bridge] Authentication failed (code 4001). Token expired or invalid.');
        // Clear expired token from config so user can reconnect with fresh token
        updateConfig({ token: undefined });
        this.log('[SUNy Bridge] Cleared expired token from config.');
        this.log('[SUNy Bridge] To reconnect, get a new setup code from the web app and run:');
        this.log('[SUNy Bridge]   suny-bridge start --code SUNY-XXXXX-XXXXX');
        this.stopped = true;
        process.exit(1);
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
      this.send({ type: 'bridge:pong', ts: payload?.ts });
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
      return;
    }

    if (type?.startsWith('browser:') && id) {
      handleBrowser(type, id, (payload || {}) as Record<string, unknown>, (msg) => this.send(msg));
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

  /**
   * Display comprehensive first-time setup instructions
   * Includes: auto-start, permissions, Windows Defender exclusion, always-on info
   */
  private showFirstTimeSetup(): void {
    if (this.silent) return;
    const isWin = process.platform === 'win32';
    const startupPath = isWin
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SUNyBridge.vbs')
      : path.join(os.homedir(), '.suny', 'startup.sh');

    this.log('');
    this.log('╔══════════════════════════════════════════════════════════════════╗');
    this.log('║           🌟 SUNy Bridge First-Time Setup Complete 🌟            ║');
    this.log('╚══════════════════════════════════════════════════════════════════╝');
    this.log('');
    this.log('📌 IMPORTANT: The bridge is now connected and ready!');
    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log(' 1️⃣  AUTO-START ON WINDOWS LOGIN (Recommended)');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log('    To make bridge start automatically when Windows boots:');
    this.log('');
    this.log('    Option A - One-time setup command:');
    this.log('        suny-bridge --install-startup');
    this.log('');
    this.log('    Option B - Manual startup folder:');
    this.log(`        Copy shortcut to: ${startupPath}`);
    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log(' 2️⃣  WINDOWS DEFENDER / ANTIVIRUS (If files not accessible)');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log('    If bridge cannot access project files, add exclusion for:');
    this.log('');
    this.log('        Folder: %USERPROFILE%\\.suny');
    this.log('        Or run PowerShell as Admin:');
    this.log('        Add-MpPreference -ExclusionPath "~\\.suny"');
    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log(' 3️⃣  ALWAYS-ON & AUTO-RECONNECT FEATURES');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log('    ✓ Auto-reconnect on connection loss (5s-60s backoff)');
    this.log('    ✓ Heartbeat every 30s to detect dead connections');
    this.log('    ✓ Auto-reconnect after network/WiFi issues');
    this.log('    ✓ Auto-startup on Windows login (after enabling)');
    this.log('    ✓ Automatic token refresh before expiry (30 days)');
    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log(' 4️⃣  FULL ACCESS PERMISSIONS');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log('    The bridge can now access:');
    this.log('      • All files in registered project directories');
    this.log('      • Terminal/command execution');
    this.log('      • Browser automation (via puppeteer)');
    this.log('      • File read/write operations');
    this.log('');
    this.log('    To register a new project:');
    this.log('        suny-bridge --register "C:\\path\\to\\project"');
    this.log('');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log(' 5️⃣  KEEP BRIDGE RUNNING');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log('    For 24/7 operation:');
    this.log('    • Run in background:  suny-bridge start --silent');
    this.log('    • Or install startup: suny-bridge --install-startup');
    this.log('');
    this.log('    The bridge will stay connected and auto-reconnect to any');
    this.log('    network changes, server restarts, or temporary disconnects.');
    this.log('');
    this.log('╔══════════════════════════════════════════════════════════════════╗');
    this.log('║  🚀 SUNy Bridge is ready! Your AI companion has full access.      ║');
    this.log('╚══════════════════════════════════════════════════════════════════╝');
    this.log('');
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
