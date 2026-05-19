/**
 * Build script that has intentional bugs
 * BUGS:
 * 1. Syntax error: missing closing parenthesis on line 12
 * 2. Wrong variable name used on line 18 (outputs vs output)
 * 3. Missing error handling for file operations
 */

const fs = require('fs');
const path = require('path');

function build() {
  const config = {
    entry: './src/index.js',
    output: './dist/bundle.js',
    minify: true,
    sourcemaps: true,
  };

  console.log('Building...');
  console.log(`Entry: ${config.entry}`);
  console.log(`Output: ${config.outputs}`);  // BUG: wrong key name

  const content = fs.readFileSync(config.entry, 'utf-8');
  const minified = content.replace(/\s+/g, ' ').trim();

  // BUG: missing dist directory creation
  fs.writeFileSync(config.output, minified);

  console.log('Build complete!');
}

build();
