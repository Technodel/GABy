import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Register or remove the SUNy Bridge as a startup task.
 * Windows: Creates a VBS script in the Startup folder.
 * Linux/Mac: Creates a crontab @reboot entry.
 */

function getStartupScriptPath(): string {
  if (process.platform === 'win32') {
    return path.join(
      os.homedir(),
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SUNyBridge.vbs',
    );
  }
  return path.join(os.homedir(), '.suny', 'startup.sh');
}

/**
 * Returns the absolute path to the currently running bridge entry script.
 * Works both in dev (ts-node) and production (compiled dist/index.js).
 */
function getBridgeEntryPath(): string {
  // process.argv[1] is the absolute path of the running script
  // e.g. /usr/lib/node_modules/suny-bridge/dist/index.js
  // or C:\Users\user\AppData\Roaming\npm\node_modules\suny-bridge\dist\index.js
  if (process.argv[1]) {
    return path.resolve(process.argv[1]);
  }
  // Fallback: use __dirname + 'index.js'
  return path.join(__dirname, 'index.js');
}

function getVbsContent(): string {
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

function getShContent(): string {
  const bridgeEntry = getBridgeEntryPath();
  return `#!/bin/bash
# SUNy Bridge — auto-start launcher
cd "${path.dirname(bridgeEntry)}"
node "${bridgeEntry}" --silent &
`;
}

export function installStartup(): boolean {
  try {
    if (process.platform === 'win32') {
      const scriptPath = getStartupScriptPath();
      const vbs = getVbsContent();
      fs.writeFileSync(scriptPath, vbs, 'utf8');
      return true;
    } else {
      // Linux/Mac
      const scriptPath = getStartupScriptPath();
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, getShContent(), 'utf8');
      fs.chmodSync(scriptPath, 0o755);

      const cronLine = `@reboot ${scriptPath}`;
      const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
      if (!existingCron.includes(cronLine)) {
        const newCron = existingCron.trim() + '\n' + cronLine + '\n';
        execSync(`echo "${newCron}" | crontab -`);
      }
      return true;
    }
  } catch {
    return false;
  }
}

export function removeStartup(): boolean {
  try {
    if (process.platform === 'win32') {
      const scriptPath = getStartupScriptPath();
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
      return true;
    } else {
      const scriptPath = getStartupScriptPath();
      const cronLine = `@reboot ${scriptPath}`;
      try {
        const existingCron = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });
        const filteredCron = existingCron.split('\n').filter((line: string) => !line.includes(cronLine)).join('\n') + '\n';
        execSync(`echo "${filteredCron}" | crontab -`);
      } catch { /* ignore */ }
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
      return true;
    }
  } catch {
    return false;
  }
}

export function isStartupInstalled(): boolean {
  try {
    const scriptPath = getStartupScriptPath();
    return fs.existsSync(scriptPath);
  } catch {
    return false;
  }
}
