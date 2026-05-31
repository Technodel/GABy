import re

with open('src/server/session-manager.ts', 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()
    lines = content.split('\n')

# Full file brace balance (naive, without string/comment skipping)
open_br = content.count('{')
close_br = content.count('}')
print(f'Full file: {{ = {open_br}, }} = {close_br}, diff = {open_br - close_br}')

# Now within runAgentLoop (line 460 to end)
in_func = False
func_open = 0
func_close = 0
func_start = 0
for i, line in enumerate(lines, start=1):
    if 'export async function runAgentLoop' in line:
        in_func = True
        func_start = i
    if in_func:
        for ch in line:
            if ch == '{':
                func_open += 1
            elif ch == '}':
                func_close += 1

print(f'Within runAgentLoop (line {func_start}-{len(lines)}): {{ = {func_open}, }} = {func_close}, diff = {func_open - func_close}')

# Scan braces in raw mode to find ALL braces with context
print('\n--- All braces at indent 0-2 (outer levels) ---')
for i, line in enumerate(lines, start=1):
    stripped = line.lstrip()
    if not stripped.strip():
        continue
    indent = len(line) - len(stripped)
    if indent <= 2:
        for ch in line:
            if ch in '{}':
                print(f'Line {i}, col {line.index(ch)}: {ch} {stripped[:60]}')
                break
