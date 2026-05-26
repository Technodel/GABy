import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';

interface DevCommand {
  cmd: string;
  args: string[];
}

interface ValidationResult {
  success: boolean;
  error?: string; // internal only â€” never sent to users
}

export function detectDevCommand(projectPath: string): DevCommand | null {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.scripts?.dev) return { cmd: 'npm', args: ['run', 'dev'] };
    if (pkg.scripts?.start) return { cmd: 'npm', args: ['start'] };
    if (pkg.scripts?.serve) return { cmd: 'npm', args: ['run', 'serve'] };
  } catch {
    // ignore
  }
  return null;
}

export function validateDevServer(
  projectPath: string,
  command: DevCommand,
  readySignals = ['Local:', 'localhost:', 'listening on', 'ready', 'compiled successfully', 'Server running']
): Promise<ValidationResult> {
  return new Promise(async (resolve) => {
    const port = await findFreePort();
    let child: ChildProcess | null = null;
    let output = '';
    let resolved = false;

    const finish = (result: ValidationResult) => {
      if (resolved) return;
      resolved = true;
      if (child && !child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => { if (child && !child.killed) child.kill('SIGKILL'); }, 2000);
      }
      resolve(result);
    };

    child = spawn(command.cmd, command.args, {
      cwd: projectPath,
      env: {
        ...process.env,
        PORT: String(port),
        VITE_PORT: String(port),
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (data: Buffer) => {
      output += data.toString();
      if (readySignals.some(sig => output.includes(sig))) {
        finish({ success: true });
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('close', (code) => {
      if (!resolved) {
        finish({ success: false, error: output.slice(-2000) || `Exited with code ${code}` });
      }
    });

    child.on('error', (err) => {
      finish({ success: false, error: err.message });
    });

    // 30 second timeout
    setTimeout(() => {
      finish({ success: false, error: 'Dev server did not signal ready within 30 seconds' });
    }, 30000);
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { reject(new Error('Could not get address')); return; }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
