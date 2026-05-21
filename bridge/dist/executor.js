"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleExec = handleExec;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const sandbox_1 = require("./sandbox");
const process_manager_1 = require("./process-manager");
/**
 * Handle all exec:* instructions from the VPS server.
 * All file operations are sandboxed to registered project directories.
 * All commands are run via spawn() with arg arrays — never exec() with raw strings.
 */
async function handleExec(type, id, payload, send) {
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
    }
    catch (err) {
        const msg = err instanceof sandbox_1.SandboxError
            ? err.message
            : 'Operation failed';
        send({ type: 'bridge:error', id, payload: { message: msg } });
    }
}
async function execReadFile(id, payload, send) {
    const filePath = payload.path;
    (0, sandbox_1.validatePath)(filePath);
    const content = fs_1.default.readFileSync(filePath, 'utf8');
    send({ type: 'bridge:file_content', id, payload: { content, encoding: 'utf8' } });
}
async function execWriteFile(id, payload, send) {
    const filePath = payload.path;
    const content = payload.content;
    (0, sandbox_1.validatePath)(filePath);
    fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
    fs_1.default.writeFileSync(filePath, content, 'utf8');
    send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
}
async function execMkdir(id, payload, send) {
    const dirPath = payload.path;
    (0, sandbox_1.validatePath)(dirPath);
    fs_1.default.mkdirSync(dirPath, { recursive: true });
    send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
}
async function execDeleteFile(id, payload, send) {
    const filePath = payload.path;
    (0, sandbox_1.validatePath)(filePath);
    if (fs_1.default.existsSync(filePath)) {
        const stat = fs_1.default.statSync(filePath);
        if (stat.isDirectory()) {
            fs_1.default.rmSync(filePath, { recursive: true, force: true });
        }
        else {
            fs_1.default.unlinkSync(filePath);
        }
    }
    send({ type: 'bridge:done', id, payload: { exitCode: 0, success: true } });
}
async function execListDir(id, payload, send) {
    const dirPath = payload.path;
    (0, sandbox_1.validatePath)(dirPath);
    const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true }).map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
    }));
    send({ type: 'bridge:done', id, payload: { entries, exitCode: 0, success: true } });
}
async function execPathExists(id, payload, send) {
    const targetPath = payload.path;
    (0, sandbox_1.validatePath)(targetPath);
    send({ type: 'bridge:done', id, payload: { exists: fs_1.default.existsSync(targetPath), exitCode: 0, success: true } });
}
function runExecFile(file, args) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)(file, args, { windowsHide: true }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(String(stdout || '').trim());
        });
    });
}
async function pickFolderPath() {
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
    const linuxPickers = [
        { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Choose a folder for your project'] },
        { cmd: 'kdialog', args: ['--getexistingdirectory', '--title', 'Choose a folder for your project'] },
    ];
    for (const picker of linuxPickers) {
        try {
            const picked = await runExecFile(picker.cmd, picker.args);
            if (picked)
                return picked;
        }
        catch {
            // Try next picker.
        }
    }
    return null;
}
async function execPickFolder(id, send) {
    const picked = await pickFolderPath();
    if (!picked) {
        send({ type: 'bridge:error', id, payload: { message: 'No folder selected' } });
        return;
    }
    send({ type: 'bridge:done', id, payload: { path: picked, exitCode: 0, success: true } });
}
async function execShell(id, payload, send) {
    const cwd = payload.cwd;
    const command = payload.command;
    const requiresConfirmation = payload.requiresConfirmation;
    const timeoutMs = payload.timeout || 120000; // default 2 min local fallback
    (0, sandbox_1.validatePath)(cwd);
    (0, sandbox_1.validateCommand)(command, requiresConfirmation);
    // Parse command into cmd + args safely (no shell, respects quotes)
    const parsed = parseShellCommand(command);
    const cmd = parsed.command;
    const args = parsed.args;
    send({ type: 'bridge:ack', id });
    process_manager_1.processManager.spawn(id, cmd, args, cwd, (line, stream) => send({ type: 'bridge:stream', id, payload: { line, stream } }), (exitCode) => send({ type: 'bridge:done', id, payload: { exitCode, success: exitCode === 0 } }));
    // Local timeout: if the server-side timeout fails to reach us (e.g. reconnect),
    // kill the process locally so it doesn't hang forever.
    setTimeout(() => {
        if (process_manager_1.processManager.isRunning(id)) {
            process_manager_1.processManager.kill(id);
            send({ type: 'bridge:error', id, payload: { message: `Command timed out after ${timeoutMs / 1000}s` } });
        }
    }, timeoutMs);
}
async function execStartDevServer(id, payload, send) {
    const cwd = payload.cwd;
    const command = payload.command;
    const readySignal = payload.readySignal || 'Local:';
    (0, sandbox_1.validatePath)(cwd);
    (0, sandbox_1.validateCommand)(command);
    const parsed = parseShellCommand(command);
    const cmd = parsed.command;
    const args = parsed.args;
    send({ type: 'bridge:ack', id });
    let serverReady = false;
    process_manager_1.processManager.spawn(id, cmd, args, cwd, (line, stream) => {
        send({ type: 'bridge:stream', id, payload: { line, stream } });
        if (!serverReady && line.includes(readySignal)) {
            serverReady = true;
            send({ type: 'bridge:server_ready', id });
        }
    }, (exitCode) => {
        if (!serverReady) {
            send({ type: 'bridge:server_crashed', id, payload: { error: `Exited with code ${exitCode}` } });
        }
        send({ type: 'bridge:done', id, payload: { exitCode, success: exitCode === 0 } });
    });
    // Timeout
    const timeoutSeconds = payload.timeoutSeconds || 30;
    setTimeout(() => {
        if (!serverReady) {
            process_manager_1.processManager.kill(id);
            send({ type: 'bridge:server_crashed', id, payload: { error: 'Startup timeout' } });
        }
    }, timeoutSeconds * 1000);
}
function execKill(id, payload, send) {
    const processId = payload.processId;
    const killed = process_manager_1.processManager.kill(processId);
    send({ type: 'bridge:done', id, payload: { killed, exitCode: 0, success: true } });
}
/**
 * Parse a shell command string into command + args array, respecting quoted arguments.
 * Handles double quotes ("), single quotes ('), and escaped characters.
 * This prevents shell injection while properly handling spaces in arguments like paths.
 */
function parseShellCommand(input) {
    const args = [];
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
//# sourceMappingURL=executor.js.map