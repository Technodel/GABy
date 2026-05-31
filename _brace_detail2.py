import re

with open('src/server/session-manager.ts', 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

balance = 0
in_string = False
string_char = None
in_template = False
in_block_comment = False

for i, line in enumerate(lines, start=1):
    j = 0
    changed = False
    brace_char = None
    while j < len(line):
        ch = line[j]
        
        if not in_string and not in_template and ch == '/' and j+1 < len(line):
            if line[j+1] == '*' and not in_block_comment:
                in_block_comment = True
                j += 2
                continue
            elif line[j+1] == '/' and not in_block_comment:
                break
        
        if in_block_comment:
            if ch == '*' and j+1 < len(line) and line[j+1] == '/':
                in_block_comment = False
                j += 2
                continue
            j += 1
            continue
        
        if ch == '`':
            in_template = not in_template
        elif ch in '"\'' and not in_template:
            if not in_string:
                in_string = True
                string_char = ch
            elif ch == string_char and (j == 0 or line[j-1] != '\\'):
                in_string = False
                string_char = None
        elif ch == '{' and not in_string and not in_template:
            balance += 1
            if not changed:
                changed = True
                brace_char = '{'
        elif ch == '}' and not in_string and not in_template:
            balance -= 1
            if not changed:
                changed = True
                brace_char = '}'
        j += 1
    
    if changed:
        print(f'Line {i}: {brace_char} balance={balance}')

print(f'\nFinal balance: {balance}')
