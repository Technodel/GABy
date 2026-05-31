with open('src/server/session-manager.ts', 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

num_lines = len(lines)
print(f'File has {num_lines} lines (0-indexed: 0-{num_lines-1})')

# Count braces at each indentation level in runAgentLoop (lines 460-2387, 0-indexed: 459-2386)
level_opens = {}
level_closes = {}

for i in range(459, min(2387, num_lines)):
    line = lines[i]
    stripped = line.lstrip()
    if not stripped or stripped[0] not in '{}':
        continue
    indent = len(line) - len(stripped)
    
    for ch in stripped:
        if ch == '{':
            level_opens[indent] = level_opens.get(indent, 0) + 1
            break
        elif ch == '}':
            level_closes[indent] = level_closes.get(indent, 0) + 1
            break
        else:
            break

all_levels = sorted(set(list(level_opens.keys()) + list(level_closes.keys())))
print('Indent | Opens | Closes | Diff')
print('-' * 35)
for l in all_levels:
    o = level_opens.get(l, 0)
    c = level_closes.get(l, 0)
    diff = o - c
    marker = ' ***' if diff != 0 else ''
    print(f'{l:5d}  | {o:5d} | {c:5d} | {diff:+5d}{marker}')
