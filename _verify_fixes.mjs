// Quick syntax verification of all modified files
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const files = [
  'src/server/auth.ts',
  'src/server/bridge-onboarding.ts',
  'src/server/agent-loop.ts',
  'src/server/power-tools.ts',
  'src/server/loop-detector.ts',
  'src/server/context-manager.ts',
  'src/server/index.ts'
];

const projectRoot = path.resolve('.');

let allOk = true;
for (const f of files) {
  const fullPath = path.join(projectRoot, f);
  if (!fs.existsSync(fullPath)) {
    console.log(`MISSING: ${f}`);
    allOk = false;
    continue;
  }
  
  const src = fs.readFileSync(fullPath, 'utf8');
  const result = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: false,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true
    },
    reportDiagnostics: true
  });
  
  if (result.diagnostics && result.diagnostics.length > 0) {
    console.log(`SYNTAX ISSUES in ${f}:`);
    result.diagnostics.forEach(d => {
      if (d.file) {
        const pos = d.file.getLineAndCharacterOfPosition(d.start || 0);
        console.log(`  Line ${pos.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
      }
    });
    allOk = false;
  } else {
    console.log(`✓ ${f}`);
  }
}

// Also test requiring a few key modules
console.log('\n--- Testing module resolution ---');
try {
  require('./src/server/auth');
  console.log('✓ auth module resolves');
} catch (e) {
  // Expected to fail at runtime without DB, but should resolve
  console.log(`→ auth module: ${e.message}`);
}

console.log('\n' + (allOk ? 'ALL FILES OK' : 'SOME FILES HAVE ISSUES'));
