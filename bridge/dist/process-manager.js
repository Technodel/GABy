"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processManager = void 0;
const child_process_1 = require("child_process");
class ProcessManager {
    constructor() {
        this.processes = new Map();
    }
    /**
     * Spawn a shell command, tracking it by id so it can be killed later.
     * Uses spawn() with arg arrays — never exec() with raw strings.
     */
    spawn(id, cmd, args, cwd, onData, onDone) {
        const isWindows = process.platform === 'win32';
        const isBatOrCmd = isWindows && (cmd.toLowerCase().endsWith('.bat') || cmd.toLowerCase().endsWith('.cmd'));
        const child = (0, child_process_1.spawn)(cmd, args, {
            cwd,
            shell: isBatOrCmd, // Use shell only for Windows batch files
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.processes.set(id, { process: child, cwd, command: cmd, startedAt: new Date() });
        child.stdout.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                if (line.trim())
                    onData(line, 'stdout');
            }
        });
        child.stderr.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                if (line.trim())
                    onData(line, 'stderr');
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
    kill(id) {
        const managed = this.processes.get(id);
        if (!managed)
            return false;
        managed.process.kill('SIGTERM');
        // Track that we're killing so SIGKILL can still fire
        const killTimeout = setTimeout(() => {
            // Re-check the map in case it was already cleaned up by 'close' event
            if (this.processes.has(id)) {
                try {
                    managed.process.kill('SIGKILL');
                }
                catch { /* process may already be dead */ }
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
    killAll() {
        for (const [id] of this.processes) {
            this.kill(id);
        }
    }
    isRunning(id) {
        return this.processes.has(id);
    }
}
exports.processManager = new ProcessManager();
//# sourceMappingURL=process-manager.js.map