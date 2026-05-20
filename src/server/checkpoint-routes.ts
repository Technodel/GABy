/**
 * SUNy Checkpoint Timeline API Routes.
 *
 * Uses checkpoint-manager.ts for rich metadata-backed checkpoint records.
 *
 * GET  /api/checkpoints/timeline/:projectId  — rich checkpoint timeline
 * GET  /api/checkpoints/detail/:id            — single checkpoint detail
 * POST /api/checkpoints/rollback/:id          — rollback to a specific checkpoint by internal id
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from './auth';
import {
  getCheckpointTimeline,
  getCheckpointById,
  rollbackWithRecord,
  getCheckpointsByTag,
} from './checkpoint-manager';
import { getDb } from './db';

const router = Router();
router.use(requireAuth);

router.get('/checkpoints/timeline/:projectId', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }

  const timeline = getCheckpointTimeline(user.id as number, projectId, 50);
  res.json({ timeline });
});

router.get('/checkpoints/detail/:id', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const record = getCheckpointById(id);
  if (!record || record.user_id !== (user.id as number)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Parse metadata for richer display
  let metadata = {};
  try { metadata = JSON.parse(record.metadata_json || '{}'); } catch {}

  res.json({
    ...record,
    tags: record.tags ? record.tags.split(',').filter(Boolean) : [],
    metadata,
  });
});

router.post('/checkpoints/rollback/:id', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  // Get project path from checkpoint record
  const record = getCheckpointById(id);
  if (!record || record.user_id !== (user.id as number)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const db = getDb();
  const project = db.prepare('SELECT local_path FROM projects WHERE id = ?').get(record.project_id) as { local_path: string } | undefined;
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const result = await rollbackWithRecord(user.id as number, project.local_path, id);
  res.json(result);
});

router.get('/checkpoints/tags/:projectId', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }

  const tag = req.query.tag as string;
  if (!tag) { res.status(400).json({ error: 'tag query parameter required' }); return; }

  const records = getCheckpointsByTag(user.id as number, tag, 50);
  res.json({ checkpoints: records });
});

export default router;
