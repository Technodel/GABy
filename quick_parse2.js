const ts = require('typescript');
const fs = require('fs');

const source = fs.readFileSync('src/server/session-manager.ts', 'utf-8');
console.log(`File length: ${source.length} chars`);

// Use TypeScript's lexer/parser directly
const sf = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
let openBraces = 0;
let closeBraces = 0;

function visit(node, depth) {
    if (ts.isBlock(node) || ts.isCaseBlock(node)) {
        // These explicitly contain braces
    }
    ts.forEachChild(node, child => visit(child, depth + 1));
}

// Instead, let's count by scanning the token stream manually
const len = source.length;
let i = 0;
while (i < len) {
    // Skip whitespace
    if (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r') {
        i++;
        continue;
    }
    // Skip single-line comments
    if (source[i] === '/' && source[i+1] === '/') {
        while (i < len && source[i] !== '\n') i++;
        continue;
    }
    // Skip multi-line comments
    if (source[i] === '/' && source[i+1] === '*') {
        i += 2;
        while (i < len - 1 && !(source[i] === '*' && source[i+1] === '/')) i++;
        i += 2;
        continue;
    }
    // Skip string literals
    if (source[i] === "'" || source[i] === '"') {
        const quote = source[i];
        i++;
        while (i < len && source[i] !== quote) {
            if (source[i] === '\\') i++;
            i++;
        }
        if (i < len) i++; // closing quote
        continue;
    }
    // Skip template literals
    if (source[i] === '`') {
        i++;
        while (i < len && source[i] !== '`') {
            if (source[i] === '\\') { i+=2; continue; }
            if (source[i] === '$' && source[i+1] === '{') {
                // Template expression - count the { as structural
                openBraces++;
                i += 2;
                // Skip the expression
                let braceDepth = 1;
                while (i < len && braceDepth > 0) {
                    if (source[i] === '{') braceDepth++;
                    else if (source[i] === '}') braceDepth--;
                    if (source[i] === '\\') i++;
                    i++;
                }
                if (braceDepth === 0) closeBraces++;
                continue;
            }
            i++;
        }
        if (i < len) i++; // closing backtick
        continue;
    }
    
    if (source[i] === '{') openBraces++;
    else if (source[i] === '}') closeBraces++;
    
    i++;
}

console.log(`\nManual scan results:`);
console.log(`Open braces: ${openBraces}`);
console.log(`Close braces: ${closeBraces}`);
console.log(`Net: ${openBraces - closeBraces}`);
