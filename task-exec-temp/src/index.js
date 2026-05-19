/**
 * Main application entry point
 * BUGS to fix:
 * 1. The calculateTotal function has a floating point precision bug
 * 2. The getUserData function doesn't handle errors properly
 * 3. The formatDate function has an off-by-one error
 * 4. Missing input validation in processOrder
 * 5. The filterItems function has a logic error in the condition
 */

function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function getUserData(id) {
  const users = {
    1: { name: 'Alice', email: 'alice@example.com' },
    2: { name: 'Bob', email: 'bob@example.com' },
  };
  return users[id];
}

function formatDate(date) {
  const d = new Date(date);
  return `${d.getMonth()}/${d.getDate()}/${d.getFullYear()}`;
}

function processOrder(order) {
  const total = calculateTotal(order.items);
  const discount = total > 100 ? total * 0.1 : 0;
  return { ...order, total, discount, finalTotal: total - discount };
}

function filterItems(items, query) {
  return items.filter(item => {
    return item.name.includes(query) || item.tags.includes(query);
  });
}

function greetUser(user) {
  return `Hello, ${user.name}! Your email is ${user.email}`;
}

module.exports = {
  calculateTotal,
  getUserData,
  formatDate,
  processOrder,
  filterItems,
  greetUser,
};
