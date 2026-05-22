"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SunyBridge = void 0;
const ws_1 = __importDefault(require("ws"));
const executor_1 = require("./executor");
const browser_1 = require("./browser");
const config_1 = require("./config");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const startup_1 = require("./startup");
const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;
/** Seconds between token-refresh poll attempts after expiry */
const TOKEN_REFRESH_POLL_INTERVAL = 30000;
/** File path where a new token can be written for auto-pick-up */
const TOKEN_REFRESH_FILE = path.join(os.homedir(), '.suny', 'refresh_token');
class SunyBridge {
    constructor(token, server, options = {}) {
        this.ws = null;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.reconnectDelay = RECONNECT_DELAY;
        this.stopped = false;
        /** Tracks whether we've already registered for startup auto-launch */
        this.startupRegistered = false;
        /** Whether we are currently in the "waiting for a new token" recovery phase */
        this.awaitingTokenRefresh = false;
        this.tokenRefreshAttempts = 0;
        this.tokenRefreshTimer = null;
        this.token = token;
        this.server = server;
        this.silent = options.silent ?? false;
        this.log = this.silent ? () => { } : console.log;
    }
    start() {
        this.stopped = false;
        this.connect();
    }
    stop() {
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
    registerStartup() {
        // Only install if not already set up
        if ((0, startup_1.isStartupInstalled)()) {
            this.startupRegistered = true;
            return;
        }
        const ok = (0, startup_1.installStartup)();
        if (ok) {
            this.log('[SUNy Bridge] Auto-start registered — bridge will launch on boot ✓');
        }
        this.startupRegistered = true;
    }
    updateToken(newToken) {
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
    connect() {
        const url = `${this.server}/bridge?token=${encodeURIComponent(this.token)}`;
        try {
            this.ws = new ws_1.default(url);
        }
        catch (err) {
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
    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        const { type, id, payload } = msg;
        if (type === 'bridge:disconnect') {
            const reason = payload?.reason || 'unknown';
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
            const targetPath = payload.path;
            (0, config_1.registerPath)(targetPath);
            this.log(`[SUNy Bridge] Registered project path: ${targetPath}`);
            if (id) {
                // Resolve the server-side pending promise with bridge:done.
                this.send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
            }
            return;
        }
        if (type?.startsWith('exec:') && id) {
            (0, executor_1.handleExec)(type, id, (payload || {}), (msg) => this.send(msg));
            return;
        }
        if (type?.startsWith('browser:') && id) {
            (0, browser_1.handleBrowser)(type, id, (payload || {}), (msg) => this.send(msg));
        }
    }
    send(msg) {
        if (this.ws?.readyState === ws_1.default.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            this.send({ type: 'bridge:ping' });
        }, HEARTBEAT_INTERVAL);
    }
    scheduleReconnect() {
        this.reconnectTimer = setTimeout(() => {
            if (!this.stopped)
                this.connect();
        }, this.reconnectDelay);
        // Exponential backoff with cap
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }
    clearTimers() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
    }
    openBrowserForReauth() {
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
        }
        catch {
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
    startTokenRefreshFlow() {
        if (this.awaitingTokenRefresh)
            return; // already in progress
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
    scheduleTokenRefreshPoll() {
        if (this.stopped)
            return;
        this.tokenRefreshTimer = setTimeout(() => this.pollForNewToken(), TOKEN_REFRESH_POLL_INTERVAL);
    }
    pollForNewToken() {
        if (this.stopped)
            return;
        this.tokenRefreshAttempts++;
        // 1. Check token refresh file
        let candidateToken = null;
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
        }
        catch { /* ignore fs errors */ }
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
exports.SunyBridge = SunyBridge;
//# sourceMappingURL=bridge.js.map