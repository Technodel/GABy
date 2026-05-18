const fs = require('fs');
const c = fs.readFileSync('suny-test-suite.js', 'utf8');
// Find buildTests function
const start = c.indexOf('function buildTests');
const end = c.indexOf('\nconst TEST_SUITE = buildTests');
const body = c.substring(start, end);

// Count items in each const array
const lines = body.split('\n');
let total = 0;
let inArray = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.includes('= [') && !line.includes('const ')) continue; // skip declaration
  if (line.startsWith('const ') && line.includes('= [')) {
    inArray = true;
  } else if (inArray && line.endsWith('];')) {
    inArray = false;
  } else if (inArray && (line.startsWith("'") || line.startsWith('"'))) {
    total++;
  }
}
console.log('Total tests:', total);
