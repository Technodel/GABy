import re

with open('src/server/session-manager.ts', 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

# Track braces within runAgentLoop (starting at line 460, 0-indexed: 459)
stack = []
report = []

for i, line in enumerate(lines[459:], start=460):
    for j, ch in enumerate(line):
        if ch == '{':
            stack.append((i, j, ch))
        elif ch == '}':
            if stack:
                stack.pop()
            else:
                report.append(f'EXTRA }} at line {i}, col {j} (no matching opener)')

print(f'Unclosed braces remaining: {len(stack)}')
for l, c, ch in stack:
    print(f'  at line {l} col {c}: {lines[l-1].strip()[:80]}')
for r in report:
    print(r)

# Count try/catch at indentation 4 within runAgentLoop
print('\n--- try/catch analysis at indent=4 ---')
for i, line in enumerate(lines[459:], start=460):
    stripped = line.lstrip()
    indent = len(line) - len(stripped)
    if indent == 4:
        if stripped.startswith('try'):
            print(f'Line {i}: try')
        if stripped.startswith('}') and 'catch' in stripped:
            print(f'Line {i}: catch (matching try needed)')
