/**
 * SUNy Hypothesis Engine API Routes.
 *
 * GET  /api/hypotheses/:projectId    â€” list hypothesis runs for a project
 * GET  /api/hypotheses/:projectId/:id  â€” get a single hypothesis run details
 */

import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from './auth';
import {
  getHypotheses,
  getWinningHypothesis,
  selectBestHypothesis,
  selectStrategies,
} from './hypothesis-engine';

const router = Router();
router.use(requireAuth);

router.get('/hypotheses/:projectId', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }

  const hypotheses = getHypotheses(user.id as number, projectId);
  const results = selectBestHypothesis(hypotheses);

  res.json({ hypotheses, results });
});

router.get('/hypotheses/:projectId/winner', (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: 'Invalid project id' }); return; }

  const problem = (req.query.problem as string) || '';
  if (!problem) { res.status(400).json({ error: 'problem query parameter required' }); return; }

  const winner = getWinningHypothesis(user.id as number, projectId, problem);
  if (!winner) { res.status(404).json({ error: 'No completed hypothesis found for this problem' }); return; }
  res.json(winner);
});

router.get('/hypotheses/:projectId/strategies', (req: Request, res: Response) => {
  const problem = (req.query.problem as string) || '';
  if (!problem) { res.status(400).json({ error: 'problem query parameter required' }); return; }

  const strategies = selectStrategies(problem);
  res.json({ strategies });
});

export default router;
