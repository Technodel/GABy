/**
 * SUNy Bridge Onboarding — setup code flow for first-time users.
 *
 * Flow:
 *   1. User clicks "Connect" → server generates a random setup code
 *   2. User runs `suny-bridge start --code <CODE> --server <URL>` in their terminal
 *   3. Bridge client calls POST /api/bridge/activate with the code
 *   4. Server marks the code as redeemed and returns a scoped auth token
 *   5. Bridge uses that token for its WebSocket connection
 *
 * This avoids the browser folder-picker problem: the absolute project path
 * is resolved on the local machine by the bridge itself.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from './db';
import { signToken } from './auth';
import { isBridgeSetupCodesEnabled } from './feature-flags';
import { logOperation } from './operation-audit';

const router = Router();

// In-memory rate limit for code generation (per IP)
const genRateLimit = new Map<string, number>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const MAX_GENERATIONS = 3; // max 3 code generations per minute per IP

/**
 * Generate a numeric-random setup code.
 * Format: SUNY-XXXXX-XXXXX (12 chars, human-readable)
 */
function generateSetupCode(): string {
  const rand1 = crypto.randomBytes(4).readUInt32BE(0).toString(16).toUpperCase().slice(0, 5);
  const rand2 = crypto.randomBytes(4).readUInt32BE(0).toString(16).toUpperCase().slice(0, 5);
  return `SUNY-${rand1}-${rand2}`;
}

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  const count = genRateLimit.get(ip) ?? 0;

  // Clean old entries every 10 requests
  if (genRateLimit.size > 1000) genRateLimit.clear();

  if (count >= MAX_GENERATIONS) return false;

  genRateLimit.set(ip, count + 1);

  // Auto-cleanup after window
  setTimeout(() => {
    const current = genRateLimit.get(ip) ?? 0;
    if (current > 0) genRateLimit.set(ip, current - 1);
  }, RATE_LIMIT_WINDOW);

  return true;
}

// ── POST /api/bridge/setup-code — Generate a new setup code ─────────────────

interface BridgeSetupCodeRequest extends Request {
  userId?: number;
}

router.post('/setup-code', (req: BridgeSetupCodeRequest, res: Response) => {
  if (!isBridgeSetupCodesEnabled()) {
    res.status(503).json({ error: 'Bridge setup codes are currently disabled' });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Rate limit
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'Too many code generations. Please wait a moment.' });
    return;
  }

  // Clean expired pending codes for this user (older than 30min)
  const db = getDb();
  db.prepare(
    "DELETE FROM bridge_setup_codes WHERE user_id = ? AND status = 'pending' AND created_at < datetime('now', '-30 minutes')",
  ).run(userId);

  // Generate unique code
  let code: string;
  let attempts = 0;
  do {
    code = generateSetupCode();
    attempts++;
    if (attempts > 10) {
      res.status(500).json({ error: 'Failed to generate unique code' });
      return;
    }
  } while (db.prepare('SELECT 1 FROM bridge_setup_codes WHERE code = ?').get(code));

  const serverUrl = `${req.protocol}://${req.get('host') || 'localhost:3000'}`;

  db.prepare(
    `INSERT INTO bridge_setup_codes (user_id, code, status, server_url)
     VALUES (?, ?, 'pending', ?)`,
  ).run(userId, code, serverUrl);

  logOperation({
    userId,
    operation: 'bridge_setup_code_generated',
    status: 'success',
    detail: `Code: ${code.slice(0, 10)}...`,
  });

  res.json({ code, serverUrl });
});

// ── POST /api/bridge/activate — Redeem a setup code (called by bridge CLI) ──

router.post('/activate', (req: Request, res: Response) => {
  if (!isBridgeSetupCodesEnabled()) {
    res.status(503).json({ error: 'Bridge setup codes are currently disabled' });
    return;
  }

  const { code } = req.body as { code?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Missing or invalid code' });
    return;
  }

  const db = getDb();
  const record = db.prepare(
    "SELECT * FROM bridge_setup_codes WHERE code = ? AND status = 'pending'",
  ).get(code) as { id: number; user_id: number } | undefined;

  if (!record) {
    res.status(404).json({ error: 'Invalid or expired setup code' });
    return;
  }

  // Mark as redeemed
  db.prepare(
    "UPDATE bridge_setup_codes SET status = 'redeemed', redeemed_at = datetime('now') WHERE id = ?",
  ).run(record.id);

  // Look up username for the token payload
  const userRecord = db.prepare('SELECT username FROM users WHERE id = ?').get(record.user_id) as { username: string } | undefined;
  const username = userRecord?.username || 'unknown';

  // Generate a scoped bridge token (valid for 30 days)
  const bridgeToken = signToken(
    { id: record.user_id, username, role: 'user' },
    '30d',
  );

  logOperation({
    userId: record.user_id,
    operation: 'bridge_setup_code_redeemed',
    status: 'success',
    detail: `Code ${code.slice(0, 10)}... redeemed`,
  });

  res.json({
    token: bridgeToken,
    userId: record.user_id,
    expiresIn: '30d',
  });
});

// ── GET /api/bridge/status — Check bridge connection status (requires auth) ──

interface BridgeStatusRequest extends Request {
  userId?: number;
}

router.get('/status', (req: BridgeStatusRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Bridge connection status is managed by bridge-manager
  // We import it dynamically to avoid circular deps
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isBridgeConnected } = require('./bridge-manager');
    const connected = isBridgeConnected(userId);

    res.json({
      connected,
      userId,
      setupCode: null, // a code can be generated via POST /api/bridge/setup-code
    });
  } catch {
    res.json({ connected: false, userId, setupCode: null });
  }
});

// ── GET /api/bridge/setup-codes — List pending/redeemed codes ──────────────

interface BridgeSetupCodesRequest extends Request {
  userId?: number;
}

router.get('/setup-codes', (req: BridgeSetupCodesRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const db = getDb();
  const codes = db.prepare(
    `SELECT id, code, status, server_url, created_at, redeemed_at
     FROM bridge_setup_codes
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 10`,
  ).all(userId);

  res.json({ codes });
});

// ── POST /api/bridge/disconnect — Disconnect the bridge for this user ────

router.post('/disconnect', (req: BridgeStatusRequest, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { disconnectBridge } = require('./bridge-manager');
    const ok = disconnectBridge(userId);
    if (ok) {
      logOperation({ userId, operation: 'bridge_disconnect', status: 'success' });
      res.json({ success: true, message: 'Bridge disconnected' });
    } else {
      res.json({ success: false, message: 'Bridge was not connected' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect bridge' });
  }
});

export default router;
