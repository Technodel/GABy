const ts = require('typescript');
const fs = require('fs');

const source = fs.readFileSync('src/server/session-manager.ts', 'utf-8');

// Create a source file and walk the AST counting OpenBraceToken and CloseBraceToken
const sf = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);

let opens = 0;
let closes = 0;

function walk(node) {
    // Count brace tokens in this node
    if (node.kind === ts.SyntaxKind.Block ||
        node.kind === ts.SyntaxKind.CaseBlock ||
        node.kind === ts.SyntaxKind.ModuleBlock ||
        node.kind === ts.SyntaxKind.TypeLiteral) {
        // These nodes contain braces intrinsically
    }
    
    // Count syntax list tokens (statements in blocks)
    ts.forEachChild(node, walk);
}

// Simpler: use the scanner properly
const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
let token;
let openCount = 0;
let closeCount = 0;

do {
    token = scanner.scan();
    if (token === ts.SyntaxKind.OpenBraceToken) {
        openCount++;
    } else if (token === ts.SyntaxKind.CloseBraceToken) {
        closeCount++;
    }
} while (token !== ts.SyntaxKind.EndOfFileToken);

console.log(`OpenBraceToken: ${openCount}`);
console.log(`CloseBraceToken: ${closeCount}`);
console.log(`Net: ${openCount - closeCount}`);

// Also try walking the source file to see the AST structure
let astOpens = 0;
let astCloses = 0;
function visit(node) {
    ts.forEachChild(node, child => {
        if (child.kind === ts.SyntaxKind.OpenBraceToken) astOpens++;
        if (child.kind === ts.SyntaxKind.CloseBraceToken) astCloses++;
        visit(child);
    });
}
visit(sf);
console.log(`\nAST walk OpenBraceToken: ${astOpens}`);
console.log(`AST walk CloseBraceToken: ${astCloses}`);
