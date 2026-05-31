const fs = require('fs');
const src = fs.readFileSync('src/server/session-manager.ts', 'utf-8');
const lines = src.split('\n');

// Find exact locations where balance changes between L999 and L2341
let bal = 0;
let inString = false, inTemplate = false, templateDepth = 0, inBlockComment = false;

for (let i = 998; i < 2340 && i < lines.length; i++) {
  const line = lines[i];
  let inLineComment = false;
  
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const next = j + 1 < line.length ? line[j+1] : '';
    
    if (!inString && !inTemplate && ch === '/' && next === '*' && !inLineComment) {
      inBlockComment = true; j++; continue;
    }
    if (inBlockComment && ch === '*' && next === '/') {
      inBlockComment = false; j++; continue;
    }
    if (inBlockComment) continue;
    
    if (!inString && !inTemplate && ch === '/' && next === '/' && !inLineComment) {
      inLineComment = true; break;
    }
    if (inLineComment) break;
    
    if (!inTemplate && (ch === '"' || ch === "'") && !inString) {
      inString = ch; continue;
    }
    if (inString === ch && !inTemplate) {
      let bs = 0, k = j - 1;
      while (k >= 0 && line[k] === '\\') { bs++; k--; }
      if (bs % 2 === 1) continue;
      inString = false; continue;
    }
    if (inString) continue;
    
    if (ch === '`' && !inTemplate) {
      inTemplate = true; continue;
    }
    if (ch === '`' && inTemplate && templateDepth === 0) {
      inTemplate = false; continue;
    }
    
    if (inTemplate) {
      if (ch === '$' && next === '{') {
        templateDepth++; j++; continue;
      }
      if (ch === '}') {
        if (templateDepth > 0) {
          templateDepth--;
        }
        continue;
      }
      if (ch === '{' && templateDepth > 0) {
        templateDepth++; continue;
      }
      continue;
    }
    
    if (ch === '{') {
      bal++;
      console.log(`L${i+1}:${j} { -> bal=${bal}`);
    } else if (ch === '}') {
      bal--;
      console.log(`L${i+1}:${j} } -> bal=${bal}`);
    }
  }
}

console.log(`\nFinal balance at L2340: ${bal}`);
