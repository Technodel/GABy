/**
 * SUNy Full Test Runner v2
 * 1. Logs in
 * 2. Starts bridge IN-PROCESS (provides file access to SUNy server)
 * 3. Runs the task test suite
 * 4. Reports results
 * 
 * Usage: node run-full-test.js
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const { SunyBridge } = require(path.join(__dirname, '..', 'bridge', 'dist', 'bridge.js'));

const HOST = process.env.SUNY_HOST || 'suny.technodel.tech';
const USERNAME = process.env.SUNY_USER || 'test';
const PASSWORD = process.env.SUNY_PASS || 'test';

function login() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ username: USERNAME, password: PASSWORD });
    const req = https.request({
      hostname: HOST,
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      rejectUnauthorized: false,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        const tokenCookie = cookies.find(c => c.startsWith('suny_token='));
        const token = tokenCookie ? tokenCookie.split(';')[0].replace('suny_token=', '') : null;
        if (!token) { reject(new Error('No token: ' + body.substring(0, 200))); return; }
        resolve({ token, ...JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     SUNy Full Test Runner v2              ║');
  console.log(`║     ${new Date().toISOString().slice(0, 19).replace('T', ' ')}          ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Step 1: Login
  console.log('[1/3] 🔑 Logging in as test/test...');
  const loginResult = await login();
  console.log(`  ✅ User ID: ${loginResult.userId}`);

  // Step 2: Start bridge (provides file access to the server)
  console.log('[2/3] 🌉 Starting bridge (connecting to SUNy server)...');
  const wsHost = (process.env.SUNY_WS_HOST || `wss://${HOST}`);
const bridge = new SunyBridge(loginResult.token, wsHost, { silent: false });
  bridge.start();
  
  // Wait for bridge to connect
  await new Promise(r => setTimeout(r, 4000));
  console.log('  ✅ Bridge started');

  // Step 3: Run test suite
  console.log('[3/3] 🧪 Running task execution test suite...');
  console.log('');
  
  // Patch credentials in test script
  const testScriptPath = path.join(__dirname, 'suny-task-test.js');
  let testScript = fs.readFileSync(testScriptPath, 'utf-8');
  testScript = testScript.replace("const USERNAME = 'testbench';", `const USERNAME = '${USERNAME}';`);
  testScript = testScript.replace("const PASSWORD = 'testbench123';", `const PASSWORD = '${PASSWORD}';`);
  
  const patchedPath = path.join(__dirname, 'suny-task-test-patched.js');
  fs.writeFileSync(patchedPath, testScript);
  
  // Run patched test suite as subprocess
  const { spawn } = require('child_process');
  const testProcess = spawn('node', [patchedPath], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  
  testProcess.on('exit', (code) => {
    console.log('');
    console.log('[cleanup] Stopping bridge...');
    bridge.stop();
    
    // Read and display results
    try {
      const resultsPath = path.join(__dirname, 'suny-task-results.json');
      if (fs.existsSync(resultsPath)) {
        const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
        const total = results.tasks.length;
        const passed = results.tasks.filter(t => t.pass).length;
        const partial = results.tasks.filter(t => t.score === 0.5).length;
        const score = total > 0 ? (results.tasks.reduce((s, t) => s + t.score, 0) / total * 100).toFixed(1) : 0;
        
        console.log('');
        console.log('╔══════════════════════════════════════════╗');
        console.log(`║  RESULTS: ${passed}/${total} passed (${partial} partial) — ${score}%     ║`);
        console.log('╚══════════════════════════════════════════╝');
        
        // List failed tasks
        const failed = results.tasks.filter(t => !t.pass && t.score === 0);
        if (failed.length > 0) {
          console.log('');
          console.log('Failed tasks:');
          failed.forEach(t => {
            console.log(`  ❌ [${t.category}] ${t.title}`);
            console.log(`     Error: ${t.errorCategory || 'unknown'}`);
            console.log(`     Tool calls: ${t.toolCalls}`);
          });
        }
      }
    } catch (e) {
      console.log(`[runner] Could not read results: ${e.message}`);
    }
    
    console.log('');
    console.log('[runner] Done.');
    process.exit(code || 0);
  });
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
