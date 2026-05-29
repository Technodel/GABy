import fs from 'fs';
import path from 'path';
import { execFile, exec } from 'child_process';
import { processManager } from './process-manager';

export async function executeLocal(userId: number, type: string, payload: Record<string, any>, timeout?: number): Promise<any> {
  try {
    switch (type) {
      case 'exec:read_file':
        return fs.readFileSync(payload.path, 'utf8');
      case 'exec:write_file':
        fs.mkdirSync(path.dirname(payload.path), { recursive: true });
        fs.writeFileSync(payload.path, payload.content, 'utf8');
        return { success: true };
      case 'exec:mkdir':
        fs.mkdirSync(payload.path, { recursive: true });
        return { success: true };
      case 'exec:delete_file':
        if (fs.existsSync(payload.path)) {
          const stat = fs.statSync(payload.path);
          if (stat.isDirectory()) fs.rmSync(payload.path, { recursive: true, force: true });
          else fs.unlinkSync(payload.path);
        }
        return { success: true };
      case 'exec:list_dir':
        const entries = fs.readdirSync(payload.path, { withFileTypes: true }).map(e => ({
          name: e.name,
          isDirectory: e.isDirectory(),
        }));
        return { entries, success: true };
      case 'exec:path_exists':
        return { exists: fs.existsSync(payload.path), success: true };
      case 'exec:shell':
        return new Promise((resolve, reject) => {
          exec(payload.command, { cwd: payload.cwd, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
            resolve({
              exitCode: err ? (err as any).code || 1 : 0,
              success: !err,
              output: stdout + (stderr ? '\n' + stderr : '')
            });
          });
        });
      default:
        throw new Error(`Unknown instruction type: ${type}`);
    }
  } catch (err: any) {
    throw new Error(err.message);
  }
}

export async function executeLocalWithNarration(userId: number, type: string, payload: Record<string, any>, action: string, data: any, timeout?: number) {
  return executeLocal(userId, type, payload, timeout);
}

export async function executeLocalBackground(userId: number, command: string, cwd: string, readySignal?: string, timeoutSeconds?: number) {
  return new Promise<any>((resolve) => {
    const id = Date.now().toString();
    let ready = false;
    processManager.spawn(
      id,
      command.split(' ')[0],
      command.split(' ').slice(1),
      cwd,
      (line, stream) => {
        if (!ready && readySignal && line.includes(readySignal)) {
          ready = true;
          resolve({ status: 'running', processId: id, output: 'Server ready.' });
        }
      },
      (exitCode) => {
        if (!ready) resolve({ status: 'exited', processId: id, output: `Exited with code ${exitCode}` });
      },
      userId,
      cwd
    );
    if (!readySignal) {
      setTimeout(() => resolve({ status: 'running', processId: id, output: 'Started.' }), 1000);
    }
  });
}

export async function stopBackgroundProcess(userId: number, processId: string) {
  return processManager.kill(processId);
}

export function readBackgroundLogs(userId: number, processId: string, lines: number) {
  return { found: true, logs: 'Logs not available in local mock.', status: 'running', command: 'unknown' };
}

export function listBackgroundProcesses(userId: number) {
  return [];
}
