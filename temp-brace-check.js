const fs = require('fs');
const content = fs.readFileSync('src/server/session-manager.ts', 'utf-8');
const lines = content.split('\n');

let opens = 0, closes = 0;
let inString = false, inTemplate = false, inLineComment = false, inBlockComment = false;
let templateBraceDepth = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  inLineComment = false;
  
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const nextCh = j + 1 < line.length ? line[j+1] : '';
    
    if (!inString && !inTemplate && ch === '/' && nextCh === '*' && !inLineComment) {
      inBlockComment = true;
      j++;
      continue;
    }
    if (inBlockComment && ch === '*' && nextCh === '/') {
      inBlockComment = false;
      j++;
      continue;
    }
    if (inBlockComment) continue;
    
    if (!inString && !inTemplate && ch === '/' && nextCh === '/' && !inLineComment) {
      inLineComment = true;
      break;
    }
    if (inLineComment) break;
    
    if (!inTemplate && (ch === '"' || ch === "'") && !inString) {
      inString = ch;
      continue;
    }
    if (inString === ch && !inTemplate) {
      let bs = 0, k = j - 1;
      while (k >= 0 && line[k] === '\\') { bs++; k--; }
      if (bs % 2 === 1) continue;
      inString = false;
      continue;
    }
    if (inString) continue;
    
    if (ch === '`' && !inTemplate) {
      inTemplate = true;
      continue;
    }
    if (ch === '`' && inTemplate && templateBraceDepth === 0) {
      inTemplate = false;
      continue;
    }
    
    if (inTemplate) {
      if (ch === '$' && nextCh === '{') {
        templateBraceDepth++;
        j++;
        continue;
      }
      if (ch === '}') {
        templateBraceDepth--;
        if (templateBraceDepth < 0) {
          templateBraceDepth = 0;
          closes++;
        }
        continue;
      }
      if (ch === '{' && templateBraceDepth > 0) {
        templateBraceDepth++;
        continue;
      }
      continue;
    }
    
    if (ch === '{') { opens++; }
    else if (ch === '}') { closes++; }
  }
}

console.log('Structural { count:', opens);
console.log('Structural } count:', closes);
console.log('Net imbalance:', opens - closes);
