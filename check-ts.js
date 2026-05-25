const ts = require('typescript');
const program = ts.createProgram(['src/server/ws-handler.ts'], { 
  noEmit: true, 
  target: ts.ScriptTarget.ES2022, 
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  esModuleInterop: true,
  strict: false 
});
const diagnostics = ts.getPreEmitDiagnostics(program);
diagnostics.forEach(d => {
  if (d.file && d.file.fileName.endsWith('ws-handler.ts')) {
    if (d.code === 2304) { // Cannot find name
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      console.log(`Line ${pos.line + 1}: ${d.messageText}`);
    }
  }
});
console.log('Done checking ws-handler.ts');
