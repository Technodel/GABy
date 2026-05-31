const fs = require('fs');
const path = require('path');

const srcDir = 'd:\\Projects\\GABy\\src';

function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file === 'build') {
      continue;
    }
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath);
    } else if (stat.isFile() && /\.(tsx|ts|js|jsx|css|html)$/.test(file)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('\ufffd') || content.includes('')) {
        console.log(`Found invalid char in file: ${fullPath}`);
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (line.includes('\ufffd') || line.includes('')) {
            console.log(`  Line ${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
  }
}

scanDir(srcDir);
console.log('Scan complete.');
