/**
 * SUNy Scheduled Agents API Routes.
 *
 * GET    /api/scheduled               â€” list all scheduled agents for user
 * POST   /api/scheduled               â€” create a new scheduled agent
 * PATCH  /api/scheduled/:id           â€” update an existing scheduled agent
 * DELETE /api/scheduled/:id           â€” delete a scheduled agent
 * GET    /api/scheduled/:id/logs      â€” get execution logs for an agent
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from './auth';
import {
  createScheduledAgent,
  updateScheduledAgent,
  listScheduledAgents,
  deleteScheduledAgent,
  getScheduledAgent,
  getAgentLogs,
  executeScheduledAgent,
} from './scheduled-agents';

const router = Router();
router.use(requireAuth);

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  prompt: z.string().min(1),
  frequency: z.enum(['once', 'hourly', 'daily', 'weekly', 'custom_cron']),
  cron_expression: z.string().optional(),
  mode: z.string().optional(),
  project_id: z.number().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  prompt: z.string().min(1).optional(),
  frequency: z.enum(['once', 'hourly', 'daily', 'weekly', 'custom_cron']).optional(),
  cron_expression: z.string().optional(),
  mode: z.string().optional(),
  is_active: z.boolean().optional(),
});

router.get('/scheduled', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const agents = listScheduledAgents(user.id as number);
  res.json({ agents });
});

router.post('/scheduled', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const agent = createScheduledAgent({
    userId: user.id as number,
    projectId: parsed.data.project_id,
    name: parsed.data.name,
    description: parsed.data.description,
    prompt: parsed.data.prompt,
    frequency: parsed.data.frequency,
    cronExpression: parsed.data.cron_expression,
    mode: parsed.data.mode,
  });
  res.json(agent);
});

router.patch('/scheduled/:id', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const existing = getScheduledAgent(id);
  if (!existing || existing.user_id !== (user.id as number)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }

  const updated = updateScheduledAgent(id, {
    name: parsed.data.name,
    description: parsed.data.description,
    prompt: parsed.data.prompt,
    frequency: parsed.data.frequency,
    cronExpression: parsed.data.cron_expression,
    mode: parsed.data.mode,
    isActive: parsed.data.is_active,
  });
  res.json(updated);
});

router.delete('/scheduled/:id', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const existing = getScheduledAgent(id);
  if (!existing || existing.user_id !== (user.id as number)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  deleteScheduledAgent(id);
  res.json({ success: true });
});

router.post('/scheduled/:id/run', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const agent = getScheduledAgent(id);
  if (!agent || agent.user_id !== (user.id as number)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    const log = await executeScheduledAgent(agent);
    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/scheduled/:id/logs', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

  const existing = getScheduledAgent(id);
  if (!existing || existing.user_id !== (user.id as number)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const logs = getAgentLogs(id, parseInt(req.query.limit as string, 10) || 20);
  res.json({ logs });
});

export default router;
