// Quick approach: use TypeScript's tokenizer to count braces properly
const ts = require('typescript');
const fs = require('fs');

const source = fs.readFileSync('src/server/session-manager.ts', 'utf-8');

// Use the scanner to tokenize
const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);

let openBraces = 0;
let closeBraces = 0;
let token = scanner.scan();

while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.OpenBraceToken) {
        openBraces++;
        const pos = scanner.getTokenPos();
        const line = source.substring(0, pos).split('\n').length;
        // Only print context for key lines
        if (pos < 50000) { /* only track counts */ }
    } else if (token === ts.SyntaxKind.CloseBraceToken) {
        closeBraces++;
    }
    token = scanner.scan();
}

console.log(`Open braces: ${openBraces}`);
console.log(`Close braces: ${closeBraces}`);
console.log(`Net: ${openBraces - closeBraces}`);
