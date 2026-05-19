/**
 * A React-like component with bugs for SUNy to detect and fix
 * BUGS:
 * 1. Missing key prop in list rendering
 * 2. State update mutation (directly modifying state)
 * 3. Missing dependency array in useEffect
 * 4. Incorrect conditional rendering logic
 */

import React, { useState, useEffect } from 'react';

function TaskList({ tasks }) {
  const [items, setItems] = useState(tasks || []);
  const [filter, setFilter] = useState('all');
  const [count, setCount] = useState(0);

  // BUG: Missing dependency array — runs on every render
  useEffect(() => {
    console.log('Items updated:', items.length);
  });

  // BUG: Direct state mutation
  function addTask(task) {
    items.push(task);
    setItems(items);
  }

  function toggleTask(id) {
    const updated = items.map(item => {
      if (item.id === id) {
        return { ...item, done: !item.done };
      }
      return item;
    });
    setItems(updated);
  }

  function removeTask(id) {
    setItems(items.filter(item => item.id !== id));
  }

  // BUG: filter logic — 'all' should show everything but the condition is inverted
  const filteredItems = filter === 'all'
    ? items
    : filter === 'done'
      ? items.filter(item => item.done === true)
      : items.filter(item => !item.done);

  return (
    <div>
      <h2>Task List ({items.length})</h2>
      
      <div>
        <button onClick={() => setFilter('all')}>All</button>
        <button onClick={() => setFilter('done')}>Done</button>
        <button onClick={() => setFilter('pending')}>Pending</button>
      </div>

      <input
        type="text"
        placeholder="New task name"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target.value) {
            addTask({ id: Date.now(), text: e.target.value, done: false });
            e.target.value = '';
          }
        }}
      />

      <ul>
        {filteredItems.map(item => (
          // BUG: Missing 'key' prop
          <li>
            <span
              style={{ textDecoration: item.done ? 'line-through' : 'none' }}
              onClick={() => toggleTask(item.id)}
            >
              {item.text}
            </span>
            <button onClick={() => removeTask(item.id)}>✕</button>
          </li>
        ))}
      </ul>

      <p>Total tasks: {count}</p>
      {/* BUG: count state is never updated */}
    </div>
  );
}

export default TaskList;
