#!/usr/bin/env node
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
const bridge_1 = require("./bridge");
const config_1 = require("./config");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
function parseArgs() {
    const args = process.argv.slice(2);
    const result = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--token' && args[i + 1])
            result.token = args[++i];
        else if (args[i] === '--code' && args[i + 1])
            result.code = args[++i];
        else if (args[i] === '--server' && args[i + 1])
            result.server = args[++i];
        else if (args[i] === '--register' && args[i + 1])
            result.register = args[++i];
        else if (args[i] === '--silent' || args[i] === '--background' || args[i] === '-s')
            result.silent = true;
        else if (args[i] === '--install-startup')
            result.installStartup = true;
        else if (args[i] === '--remove-startup')
            result.removeStartup = true;
    }
    return result;
}
// ── Auto-start helpers ──────────────────────────────────────────────────────
function getStartupScriptPath() {
    if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SUNyBridge.vbs');
    }
    return path.join(os.homedir(), '.suny', 'startup.sh');
}
function installStartup() {
    if (process.platform === 'win32') {
        const scriptPath = getStartupScriptPath();
        const bridgeIndex = path.join(__dirname, 'index.ts');
        const vbs = `' SUNy Bridge — hidden startup launcher
' Installed by: suny-bridge --install-startup
' The bridge reads ~/.suny/config.json for token/server.

Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
cmd = "node """ + bridgeIndex.replace(/\\/g, '\\\\') + """ --silent"
shell.Run cmd, 0, False
Set shell = Nothing
`;
        fs.writeFileSync(scriptPath, vbs, 'utf8');
        console.log(`✅ Bridge auto-start installed!`);
        console.log(`   Script: ${scriptPath}`);
        console.log(`   The bridge will auto-connect when you log in to Windows.`);
    }
    else {
        // Linux/Mac: create a shell script + crontab entry
        const scriptPath = getStartupScriptPath();
        const bridgeIndex = path.join(__dirname, 'index.ts');
        const sh = `#!/bin/bash
# SUNy Bridge — auto-start launcher
cd "${__dirname}"
node index.ts --silent &
`;
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
        fs.writeFileSync(scriptPath, sh, 'utf8');
        fs.chmodSync(scriptPath, 0o755);
        const cronLine = `@reboot ${scriptPath}`;
        try {
            const existingCron = (0, child_process_1.execSync)('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
            if (existingCron.includes(cronLine)) {
                console.log('✅ Bridge crontab entry already exists. Startup is set up.');
            }
            else {
                const newCron = existingCron.trim() + '\n' + cronLine + '\n';
                (0, child_process_1.execSync)(`echo "${newCron}" | crontab -`);
                console.log('✅ Bridge auto-start installed! (crontab @reboot)');
            }
        }
        catch (err) {
            console.log('✅ Startup script created. To enable auto-start, add to your crontab:');
            console.log(`   ${cronLine}`);
        }
    }
}
function removeStartup() {
    if (process.platform === 'win32') {
        const scriptPath = getStartupScriptPath();
        if (fs.existsSync(scriptPath)) {
            fs.unlinkSync(scriptPath);
            console.log('✅ Bridge auto-start removed.');
        }
        else {
            console.log('ℹ️  Bridge auto-start was not installed.');
        }
    }
    else {
        const scriptPath = getStartupScriptPath();
        const cronLine = `@reboot ${scriptPath}`;
        try {
            const existingCron = (0, child_process_1.execSync)('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
            const filteredCron = existingCron.split('\n').filter((line) => !line.includes(cronLine)).join('\n') + '\n';
            (0, child_process_1.execSync)(`echo "${filteredCron}" | crontab -`);
            console.log('✅ Bridge crontab entry removed.');
        }
        catch (err) {
            console.log('ℹ️  Could not update crontab:', err.message);
        }
        if (fs.existsSync(scriptPath)) {
            fs.unlinkSync(scriptPath);
        }
    }
}
function toHttpApiBase(server) {
    if (server.startsWith('wss://'))
        return `https://${server.slice(6)}`;
    if (server.startsWith('ws://'))
        return `http://${server.slice(5)}`;
    return server.replace(/\/$/, '');
}
async function redeemSetupCode(server, code) {
    const apiBase = toHttpApiBase(server);
    const response = await fetch(`${apiBase}/api/bridge/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });
    let data = {};
    try {
        data = (await response.json());
    }
    catch {
        // Ignore JSON parse failures and fall back to status text below.
    }
    if (!response.ok || !data.token) {
        throw new Error(data.error || `Setup code activation failed (${response.status})`);
    }
    return data.token;
}
async function main() {
    const args = parseArgs();
    // Handle startup installation flags (no token needed)
    if (args.installStartup) {
        installStartup();
        return;
    }
    if (args.removeStartup) {
        removeStartup();
        return;
    }
    const config = (0, config_1.readConfig)();
    // Handle registration of a project directory
    if (args.register) {
        const { registerPath } = require('./config');
        registerPath(args.register);
        if (!args.silent)
            console.log(`[SUNy Bridge] Registered project directory: ${args.register}`);
        return;
    }
    // Persist token and server if provided
    if (args.token)
        (0, config_1.updateConfig)({ token: args.token });
    if (args.server)
        (0, config_1.updateConfig)({ server: args.server });
    let token = args.token || config.token;
    const server = args.server || config.server || 'wss://suny.technodel.tech';
    if (!token && args.code) {
        if (!args.silent)
            console.log('[SUNy Bridge] Redeeming setup code...');
        token = await redeemSetupCode(server, args.code);
        (0, config_1.updateConfig)({ token, server });
    }
    if (!token) {
        if (!args.silent) {
            console.error('[SUNy Bridge] No token provided. Run with --token <JWT> or --code <SETUP_CODE>');
            console.error('  Example: suny-bridge start --code SUNY-XXXXX-XXXXX --server wss://suny.technodel.tech');
        }
        process.exit(1);
    }
    const bridge = new bridge_1.SunyBridge(token, server, { silent: args.silent });
    process.on('SIGINT', () => {
        if (!args.silent)
            console.log('\n[SUNy Bridge] Shutting down...');
        bridge.stop();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        bridge.stop();
        process.exit(0);
    });
    if (!args.silent)
        console.log(`[SUNy Bridge] Starting — connecting to ${server}`);
    bridge.start();
}
main().catch((err) => {
    console.error('[SUNy Bridge] Startup failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
//# sourceMappingURL=index.js.map