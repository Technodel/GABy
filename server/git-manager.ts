/**
 * GABy Git Manager — ported from Aider's repo.py logic.
 *
 * After every agent step that modifies files, auto-commits the changes to git
 * with a message derived from the user's request.  This gives users a full
 * rollback history of everything GABy did — exactly like Aider.
 *
 * Non-fatal: git failures are logged but never surface as errors to the user.
 */

import path from 'path';
import { sendToBridge } from './bridge-manager';

// Cache which projects are git repos (avoids repeated git rev-parse calls)
const gitRepoCache = new Map<string, { isRepo: boolean; checkedAt: number }>();
const GIT_CACHE_TTL = 5 * 60_000; // 5 minutes

async function isGitRepo(userId: number, projectPath: string): Promise<boolean> {
  const key = `${userId}|${projectPath}`;
  const cached = gitRepoCache.get(key);
  if (cached && Date.now() - cached.checkedAt < GIT_CACHE_TTL) {
    return cached.isRepo;
  }
  try {
    await sendToBridge(userId, 'exec:shell', {
      command: 'git rev-parse --git-dir',
      cwd: projectPath,
      requiresConfirmation: false,
    }, 5_000);
    gitRepoCache.set(key, { isRepo: true, checkedAt: Date.now() });
    return true;
  } catch {
    gitRepoCache.set(key, { isRepo: false, checkedAt: Date.now() });
    return false;
  }
}

/**
 * Stage the given files and commit them.
 * Called automatically at the end of each agent turn that produced file changes.
 *
 * @param changedFiles  Absolute paths of files that were written / edited.
 * @param userMessage   The user's original message (used to build commit message).
 */
export async function gitAutoCommit(
  userId: number,
  projectPath: string,
  changedFiles: string[],
  userMessage: string,
): Promise<void> {
  if (!changedFiles.length) return;
  if (!(await isGitRepo(userId, projectPath))) return;

  // Convert to relative paths (forward slashes for cross-platform git compat)
  const relFiles = changedFiles
    .map(f => path.relative(projectPath, f).replace(/\\/g, '/'))
    .filter(Boolean);

  if (!relFiles.length) return;

  // Build a commit message from the first 60 chars of the user's request
  const summary = userMessage
    .replace(/\n+/g, ' ')
    .replace(/"/g, "'")
    .trim()
    .slice(0, 60);
  const commitMsg = `GABy: ${summary}`;

  try {
    // Stage only the files that were changed (not the whole working tree)
    const quotedFiles = relFiles.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    await sendToBridge(userId, 'exec:shell', {
      command: `git add -- ${quotedFiles}`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 10_000);

    // Commit — use inline config so no global git identity is required
    await sendToBridge(userId, 'exec:shell', {
      command: `git -c user.email="gaby@ai" -c user.name="GABy" commit -m "${commitMsg}" --no-verify`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 10_000);

    console.log(`[git] auto-committed ${relFiles.length} file(s): "${commitMsg}"`);
  } catch (err) {
    // Non-fatal — "nothing to commit" also throws, which is fine
    const msg = (err as Error).message || '';
    if (!msg.includes('nothing to commit') && !msg.includes('nothing added')) {
      console.warn('[git] auto-commit failed:', msg.slice(0, 200));
    }
  }
}

/**
 * Return the short git log (last N commits) for display in the UI.
 * Returns empty string if not a git repo or on any error.
 */
export async function gitLog(
  userId: number,
  projectPath: string,
  n = 10,
): Promise<string> {
  if (!(await isGitRepo(userId, projectPath))) return '';
  try {
    return await sendToBridge(userId, 'exec:shell', {
      command: `git log --oneline -${n}`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 5_000) as string;
  } catch {
    return '';
  }
}

// ── Checkpoints ────────────────────────────────────────────────────────────────

const CHECKPOINT_PREFIX = 'GABy checkpoint:';

/**
 * Stage all current changes and create a git commit as a snapshot.
 * Called at the START of each agent turn, before any file edits.
 * Safe to call even if nothing changed (--allow-empty).
 */
export async function createCheckpoint(
  userId: number,
  projectPath: string,
  label: string,
): Promise<void> {
  if (!(await isGitRepo(userId, projectPath))) return;
  try {
    const safeLabel = label.slice(0, 72).replace(/"/g, "'");
    const msg = `${CHECKPOINT_PREFIX} ${safeLabel}`;
    await sendToBridge(userId, 'exec:shell', {
      command: `git add -A`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 8_000);
    await sendToBridge(userId, 'exec:shell', {
      command: `git -c user.email="gaby@ai" -c user.name="GABy" commit --allow-empty -m "${msg}" --no-verify`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 10_000);
    console.log(`[git] checkpoint created: "${msg}"`);
  } catch (err) {
    console.warn('[git] createCheckpoint failed:', (err as Error).message?.slice(0, 200));
  }
}

export interface CheckpointEntry {
  sha: string;
  message: string;
  date: string;
}

/**
 * List recent checkpoints (commits with the GABy checkpoint prefix).
 */
export async function listCheckpoints(
  userId: number,
  projectPath: string,
  limit = 20,
): Promise<CheckpointEntry[]> {
  if (!(await isGitRepo(userId, projectPath))) return [];
  try {
    const raw = await sendToBridge(userId, 'exec:shell', {
      command: `git log --oneline --format="%H|||%s|||%ci" -${limit * 3}`,
      cwd: projectPath,
      requiresConfirmation: false,
    }, 5_000) as string;
    const entries: CheckpointEntry[] = [];
    for (const line of raw.split('\n')) {
      const parts = line.split('|||');
      if (parts.length < 2) continue;
      const [sha, message, date = ''] = parts;
      if (message?.includes(CHECKPOINT_PREFIX)) {
        entries.push({ sha: sha.trim(), message: message.trim(), date: date.trim() });
        if (entries.length >= limit) break;
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Roll back the project to a specific checkpoint commit.
 * Uses `git reset --hard` — destructive, confirms via requiresConfirmation.
 */
export async function rollbackToCheckpoint(
  userId: number,
  projectPath: string,
  sha: string,
): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('Invalid SHA');
  if (!(await isGitRepo(userId, projectPath))) throw new Error('Not a git repo');
  await sendToBridge(userId, 'exec:shell', {
    command: `git reset --hard ${sha}`,
    cwd: projectPath,
    requiresConfirmation: false,
  }, 15_000);
  console.log(`[git] rolled back to ${sha}`);
}
