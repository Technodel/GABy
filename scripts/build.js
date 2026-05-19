/**
 * SUNy production build script.
 * Uses TypeScript transpileModule() to avoid OOM from complex AI SDK generics.
 * Falls back to tsc for type checking (separate step with --noEmit).
 */

const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src', 'server');
const DIST = path.resolve(__dirname, '..', 'dist', 'server');

// Read tsconfig
const configPath = path.resolve(__dirname, '..', 'tsconfig.json');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  path.resolve(__dirname, '..')
);

// Ensure dist directory exists
fs.mkdirSync(DIST, { recursive: true });

// Collect all .ts files in src/server (excluding test files)
function collectFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = collectFiles(SRC);
console.log(`Found ${files.length} files to compile`);

let compiled = 0;
let errors = 0;

for (const filePath of files) {
  const relativePath = path.relative(SRC, filePath);
  const jsPath = path.join(DIST, relativePath.replace(/\.ts$/, '.js'));
  const dtsPath = path.join(DIST, relativePath.replace(/\.ts$/, '.d.ts'));
  const mapPath = path.join(DIST, relativePath.replace(/\.ts$/, '.js.map'));

  fs.mkdirSync(path.dirname(jsPath), { recursive: true });

  try {
    const source = fs.readFileSync(filePath, 'utf8');

    // Transpile
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        resolveJsonModule: true,
        strict: true,
        sourceMap: true,
        skipLibCheck: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      fileName: filePath,
    });

    // Write .js
    fs.writeFileSync(jsPath, result.outputText);

    // Write .js.map (if sourceMap was enabled, it's embedded)
    if (result.sourceMapText) {
      fs.writeFileSync(mapPath, result.sourceMapText);
    }

    compiled++;
    process.stdout.write('.');
    if (compiled % 40 === 0) process.stdout.write(`\n${compiled} files compiled\n`);
  } catch (e) {
    console.error(`\n✗ Error compiling ${relativePath}:`, e.message);
    errors++;
  }
}

console.log(`\n\nBuild complete: ${compiled} files compiled, ${errors} errors`);
process.exit(errors > 0 ? 1 : 0);
