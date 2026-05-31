with open('src/server/session-manager.ts', 'rb') as f:
    lines = f.read().split(b'\n')
bc = 0
print("Brace count from line 2340 to end:")
for i in range(2339, len(lines)):
    for b in lines[i]:
        if b == 123: bc += 1
        elif b == 125: bc -= 1
    line_str = lines[i].decode('utf-8', errors='replace').strip()
    if len(line_str) > 70:
        line_str = line_str[:70] + '...'
    print(f'  Line {i+1}: bc={bc:2d} | {line_str}')
