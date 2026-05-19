// bridge/start-silent.js — Windows hidden window launcher
// Runs the bridge with --silent flag, no terminal window, no console output
const { spawn } = require('child_process');
const path = require('path');

// Forward all args plus --silent
const args = process.argv.slice(2);
if (!args.includes('--silent') && !args.includes('--background') && !args.includes('-s')) {
  args.push('--silent');
}

const child = spawn('node', [path.join(__dirname, 'src', 'index.ts'), ...args], {
  stdio: 'ignore',       // No console output
  detached: true,        // Run independently
  windowsHide: true,     // No terminal window on Windows
});

child.unref();           // Allow parent to exit independently
console.log(`Bridge started in silent mode (PID: ${child.pid})`);
