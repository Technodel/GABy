/**
 * SUNy Session Replay â€” operation log + snapshot undo for every session.
 *
 * Every agent loop session generates:
 *   1. A structured operation log (via operation-audit.ts)
 *   2. Pre-turn file snapshots (via change-guardian.ts)
 *
 * This module exposes that data via REST endpoints so the UI can render
 * a replay timeline and a one-click undo button.
 */

import { Router, Request, Response } from 'express';
import { getSessionLog, getRecentSessions, logOperation } from './operation-audit';
import { isSessionReplayEnabled } from './feature-flags';
import { getAdapter } from './db';
import { sendToBridge } from './bridge-manager';

const router = Router();

interface AuthRequest extends Request {
  userId?: number;
}

// â”€â”€ GET /api/sessions â€” List recent sessions for the user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/', (req: AuthRequest, res: Response) => {
  if (!isSessionReplayEnabled()) {
    res.status(503).json({ error: 'Session replay is currently disabled' });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const sessions = getRecentSessions(userId, 20);
  res.json({ sessions });
});

// â”€â”€ GET /api/sessions/:sessionId â€” Get operation log for a session â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/:sessionId', (req: AuthRequest, res: Response) => {
  if (!isSessionReplayEnabled()) {
    res.status(503).json({ error: 'Session replay is currently disabled' });
    return;
  }

  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: 'Session ID required' });
    return;
  }

  const entries = getSessionLog(sessionId, 500);
  res.json({ sessionId, entries });
});

// â”€â”€ GET /api/sessions/:sessionId/undo â€” Get files that can be restored â”€â”€â”€â”€â”€â”€

router.get('/:sessionId/undo', (req: AuthRequest, res: Response) => {
  if (!isSessionReplayEnabled()) {
    res.status(503).json({ error: 'Session replay is currently disabled' });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: 'Session ID required' });
    return;
  }

  // Return snapshot metadata
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getSnapshotsForSession } = require('./change-guardian');
    const snapshots = getSnapshotsForSession(sessionId);
    res.json({ sessionId, snapshots });
  } catch {
    res.json({ sessionId, snapshots: [], message: 'Snapshot system not available' });
  }
});

// â”€â”€ POST /api/sessions/:sessionId/undo â€” Restore files from snapshot â”€â”€â”€â”€â”€â”€â”€

router.post('/:sessionId/undo', async (req: AuthRequest, res: Response) => {
  if (!isSessionReplayEnabled()) {
    res.status(503).json({ error: 'Session replay is currently disabled' });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: 'Session ID required' });
    return;
  }

  // Find the project associated with this session
  const db = await getAdapter();
  const result = await db.get<{ project_id: number }>(
    `SELECT project_id
     FROM operation_log
     WHERE session_id = ? AND user_id = ? AND project_id IS NOT NULL
     LIMIT 1`,
    [sessionId, userId],
  );

  if (!result) {
    res.status(404).json({ error: 'No project found for this session' });
    return;
  }

  const project = await db.get<{ local_path: string }>(
    'SELECT local_path FROM projects WHERE id = ? AND user_id = ?',
    [result.project_id, userId],
  );

  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  // Restore from content snapshots
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { restoreContentSnapshots } = require('./change-guardian');
    const restoreResult = await restoreContentSnapshots(
      sessionId,
      userId,
      project.local_path,
      sendToBridge,
    );

    logOperation({
      userId,
      projectId: result.project_id,
      sessionId,
      operation: 'session_undo',
      status: restoreResult.success ? 'success' : 'error',
      detail: `Restored ${restoreResult.restored} files${!restoreResult.success ? `, ${restoreResult.failed} failed` : ''}`,
    });

    res.json(restoreResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logOperation({
      userId,
      projectId: result.project_id,
      sessionId,
      operation: 'session_undo',
      status: 'error',
      detail: msg,
    });
    res.status(500).json({ error: `Undo failed: ${msg}` });
  }
});

export default router;
