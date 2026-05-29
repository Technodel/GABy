import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

interface ManagedProcess {
  process: ChildProcess;
  cwd: string;
  command: string;
  userId?: number;
  projectPath?: string;
  startedAt: Date;
}

class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();

  /**
   * Spawn a shell command, tracking it by id so it can be killed later.
   * Uses spawn() with arg arrays — never exec() with raw strings.
   */
  spawn(
    id: string,
    cmd: string,
    args: string[],
    cwd: string,
    onData: (line: string, stream: 'stdout' | 'stderr') => void,
    onDone: (exitCode: number) => void,
    userId?: number,
    projectPath?: string
  ): void {
    const isWindows = process.platform === 'win32';
    const isBatOrCmd = isWindows && (cmd.toLowerCase().endsWith('.bat') || cmd.toLowerCase().endsWith('.cmd'));

    const child = spawn(cmd, args, {
      cwd,
      shell: isBatOrCmd ? 'powershell.exe' : false, // Bypass cmd.exe block by routing through PowerShell
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.processes.set(id, { process: child, cwd, command: cmd, userId, projectPath, startedAt: new Date() });

    child.stdout.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) onData(line, 'stdout');
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) {
          onData(line, 'stderr');
          // Watchdog Crash Detection
          const lower = line.toLowerCase();
          if (lower.includes('syntaxerror:') || lower.includes('typeerror:') || lower.includes('err_module_not_found') || lower.includes('[vite] internal server error') || lower.includes('fatal error:')) {
            this.emit('processCrash', { id, command: cmd, cwd, error: line.trim(), userId, projectPath });
          }
        }
      }
    });

    child.on('close', (code) => {
      this.processes.delete(id);
      onDone(code ?? 1);
    });

    child.on('error', (err) => {
      this.processes.delete(id);
      onData(`Error: ${err.message}`, 'stderr');
      onDone(1);
    });
  }

  kill(id: string): boolean {
    const managed = this.processes.get(id);
    if (!managed) return false;
    managed.process.kill('SIGTERM');
    // Track that we're killing so SIGKILL can still fire
    const killTimeout = setTimeout(() => {
      // Re-check the map in case it was already cleaned up by 'close' event
      if (this.processes.has(id)) {
        try { managed.process.kill('SIGKILL'); } catch { /* process may already be dead */ }
        this.processes.delete(id);
      }
    }, 3000);
    // Don't delete from map immediately — let 'close' event handle cleanup
    // But attach the timeout to the managed process for cleanup
    managed.process.once('close', () => {
      clearTimeout(killTimeout);
      this.processes.delete(id);
    });
    return true;
  }

  killAll(): void {
    for (const [id] of this.processes) {
      this.kill(id);
    }
  }

  isRunning(id: string): boolean {
    return this.processes.has(id);
  }

  getProcessInfo(id: string): { command: string; cwd: string; startedAt: Date; running: boolean; userId?: number; projectPath?: string } | null {
    const managed = this.processes.get(id);
    if (!managed) return null;
    return {
      command: managed.command,
      cwd: managed.cwd,
      startedAt: managed.startedAt,
      running: !managed.process.killed && managed.process.exitCode === null,
      userId: managed.userId,
      projectPath: managed.projectPath,
    };
  }

  listAll(userId?: number): Array<{ processId: string; status: string; command: string; startedAt: string }> {
    const result: Array<{ processId: string; status: string; command: string; startedAt: string }> = [];
    for (const [id, managed] of this.processes) {
      if (userId !== undefined && managed.userId !== userId) continue;
      result.push({
        processId: id,
        status: (!managed.process.killed && managed.process.exitCode === null) ? 'running' : 'exited',
        command: managed.command,
        startedAt: managed.startedAt.toISOString(),
      });
    }
    return result;
  }
}

export const processManager = new ProcessManager();
