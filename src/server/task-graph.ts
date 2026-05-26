/**
 * SUNy Task Dependency Graph â€” DAG-based task decomposition.
 *
 * Enables the agent to:
 *   1. Decompose complex tasks into dependency-ordered nodes
 *   2. Understand what must be done before what
 *   3. Work the graph â€” unblock nodes, complete leaves first, roll up
 *   4. Track completion proof per node
 *
 * Feature flag: ff_task_graph
 */

import { getDb } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type TaskNodeStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';

export interface TaskNode {
  id: string;
  goalId: string;
  userId: number;
  projectId: number;
  description: string;
  status: TaskNodeStatus;
  dependsOn: string[];           // node IDs that must complete first
  blockedBy: string[];           // currently can't proceed because...
  completionProof: string[];     // evidence this node is done
  attemptCount: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GraphStatus {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  pending: number;
  failed: number;
  readyToExecute: string[];      // node IDs that are unblocked and pending
}

// â”€â”€ DB initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function initializeTaskGraphTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_graph_nodes (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      depends_on TEXT NOT NULL DEFAULT '[]',
      blocked_by TEXT NOT NULL DEFAULT '[]',
      completion_proof TEXT NOT NULL DEFAULT '[]',
      attempt_count INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY(goal_id) REFERENCES goal_stack(id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tg_goal ON task_graph_nodes(goal_id);
    CREATE INDEX IF NOT EXISTS idx_tg_status ON task_graph_nodes(status);
    CREATE INDEX IF NOT EXISTS idx_tg_user ON task_graph_nodes(user_id);
  `);
}

// â”€â”€ Core operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create a task node in the dependency graph.
 */
export function createTaskNode(input: {
  goalId: string;
  userId: number;
  projectId: number;
  description: string;
  dependsOn?: string[];
  sortOrder?: number;
}): string {
  const db = getDb();
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  db.prepare(`
    INSERT INTO task_graph_nodes
      (id, goal_id, user_id, project_id, description, depends_on, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.goalId, input.userId, input.projectId, input.description,
    JSON.stringify(input.dependsOn || []), input.sortOrder ?? 0);

  // Check if this node is blocked by incomplete dependencies
  updateBlockedStatus(id);

  return id;
}

/**
 * Get a task node by ID.
 */
export function getTaskNode(nodeId: string): TaskNode | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM task_graph_nodes WHERE id = ?').get(nodeId) as TaskNodeRow | undefined;
  return row ? rowToNode(row) : null;
}

/**
 * Get all nodes for a goal.
 */
export function getGoalNodes(goalId: string): TaskNode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM task_graph_nodes WHERE goal_id = ? ORDER BY sort_order ASC, created_at ASC
  `).all(goalId) as TaskNodeRow[];
  return rows.map(rowToNode);
}

/**
 * Mark a node as in_progress.
 */
export function startTaskNode(nodeId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE task_graph_nodes SET status = 'in_progress', attempt_count = attempt_count + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(nodeId);
}

/**
 * Mark a node as completed with proof.
 */
export function completeTaskNode(nodeId: string, proof: string): void {
  const db = getDb();
  const node = getTaskNode(nodeId);
  if (!node) return;

  const proofs = [...node.completionProof, proof];
  db.prepare(`
    UPDATE task_graph_nodes SET status = 'completed', completion_proof = ?, completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(proofs), nodeId);

  // After completing, check if any dependent nodes are now unblocked
  const db2 = getDb();
  const dependents = db2.prepare(`
    SELECT id, depends_on FROM task_graph_nodes
    WHERE status = 'blocked' AND depends_on LIKE ?
  `).all(`%"${nodeId}"%`) as Array<{ id: string; depends_on: string }>;

  for (const dep of dependents) {
    updateBlockedStatus(dep.id);
  }
}

/**
 * Mark a node as failed.
 */
export function failTaskNode(nodeId: string, reason: string): void {
  const db = getDb();
  const node = getTaskNode(nodeId);
  if (!node) return;

  const blockedBy = [...node.blockedBy, reason];
  db.prepare(`
    UPDATE task_graph_nodes SET status = 'failed', blocked_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(blockedBy), nodeId);
}

/**
 * Add a blocking reason to a node.
 */
export function blockTaskNode(nodeId: string, reason: string): void {
  const db = getDb();
  const node = getTaskNode(nodeId);
  if (!node) return;

  const blockedBy = [...node.blockedBy, reason];
  db.prepare(`
    UPDATE task_graph_nodes SET status = 'blocked', blocked_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(blockedBy), nodeId);
}

/**
 * Get the execution order (topological sort) for a goal's task graph.
 * Returns node IDs in dependency order.
 */
export function getExecutionOrder(goalId: string): string[] {
  const nodes = getGoalNodes(goalId);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    for (const depId of node.dependsOn) {
      visit(depId);
    }
    result.push(nodeId);
  }

  for (const node of nodes) {
    visit(node.id);
  }

  return result;
}

/**
 * Get nodes that are ready to execute (pending + all dependencies met).
 */
export function getReadyNodes(goalId: string): TaskNode[] {
  const nodes = getGoalNodes(goalId);
  const completedIds = new Set(
    nodes.filter(n => n.status === 'completed').map(n => n.id)
  );

  return nodes.filter(n => {
    if (n.status !== 'pending') return false;
    return n.dependsOn.every(depId => completedIds.has(depId));
  });
}

/**
 * Get graph status for a goal.
 */
export function getGraphStatus(goalId: string): GraphStatus {
  const nodes = getGoalNodes(goalId);
  const readyToExecute = getReadyNodes(goalId).map(n => n.id);

  const counts = { total: 0, completed: 0, inProgress: 0, blocked: 0, pending: 0, failed: 0 };
  for (const n of nodes) {
    counts.total++;
    if (n.status === 'completed') counts.completed++;
    else if (n.status === 'in_progress') counts.inProgress++;
    else if (n.status === 'blocked') counts.blocked++;
    else if (n.status === 'failed') counts.failed++;
    else counts.pending++;
  }

  return { ...counts, readyToExecute };
}

/**
 * Format the task graph as a context block for the agent prompt.
 */
export function formatGraphContext(goalId: string): string {
  const nodes = getGoalNodes(goalId);
  if (nodes.length === 0) return '';

  const status = getGraphStatus(goalId);
  const order = getExecutionOrder(goalId);

  let ctx = `<task_graph>\n`;
  ctx += `  Total nodes: ${status.total} | Completed: ${status.completed} | `;
  ctx += `In progress: ${status.inProgress} | Blocked: ${status.blocked} | Pending: ${status.pending}\n\n`;

  // Show execution plan
  ctx += `  Execution plan:\n`;
  for (const nodeId of order) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) continue;
    const depMarker = node.dependsOn.length > 0 ? ` (after: ${node.dependsOn.join(', ')})` : '';
    ctx += `    [${statusIcon(node.status)}] ${node.description}${depMarker}\n`;

    if (node.blockedBy.length > 0) {
      ctx += `      â›” Blocked: ${node.blockedBy.join('; ')}\n`;
    }
    if (node.completionProof.length > 0) {
      ctx += `      âœ… Proof: ${node.completionProof[node.completionProof.length - 1]}\n`;
    }
  }

  if (status.readyToExecute.length > 0) {
    ctx += `\n  Ready to execute: ${status.readyToExecute.length} node(s)\n`;
    for (const nodeId of status.readyToExecute) {
      const node = nodes.find(n => n.id === nodeId);
      if (node) ctx += `    â†’ ${node.description}\n`;
    }
  }

  ctx += `</task_graph>`;
  return ctx;
}

// â”€â”€ Internal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface TaskNodeRow {
  id: string;
  goal_id: string;
  user_id: number;
  project_id: number;
  description: string;
  status: string;
  depends_on: string;
  blocked_by: string;
  completion_proof: string;
  attempt_count: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToNode(row: TaskNodeRow): TaskNode {
  return {
    id: row.id,
    goalId: row.goal_id,
    userId: row.user_id,
    projectId: row.project_id,
    description: row.description,
    status: row.status as TaskNodeStatus,
    dependsOn: JSON.parse(row.depends_on || '[]'),
    blockedBy: JSON.parse(row.blocked_by || '[]'),
    completionProof: JSON.parse(row.completion_proof || '[]'),
    attemptCount: row.attempt_count,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * Re-evaluate a node's blocked status based on its dependencies.
 */
function updateBlockedStatus(nodeId: string): void {
  const db = getDb();
  const node = getTaskNode(nodeId);
  if (!node || node.status === 'completed') return;

  const allNodes = db.prepare('SELECT id, status FROM task_graph_nodes').all() as Array<{ id: string; status: string }>;
  const completedIds = new Set(allNodes.filter(n => n.status === 'completed').map(n => n.id));

  const missingDeps = node.dependsOn.filter(depId => !completedIds.has(depId));
  if (missingDeps.length > 0) {
    const reasons = missingDeps.map(depId => {
      const dep = allNodes.find(n => n.id === depId);
      return dep ? `dependency ${depId} (${dep.status})` : `dependency ${depId} (unknown)`;
    });
    db.prepare(`
      UPDATE task_graph_nodes SET status = 'blocked', blocked_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(reasons), nodeId);
  } else if (node.status === 'blocked') {
    // If node was blocked but dependencies are now met, reset to pending
    db.prepare(`
      UPDATE task_graph_nodes SET status = 'pending', blocked_by = '[]', updated_at = datetime('now')
      WHERE id = ?
    `).run(nodeId);
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return 'âœ…';
    case 'in_progress': return 'ðŸ”„';
    case 'blocked': return 'â›”';
    case 'failed': return 'âŒ';
    default: return 'â³';
  }
}
