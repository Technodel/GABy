import re

with open('src/server/session-manager.ts', 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

# Track cumulative brace balance, skipping string literals (simple version)
# Report when balance goes negative (extra }) or stays positive at end
balance = 0
min_balance = 0
min_line = 0
in_string = False
string_char = None
in_template = False

for i, line in enumerate(lines, start=1):
    j = 0
    while j < len(line):
        ch = line[j]
        # Handle string literals (skip their contents)
        if ch in '"\'' and not in_template:
            if not in_string:
                in_string = True
                string_char = ch
            elif ch == string_char and (j == 0 or line[j-1] != '\\'):
                in_string = False
                string_char = None
        elif ch == '`':
            in_template = not in_template
        elif ch == '/' and j+1 < len(line) and line[j+1] == '/' and not in_string and not in_template:
            break  # rest of line is a comment
        elif ch == '{' and not in_string and not in_template:
            balance += 1
        elif ch == '}' and not in_string and not in_template:
            balance -= 1
            if balance < min_balance:
                min_balance = balance
                min_line = i
        j += 1

print(f'Final balance: {balance}')
print(f'Minimum balance (most extra }}): {min_balance} at line {min_line}')

# Now be more precise - print balance at each line
print('\n--- Brace balance progression (every 50 lines) ---')
balance = 0
in_string = False
string_char = None
in_template = False

for i, line in enumerate(lines, start=1):
    j = 0
    while j < len(line):
        ch = line[j]
        if ch in '"\'' and not in_template:
            if not in_string:
                in_string = True
                string_char = ch
            elif ch == string_char and (j == 0 or line[j-1] != '\\'):
                in_string = False
                string_char = None
        elif ch == '`':
            in_template = not in_template
        elif ch == '/' and j+1 < len(line) and line[j+1] == '/' and not in_string and not in_template:
            break
        elif ch == '{' and not in_string and not in_template:
            balance += 1
        elif ch == '}' and not in_string and not in_template:
            balance -= 1
        j += 1
    
    if i % 100 == 0 or i == 1 or i == len(lines):
        print(f'  Line {i}: balance = {balance}')
