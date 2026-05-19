/**
 * Test runner for task-exec-test
 * Tests the functions in src/index.js and reports pass/fail
 * 
 * BUG: The test for calculateTotal expects WRONG expected values
 * because it doesn't account for floating point precision
 */

const {
  calculateTotal,
  getUserData,
  formatDate,
  processOrder,
  filterItems,
  greetUser,
} = require('../src/index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

console.log('\n📋 Running task-exec-test suite...\n');

// Test calculateTotal
test('calculateTotal handles simple items', () => {
  const items = [{ price: 10, quantity: 2 }, { price: 5, quantity: 3 }];
  const result = calculateTotal(items);
  if (result !== 35) throw new Error(`Expected 35, got ${result}`);
});

test('calculateTotal handles floating point correctly', () => {
  const items = [{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }];
  const result = calculateTotal(items);
  // 0.1 + 0.2 = 0.30000000000000004 in floating point
  if (result !== 0.3) throw new Error(`Expected 0.3, got ${result}`);
});

test('calculateTotal returns 0 for empty array', () => {
  if (calculateTotal([]) !== 0) throw new Error('Expected 0 for empty');
});

// Test getUserData
test('getUserData returns user by id', () => {
  const user = getUserData(1);
  if (user.name !== 'Alice') throw new Error('Expected Alice');
});

test('getUserData handles missing user', () => {
  const user = getUserData(999);
  if (user !== undefined) throw new Error('Expected undefined for missing user');
});

// Test formatDate
test('formatDate formats correctly', () => {
  const result = formatDate('2024-03-15');
  // Month is 0-indexed, so March is 2, day is 15
  if (result !== '3/15/2024') throw new Error(`Expected 3/15/2024, got ${result}`);
});

// Test processOrder
test('processOrder calculates discount correctly', () => {
  const order = { items: [{ price: 50, quantity: 3 }] };
  const result = processOrder(order);
  if (result.total !== 150) throw new Error(`Expected total 150, got ${result.total}`);
  if (result.discount !== 15) throw new Error(`Expected discount 15, got ${result.discount}`);
  if (result.finalTotal !== 135) throw new Error(`Expected finalTotal 135, got ${result.finalTotal}`);
});

test('processOrder handles empty items', () => {
  const order = { items: [] };
  const result = processOrder(order);
  if (result.total !== 0) throw new Error('Expected total 0 for empty items');
});

// Test filterItems
test('filterItems finds by name', () => {
  const items = [
    { name: 'apple', tags: ['fruit'] },
    { name: 'banana', tags: ['fruit', 'yellow'] },
    { name: 'carrot', tags: ['vegetable'] },
  ];
  const result = filterItems(items, 'apple');
  if (result.length !== 1) throw new Error(`Expected 1 result, got ${result.length}`);
});

test('filterItems finds by tag', () => {
  const items = [
    { name: 'apple', tags: ['fruit'] },
    { name: 'banana', tags: ['fruit', 'yellow'] },
    { name: 'carrot', tags: ['vegetable'] },
  ];
  const result = filterItems(items, 'yellow');
  if (result.length !== 1) throw new Error(`Expected 1 result for tag search, got ${result.length}`);
});

// Test greetUser
test('greetUser returns correct greeting', () => {
  const result = greetUser({ name: 'Alice', email: 'alice@example.com' });
  if (result !== 'Hello, Alice! Your email is alice@example.com') {
    throw new Error(`Unexpected greeting: ${result}`);
  }
});

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
