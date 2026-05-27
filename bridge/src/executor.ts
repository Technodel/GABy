import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { validatePath, validateCommand, SandboxError } from './sandbox';
import { processManager } from './process-manager';

type SendFn = (msg: Record<string, unknown>) => void;

/**
 * Handle all exec:* instructions from the VPS server.
 * All file operations are sandboxed to registered project directories.
 * All commands are run via spawn() with arg arrays — never exec() with raw strings.
 */
export async function handleExec(
  type: string,
  id: string,
  payload: Record<string, unknown>,
  send: SendFn
): Promise<void> {
  try {
    switch (type) {
      case 'exec:read_file':
        await execReadFile(id, payload, send);
        break;
      case 'exec:write_file':
        await execWriteFile(id, payload, send);
        break;
      case 'exec:mkdir':
        await execMkdir(id, payload, send);
        break;
      case 'exec:delete_file':
        await execDeleteFile(id, payload, send);
        break;
      case 'exec:list_dir':
        await execListDir(id, payload, send);
        break;
      case 'exec:path_exists':
        await execPathExists(id, payload, send);
        break;
      case 'exec:pick_folder':
        await execPickFolder(id, send);
        break;
      case 'exec:shell':
        await execShell(id, payload, send);
        break;
      case 'exec:run_tests':
        await execShell(id, payload, send);
        break;
      case 'exec:start_dev_server':
        await execStartDevServer(id, payload, send);
        break;
      case 'exec:kill':
        execKill(id, payload, send);
        break;
      default:
        send({ type: 'bridge:error', id, payload: { message: `Unknown instruction type: ${type}` } });
    }
  } catch (err) {
    const msg = err instanceof SandboxError
      ? err.message
      : 'Operation failed';
    send({ type: 'bridge:error', id, payload: { message: msg } });
  }
}

async function execReadFile(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const filePath = payload.path as string;
  validatePath(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  send({ type: 'bridge:file_content', id, payload: { content, encoding: 'utf8' } });
}

async function execWriteFile(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const filePath = payload.path as string;
  const content = payload.content as string;
  validatePath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
}

async function execMkdir(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const dirPath = payload.path as string;
  validatePath(dirPath);
  fs.mkdirSync(dirPath, { recursive: true });
  send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
}

async function execDeleteFile(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const filePath = payload.path as string;
  validatePath(filePath);
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
  }
  send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
}

async function execListDir(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const dirPath = payload.path as string;
  validatePath(dirPath);
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map(e => ({
    name: e.name,
    isDirectory: e.isDirectory(),
  }));
  send({ type: 'bridge:done', id, payload: { entries, exitCode: 0, success: true } });
}

async function execPathExists(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const targetPath = payload.path as string;
  validatePath(targetPath);
  send({ type: 'bridge:done', id, payload: { exists: fs.existsSync(targetPath), exitCode: 0, success: true } });
}

function runExecFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function pickFolderPath(): Promise<string | null> {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = 'Choose a folder for your project'",
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
    ].join('; ');
    const picked = await runExecFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
    return picked || null;
  }

  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "Choose a folder for your project")';
    const picked = await runExecFile('osascript', ['-e', script]);
    return picked || null;
  }

  const linuxPickers: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Choose a folder for your project'] },
    { cmd: 'kdialog', args: ['--getexistingdirectory', '--title', 'Choose a folder for your project'] },
  ];

  for (const picker of linuxPickers) {
    try {
      const picked = await runExecFile(picker.cmd, picker.args);
      if (picked) return picked;
    } catch {
      // Try next picker.
    }
  }

  return null;
}

async function execPickFolder(id: string, send: SendFn): Promise<void> {
  const picked = await pickFolderPath();
  if (!picked) {
    send({ type: 'bridge:error', id, payload: { message: 'No folder selected' } });
    return;
  }
  send({ type: 'bridge:done', id, payload: { path: picked, exitCode: 0, success: true } });
}

async function execShell(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const cwd = payload.cwd as string;
  const command = payload.command as string;
  const requiresConfirmation = payload.requiresConfirmation as boolean | undefined;
  const timeoutMs = (payload.timeout as number) || 120_000;  // default 2 min local fallback

  validatePath(cwd);
  validateCommand(command, requiresConfirmation);

  // Parse command into cmd + args safely (no shell, respects quotes)
  const parsed = parseShellCommand(command);
  const cmd = parsed.command;
  const args = parsed.args;

  send({ type: 'bridge:ack', id });

  processManager.spawn(
    id,
    cmd,
    args,
    cwd,
    (line, stream) => send({ type: 'bridge:stream', id, payload: { line, stream } }),
    (exitCode) => send({ type: 'bridge:done', id, payload: { exitCode, success: exitCode === 0 } })
  );

  // Local timeout: if the server-side timeout fails to reach us (e.g. reconnect),
  // kill the process locally so it doesn't hang forever.
  setTimeout(() => {
    if (processManager.isRunning(id)) {
      processManager.kill(id);
      send({ type: 'bridge:error', id, payload: { message: `Command timed out after ${timeoutMs / 1000}s` } });
    }
  }, timeoutMs);
}

async function execStartDevServer(id: string, payload: Record<string, unknown>, send: SendFn): Promise<void> {
  const cwd = payload.cwd as string;
  const command = payload.command as string;
  const readySignal = (payload.readySignal as string) || 'Local:';

  validatePath(cwd);
  validateCommand(command);

  const parsed = parseShellCommand(command);
  const cmd = parsed.command;
  const args = parsed.args;

  send({ type: 'bridge:ack', id });

  let serverReady = false;

  processManager.spawn(
    id,
    cmd,
    args,
    cwd,
    (line, stream) => {
      send({ type: 'bridge:stream', id, payload: { line, stream } });
      if (!serverReady && line.includes(readySignal)) {
        serverReady = true;
        send({ type: 'bridge:server_ready', id });
      }
    },
    (exitCode) => {
      if (!serverReady) {
        send({ type: 'bridge:server_crashed', id, payload: { error: `Exited with code ${exitCode}` } });
      }
      send({ type: 'bridge:done', id, payload: { exitCode, success: exitCode === 0 } });
    }
  );

  // Timeout
  const timeoutSeconds = (payload.timeoutSeconds as number) || 30;
  setTimeout(() => {
    if (!serverReady) {
      processManager.kill(id);
      send({ type: 'bridge:server_crashed', id, payload: { error: 'Startup timeout' } });
    }
  }, timeoutSeconds * 1000);
}

function execKill(id: string, payload: Record<string, unknown>, send: SendFn): void {
  const processId = payload.processId as string;
  const killed = processManager.kill(processId);
  send({ type: 'bridge:done', id, payload: { killed, exitCode: 0, success: true } });
}

/**
 * Parse a shell command string into command + args array, respecting quoted arguments.
 * Handles double quotes ("), single quotes ('), and escaped characters.
 * This prevents shell injection while properly handling spaces in arguments like paths.
 */
function parseShellCommand(input: string): { command: string; args: string[] } {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inDouble) {
      escapeNext = true;
      continue;
    }

    if (ch === '\\' && !inSingle && !inDouble) {
      // On Windows, backslash is a path separator, not an escape character
      // Only treat it as escape if followed by a quote or space
      const nextChar = input[i + 1];
      if (process.platform === 'win32' && nextChar && !/[\s'"]/.test(nextChar)) {
        current += ch; // Preserve backslash for Windows paths like C:\Users
        continue;
      }
      escapeNext = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return {
    command: args[0] || '',
    args: args.slice(1),
  };
}
