const ts = require('typescript');
const fs = require('fs');

const source = fs.readFileSync('src/server/session-manager.ts', 'utf-8');
const lines = source.split('\n');

// Count by sections using the scanner
function countBracesInRange(startLine, endLine) {
    // Find byte offsets for line range
    let startOffset = 0;
    for (let i = 0; i < startLine - 1 && i < lines.length; i++) {
        startOffset += lines[i].length + 1; // +1 for newline
    }
    let endOffset = startOffset;
    for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
        endOffset += lines[i].length + 1;
    }
    
    const segment = source.substring(startOffset, endOffset);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, segment);
    let openCount = 0;
    let closeCount = 0;
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
        if (token === ts.SyntaxKind.OpenBraceToken) openCount++;
        else if (token === ts.SyntaxKind.CloseBraceToken) closeCount++;
        token = scanner.scan();
    }
    return { opens: openCount, closes: closeCount, net: openCount - closeCount };
}

// Key sections
const sections = [
    { label: 'Before function (L1-459)', start: 1, end: 459 },
    { label: 'Function body (L460-987)', start: 460, end: 987 },
    { label: 'For loop (L988-998)', start: 988, end: 998 },
    { label: 'Try block (L999-2339)', start: 999, end: 2339 },
    { label: 'Catch block (L2340-2382)', start: 2340, end: 2382 },
    { label: 'For close (L2383)', start: 2383, end: 2383 },
    { label: 'Function close (L2384-2386)', start: 2384, end: 2386 },
];

console.log('Section-by-section TypeScript scanner counts:');
let totalOpens = 0, totalCloses = 0;
for (const s of sections) {
    const r = countBracesInRange(s.start, s.end);
    totalOpens += r.opens;
    totalCloses += r.closes;
    console.log(`${s.label}: +${r.opens} -${r.closes} = net ${r.net}`);
}
console.log(`\nTotal: +${totalOpens} -${totalCloses} = net ${totalOpens - totalCloses}`);
