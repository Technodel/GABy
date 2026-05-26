import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth, AuthRequest } from './auth';
import { getDb } from './db';
import { userClientManager } from './user-client-manager';

const router = Router();

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateUid(): string {
  return crypto.randomBytes(16).toString('hex');
}

interface ClientLinkRow {
  id: number;
  uid: string;
  user_id: number;
  project_id: number | null;
  project_name: string;
  title: string;
  description: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}

interface ClientRequestRow {
  id: number;
  link_uid: string;
  client_name: string;
  client_email: string;
  description: string;
  status: string;
  admin_notes: string;
  created_at: string;
}

// â”€â”€ All routes require auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.use(requireAuth);

// â”€â”€ List all client links for the authenticated user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/client-links', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const links = getDb().prepare(
    'SELECT * FROM client_links WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as ClientLinkRow[];

  // Attach request counts per link
  const enriched = links.map(link => {
    const pendingCount = (getDb().prepare(
      'SELECT COUNT(*) as c FROM client_requests WHERE link_uid = ? AND status = ?'
    ).get(link.uid, 'pending') as { c: number }).c;

    const totalCount = (getDb().prepare(
      'SELECT COUNT(*) as c FROM client_requests WHERE link_uid = ?'
    ).get(link.uid) as { c: number }).c;

    return {
      ...link,
      pending_requests: pendingCount,
      total_requests: totalCount,
    };
  });

  res.json({ links: enriched });
});

// â”€â”€ Create a new client link â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.post('/client-links', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const { project_id, project_name, title, description, expires_in_days } = req.body;

  const uid = generateUid();
  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;

  const result = getDb().prepare(
    `INSERT INTO client_links (uid, user_id, project_id, project_name, title, description, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(uid, userId, project_id || null, project_name || '', title || '', description || '', expiresAt);

  const link = getDb().prepare('SELECT * FROM client_links WHERE id = ?').get(result.lastInsertRowid) as ClientLinkRow;

  res.status(201).json({ link });
});

// â”€â”€ Update a client link â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.put('/client-links/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const link = getDb().prepare(
    'SELECT * FROM client_links WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as ClientLinkRow | undefined;

  if (!link) {
    res.status(404).json({ error: 'Client link not found' });
    return;
  }

  const { title, description, status, expires_in_days } = req.body;

  if (title !== undefined) {
    getDb().prepare('UPDATE client_links SET title = ? WHERE id = ?').run(title, link.id);
  }
  if (description !== undefined) {
    getDb().prepare('UPDATE client_links SET description = ? WHERE id = ?').run(description, link.id);
  }
  if (status !== undefined) {
    getDb().prepare('UPDATE client_links SET status = ? WHERE id = ?').run(status, link.id);
  }
  if (expires_in_days !== undefined) {
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
      : null;
    getDb().prepare('UPDATE client_links SET expires_at = ? WHERE id = ?').run(expiresAt, link.id);
  }

  const updated = getDb().prepare('SELECT * FROM client_links WHERE id = ?').get(link.id) as ClientLinkRow;
  res.json({ link: updated });
});

// â”€â”€ Delete a client link â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.delete('/client-links/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const link = getDb().prepare(
    'SELECT * FROM client_links WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as ClientLinkRow | undefined;

  if (!link) {
    res.status(404).json({ error: 'Client link not found' });
    return;
  }

  // Delete associated requests first
  getDb().prepare('DELETE FROM client_requests WHERE link_uid = ?').run(link.uid);
  getDb().prepare('DELETE FROM client_links WHERE id = ?').run(link.id);

  res.json({ success: true });
});

// â”€â”€ List requests for a specific link â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/client-links/:id/requests', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const link = getDb().prepare(
    'SELECT * FROM client_links WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as ClientLinkRow | undefined;

  if (!link) {
    res.status(404).json({ error: 'Client link not found' });
    return;
  }

  const requests = getDb().prepare(
    'SELECT * FROM client_requests WHERE link_uid = ? ORDER BY created_at DESC'
  ).all(link.uid) as ClientRequestRow[];

  res.json({ requests });
});

// â”€â”€ Update request status (approve/deny) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.put('/client-requests/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const request = getDb().prepare(
    `SELECT r.*, l.user_id FROM client_requests r
     JOIN client_links l ON l.uid = r.link_uid
     WHERE r.id = ? AND l.user_id = ?`
  ).get(req.params.id, userId) as (ClientRequestRow & { user_id: number }) | undefined;

  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }

  const { status, admin_notes } = req.body;

  if (status !== undefined) {
    getDb().prepare('UPDATE client_requests SET status = ? WHERE id = ?').run(status, request.id);
  }
  if (admin_notes !== undefined) {
    getDb().prepare('UPDATE client_requests SET admin_notes = ? WHERE id = ?').run(admin_notes, request.id);
  }

  const updated = getDb().prepare('SELECT * FROM client_requests WHERE id = ?').get(request.id) as ClientRequestRow;

  // If approved, notify the user via WebSocket
  if (status === 'approved') {
    userClientManager.pushChatContent(userId, 'client_request_approved', {
      requestId: request.id,
      description: request.description,
      clientName: request.client_name,
    });
  }

  res.json({ request: updated });
});

export default router;
