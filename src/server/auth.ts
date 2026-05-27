import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getAdapter } from './db';

const JWT_SECRET = (() => {
  const secret = process.env.SUNY_SECRET_JWT;
  if (!secret || secret.length < 16) {
    throw new Error('SUNY_SECRET_JWT environment variable is required (min 16 characters). Set it in .env before starting the server.');
  }
  return secret;
})();

export interface AuthPayload {
  id: number | 'admin';
  username: string;
  role: 'admin' | 'user';
}

export function signToken(payload: AuthPayload, expiresIn?: string): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresIn || '8h' });
}

export function signBridgeToken(payload: AuthPayload): { token: string; refreshToken: string } {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  const refreshToken = jwt.sign(
    { ...payload, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: '90d' },
  );
  return { token, refreshToken };
}

export function refreshBridgeToken(req: Request, res: Response): void {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) { res.status(400).json({ error: 'Missing refresh token' }); return; }

  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET) as AuthPayload & { type?: string };
    if (decoded.type !== 'refresh') { res.status(401).json({ error: 'Invalid token type' }); return; }

    const newPair = signBridgeToken({ id: decoded.id, username: decoded.username, role: decoded.role });
    res.json({ token: newPair.token, refreshToken: newPair.refreshToken });
  } catch {
    res.status(401).json({ error: 'Refresh token expired or invalid' });
  }
}

export function refreshToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }) as AuthPayload;
    // Only refresh if token is not yet expired beyond a 7-day grace window
    if ((decoded as unknown as { exp: number }).exp * 1000 < Date.now() - 7 * 24 * 60 * 60 * 1000) {
      return null;
    }
    return signToken({ id: decoded.id, username: decoded.username, role: decoded.role });
  } catch {
    return null;
  }
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded as unknown as AuthPayload;
  } catch {
    return null;
  }
}

// Middleware: require any authenticated user (admin or user)
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.suny_token || extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  (req as AuthRequest).user = payload;
  next();
}

// Middleware: require admin role
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.suny_token || extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  (req as AuthRequest).user = payload;
  next();
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

// Admin login handler
export async function adminLogin(req: Request, res: Response): void {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(401).json({ error: 'Password required' });
    return;
  }
  // Use DB-stored hash as single source of truth.
  // One-time bootstrap: if no hash exists yet, set it from SUNY_ADMIN_PASSWORD env (then it's hashed and stored).
  try {
    const db = getAdapter();
    let row = await db.get("SELECT value FROM app_settings WHERE key = 'admin_password_hash'") as { value: string } | undefined;
    if (!row) {
      const bootstrap = process.env.SUNY_ADMIN_PASSWORD;
      if (!bootstrap) {
        res.status(500).json({ error: 'No admin password configured. Set SUNY_ADMIN_PASSWORD in .env on first run.' });
        return;
      }
      const hash = bcrypt.hashSync(bootstrap, 12);
      await db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('admin_password_hash', ?)", [hash]);
      console.log('[auth] One-time bootstrap: admin password hashed and stored in DB.');
      row = { value: hash };
    }
    if (!bcrypt.compareSync(password, row.value)) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
  } catch {
    res.status(500).json({ error: 'Authentication system unavailable' });
    return;
  }
  const token = signToken({ id: 0, username: 'admin', role: 'admin' });
  res.cookie('suny_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ success: true });
}

// User login handler
export async function userLogin(req: Request, res: Response): void {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  const db = getAdapter();
  const user = await db.get('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]) as UserRow | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Read role from users table (default 'user' for backward compatibility)
  const row = await db.get("SELECT role FROM users WHERE id = ?", [user.id]) as { role: string } | undefined;
  const role = (row?.role as 'admin' | 'user') || 'user';

  // Update last_visit
  await db.run("UPDATE users SET last_visit = datetime('now') WHERE id = ?", [user.id]);

  const token = signToken({ id: user.id, username: user.username, role });
  res.cookie('suny_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ success: true, userId: user.id, role });
}

export function refreshTokenEndpoint(req: Request, res: Response): void {
  const token = req.cookies?.suny_token || extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'No session to refresh' });
    return;
  }
  const newToken = refreshToken(token);
  if (!newToken) {
    res.clearCookie('suny_token');
    res.status(401).json({ error: 'Session expired. Please log in again.' });
    return;
  }
  res.cookie('suny_token', newToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ success: true, refreshed: true });
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie('suny_token');
  res.json({ success: true });
}

export async function userRegister(req: Request, res: Response): void {
  const db = getAdapter();

  // Check if self-registration is allowed
  const allowReg = await db.get("SELECT value FROM app_settings WHERE key='allow_registration'") as { value: string } | undefined;
  if (allowReg?.value !== 'true') {
    res.status(403).json({ error: 'Registration is currently closed. Please contact support.' });
    return;
  }

  const { username, password, display_name } = req.body as { username?: string; password?: string; display_name?: string };
  if (!username || !password) { res.status(400).json({ error: 'Username and password are required.' }); return; }
  if (username.length < 3 || username.length > 50 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    res.status(400).json({ error: 'Username must be 3â€“50 characters (letters, numbers, underscores only).' }); return;
  }
  if (password.length < 6 || password.length > 100) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' }); return;
  }

  const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) { res.status(409).json({ error: 'Username already taken.' }); return; }

  const hash = bcrypt.hashSync(password, 12);
  const cleanName = typeof display_name === 'string' && display_name.trim() ? display_name.trim().slice(0, 50) : null;
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, is_active, balance) VALUES (?, ?, ?, 1, 0)'
  ).run(username, hash, cleanName);

  const userId = result.lastInsertRowid as number;
  const token = signToken({ id: userId, username, role: 'user' });
  res.cookie('suny_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ success: true });
}

export interface AuthRequest extends Request {
  user: AuthPayload;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  balance: number;
  is_active: number;
}
