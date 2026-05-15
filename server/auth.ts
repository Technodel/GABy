import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getDb } from './db';

const JWT_SECRET = process.env.GABY_SECRET_JWT || 'gaby-dev-secret-k3y-2024';
const ADMIN_PASSWORD = process.env.GABY_ADMIN_PASSWORD || '301088';

export interface AuthPayload {
  id: number | 'admin';
  username: string;
  role: 'admin' | 'user';
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
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
  const token = req.cookies?.gaby_token || extractBearerToken(req);
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
  const token = req.cookies?.gaby_token || extractBearerToken(req);
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
export function adminLogin(req: Request, res: Response): void {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(401).json({ error: 'Password required' });
    return;
  }
  // Check env variable first (backward compatible), then stored hash from DB
  let valid = password === ADMIN_PASSWORD;
  if (!valid) {
    try {
      const db = getDb();
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'admin_password_hash'").get() as { value: string } | undefined;
      if (row) {
        valid = bcrypt.compareSync(password, row.value);
      }
    } catch {
      // DB not initialized yet — fall through to failure
    }
  }
  if (!valid) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const token = signToken({ id: 0, username: 'admin', role: 'admin' });
  res.cookie('gaby_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ success: true });
}

// User login handler
export function userLogin(req: Request, res: Response): void {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username) as UserRow | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = signToken({ id: user.id, username: user.username, role: 'user' });
  res.cookie('gaby_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ success: true, userId: user.id });
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie('gaby_token');
  res.json({ success: true });
}

export function userRegister(req: Request, res: Response): void {
  const db = getDb();

  // Check if self-registration is allowed
  const allowReg = db.prepare("SELECT value FROM app_settings WHERE key='allow_registration'").get() as { value: string } | undefined;
  if (allowReg?.value !== 'true') {
    res.status(403).json({ error: 'Registration is currently closed. Please contact support.' });
    return;
  }

  const { username, password, display_name } = req.body as { username?: string; password?: string; display_name?: string };
  if (!username || !password) { res.status(400).json({ error: 'Username and password are required.' }); return; }
  if (username.length < 3 || username.length > 50 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    res.status(400).json({ error: 'Username must be 3–50 characters (letters, numbers, underscores only).' }); return;
  }
  if (password.length < 6 || password.length > 100) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' }); return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) { res.status(409).json({ error: 'Username already taken.' }); return; }

  const hash = bcrypt.hashSync(password, 12);
  const cleanName = typeof display_name === 'string' && display_name.trim() ? display_name.trim().slice(0, 50) : null;
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, is_active, balance) VALUES (?, ?, ?, 1, 0)'
  ).run(username, hash, cleanName);

  const userId = result.lastInsertRowid as number;
  const token = signToken({ id: userId, username, role: 'user' });
  res.cookie('gaby_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
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
