# Task Execution Test Project

A small Node.js + Python project with intentional bugs for testing SUNy's task execution capabilities.

## Structure

```
task-exec-test/
├── src/
│   ├── index.js       # Main module with 5+ known bugs
│   └── build.js       # Build script with syntax errors
├── python/
│   └── calculator.py  # Calculator with edge-case bugs
├── test-files/
│   └── run-tests.js   # Test runner, some tests fail due to bugs
├── package.json
└── README.md
```

## Setup

No dependencies needed — pure Node.js.

## Run Tests

```
node test-files/run-tests.js
```
