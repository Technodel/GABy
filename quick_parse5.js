const ts = require('typescript');
const fs = require('fs');

const source = fs.readFileSync('src/server/session-manager.ts', 'utf-8');

// Use scanner on full file and track detailed positions
const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);

let openCount = 0;
let closeCount = 0;
let prevLine = 0;

do {
    const token = scanner.scan();
    const pos = scanner.getTokenPos();
    const line = source.substring(0, pos).split('\n').length;
    
    if (token === ts.SyntaxKind.OpenBraceToken) {
        openCount++;
        // Print lines with unusual patterns - non-sequential
        if (line > prevLine + 1) {
            const text = source.substring(pos, pos + 40).split('\n')[0].trim();
            console.log(`OPEN at L${line}: ${text}`);
        }
        prevLine = line;
    } else if (token === ts.SyntaxKind.CloseBraceToken) {
        closeCount++;
    }
} while (scanner.getToken() !== ts.SyntaxKind.EndOfFileToken);

console.log(`\nFull file: Open={${openCount}, Close=${closeCount}, Net=${openCount - closeCount}`);

// Now let's look at what's happening in L999-2339 specifically
// Find all Open/Close tokens in that range
console.log(`\n=== Tokens in L999-2339 ===`);
const scanner2 = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
let inRange = false;
let rangeOpens = 0, rangeCloses = 0;

do {
    const token = scanner2.scan();
    const pos = scanner2.getTokenPos();
    const line = source.substring(0, pos).split('\n').length;
    
    if (line === 999) inRange = true;
    if (line === 2340) inRange = false;
    
    if (inRange && (token === ts.SyntaxKind.OpenBraceToken || token === ts.SyntaxKind.CloseBraceToken)) {
        const text = source.substring(pos, pos + 50).split('\n')[0].trim();
        if (token === ts.SyntaxKind.OpenBraceToken) {
            rangeOpens++;
            console.log(`  OPEN L${line}: ${text}`);
        } else {
            rangeCloses++;
            console.log(`  CLOSE L${line}: ${text}`);
        }
    }
} while (scanner2.getToken() !== ts.SyntaxKind.EndOfFileToken);

console.log(`\nL999-2339: Open=${rangeOpens}, Close=${rangeCloses}, Net=${rangeOpens - rangeCloses}`);
