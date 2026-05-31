const ts = require('typescript');
const fs = require('fs');

const source = fs.readFileSync('src/server/session-manager.ts', 'utf-8');

// Use proper scanner pattern
const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
scanner.setText(source, 0, source.length);

let openCount = 0;
let closeCount = 0;
let token = scanner.scan();
const opens = {};
const closes = {};

while (token !== ts.SyntaxKind.EndOfFileToken) {
    const pos = scanner.getTokenPos();
    const line = source.substring(0, pos).split('\n').length;
    const text = source.substring(pos, Math.min(pos + 60, source.length)).split('\n')[0];
    
    if (token === ts.SyntaxKind.OpenBraceToken) {
        openCount++;
        opens[line] = (opens[line] || 0) + 1;
        if (line < 460 || line > 2386 || (line >= 999 && line <= 2339)) {
            //print nothing  
        }
    } else if (token === ts.SyntaxKind.CloseBraceToken) {
        closeCount++;
        closes[line] = (closes[line] || 0) + 1;
    }
    token = scanner.scan();
}

console.log(`OpenBrace tokens: ${openCount}`);
console.log(`CloseBrace tokens: ${closeCount}`);
console.log(`Net: ${openCount - closeCount}`);

// Count by key line ranges
function countRange(startLine, endLine) {
    let o = 0, c = 0;
    for (let line = startLine; line <= endLine; line++) {
        o += opens[line] || 0;
        c += closes[line] || 0;
    }
    return { opens: o, closes: c, net: o - c };
}

console.log('\nBy section:');
console.log(`L1-459: ${JSON.stringify(countRange(1, 459))}`);
console.log(`L460-987: ${JSON.stringify(countRange(460, 987))}`);
console.log(`L988-998: ${JSON.stringify(countRange(988, 998))}`);
console.log(`L999-2339: ${JSON.stringify(countRange(999, 2339))}`);
console.log(`L2340-2382: ${JSON.stringify(countRange(2340, 2382))}`);
console.log(`L2383-2386: ${JSON.stringify(countRange(2383, 2386))}`);

// Show lines with unequal counts
console.log('\nLines with OpenBrace != CloseBrace:');
for (let line = 1; line <= 2387; line++) {
    const o = opens[line] || 0;
    const c = closes[line] || 0;
    if (o !== c && (o > 0 || c > 0)) {
        const lineText = source.split('\n')[line-1].trim().substring(0, 80);
        console.log(`L${line}: open=${o}, close=${c}, net=${o-c} | ${lineText}`);
    }
}
