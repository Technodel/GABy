/**
 * Wrapper that runs the SUNy Task Execution Test Suite.
 * 
 * Usage: node run-task-test-production.js
 * 
 * Prerequisites:
 *   1. The bridge client must be started first:
 *      node bridge\start-silent.js --token <TOKEN> --server wss://suny.technodel.tech
 *   2. Login to https://suny.technodel.tech as test/test to get a token
 * 
 * This wrapper automatically patches the test suite for the correct
 * test/test credentials and provides instructions for bridge setup.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const USERNAME = process.env.SUNY_USER || 'test';
const PASSWORD = process.env.SUNY_PASS || 'test';
const BRIDGE_SCRIPT = path.join(__dirname, 'bridge', 'start-silent.js');
const TEST_SCRIPT = path.join(__dirname, 'suny-task-test.js');

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║     SUNy Task Execution Test Suite Runner            ║');
console.log('║                                                     ║');
console.log(`║     User: ${USERNAME}/****                                ║`);
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

// Step 1: Check if bridge is already running
let bridgeProcess = null;
try {
  const result = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
  const bridgeRunning = result.includes('start-silent') || result.includes('bridge');
  if (bridgeRunning) {
    console.log('✅ Bridge process detected running on this machine');
  } else {
    console.log('⚠️  No bridge process detected. File operations will NOT work.');
    console.log('   To start the bridge, run: node bridge\\start-silent.js --token <YOUR_TOKEN>');
    console.log('');
  }
} catch {
  console.log('⚠️  Could not check bridge status. Continuing...');
}

// Step 2: Read the test script and patch credentials
let testScript = fs.readFileSync(TEST_SCRIPT, 'utf-8');
testScript = testScript.replace(
  /const USERNAME = 'testbench';/,
  `const USERNAME = '${USERNAME}';`
);
testScript = testScript.replace(
  /const PASSWORD = 'testbench123';/,
  `const PASSWORD = '${PASSWORD}';`
);

// Also update project path references if needed
testScript = testScript.replace(
  /const PROJECT_DIR = path\.join\(__dirname, 'task-exec-test'\);/,
  `const PROJECT_DIR = path.join(__dirname, 'task-exec-test');`
);
testScript = testScript.replace(
  /const TEMP_DIR = path\.join\(__dirname, 'task-exec-temp'\);/,
  `const TEMP_DIR = path.join(__dirname, 'task-exec-temp');`
);

// Write patched version
const patchedPath = path.join(__dirname, 'suny-task-test-patched.js');
fs.writeFileSync(patchedPath, testScript);
console.log(`✅ Patched test suite written to ${patchedPath}`);
console.log('');

// Step 3: Run the patched test
console.log('▶️  Starting test execution...');
console.log('');

try {
  require(patchedPath);
} catch (err) {
  console.error('❌ Test execution failed:', err.message);
  process.exit(1);
}
