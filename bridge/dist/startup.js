"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.installStartup = installStartup;
exports.removeStartup = removeStartup;
exports.isStartupInstalled = isStartupInstalled;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
/**
 * Register or remove the SUNy Bridge as a startup task.
 * Windows: Creates a VBS script in the Startup folder.
 * Linux/Mac: Creates a crontab @reboot entry.
 */
function getStartupScriptPath() {
    if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SUNyBridge.vbs');
    }
    return path.join(os.homedir(), '.suny', 'startup.sh');
}
/**
 * Returns the absolute path to the currently running bridge entry script.
 * Works both in dev (ts-node) and production (compiled dist/index.js).
 */
function getBridgeEntryPath() {
    // process.argv[1] is the absolute path of the running script
    // e.g. /usr/lib/node_modules/suny-bridge/dist/index.js
    // or C:\Users\user\AppData\Roaming\npm\node_modules\suny-bridge\dist\index.js
    if (process.argv[1]) {
        return path.resolve(process.argv[1]);
    }
    // Fallback: use __dirname + 'index.js'
    return path.join(__dirname, 'index.js');
}
function getVbsContent() {
    const bridgeEntry = getBridgeEntryPath();
    return `' SUNy Bridge — hidden startup launcher
' Installed automatically on first connection.
' The bridge reads ~/.suny/config.json for token/server.

Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
cmd = "node """ + "${bridgeEntry.replace(/\\/g, '\\\\')}""" + " --silent"
shell.Run cmd, 0, False
Set shell = Nothing
`;
}
function getShContent() {
    const bridgeEntry = getBridgeEntryPath();
    return `#!/bin/bash
# SUNy Bridge — auto-start launcher
cd "${path.dirname(bridgeEntry)}"
node "${bridgeEntry}" --silent &
`;
}
function installStartup() {
    try {
        if (process.platform === 'win32') {
            const scriptPath = getStartupScriptPath();
            const vbs = getVbsContent();
            fs.writeFileSync(scriptPath, vbs, 'utf8');
            return true;
        }
        else {
            // Linux/Mac
            const scriptPath = getStartupScriptPath();
            fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
            fs.writeFileSync(scriptPath, getShContent(), 'utf8');
            fs.chmodSync(scriptPath, 0o755);
            const cronLine = `@reboot ${scriptPath}`;
            const existingCron = (0, child_process_1.execSync)('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
            if (!existingCron.includes(cronLine)) {
                const newCron = existingCron.trim() + '\n' + cronLine + '\n';
                (0, child_process_1.execSync)(`echo "${newCron}" | crontab -`);
            }
            return true;
        }
    }
    catch {
        return false;
    }
}
function removeStartup() {
    try {
        if (process.platform === 'win32') {
            const scriptPath = getStartupScriptPath();
            if (fs.existsSync(scriptPath)) {
                fs.unlinkSync(scriptPath);
            }
            return true;
        }
        else {
            const scriptPath = getStartupScriptPath();
            const cronLine = `@reboot ${scriptPath}`;
            try {
                const existingCron = (0, child_process_1.execSync)('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
                const filteredCron = existingCron.split('\n').filter((line) => !line.includes(cronLine)).join('\n') + '\n';
                (0, child_process_1.execSync)(`echo "${filteredCron}" | crontab -`);
            }
            catch { /* ignore */ }
            if (fs.existsSync(scriptPath)) {
                fs.unlinkSync(scriptPath);
            }
            return true;
        }
    }
    catch {
        return false;
    }
}
function isStartupInstalled() {
    try {
        const scriptPath = getStartupScriptPath();
        return fs.existsSync(scriptPath);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=startup.js.map