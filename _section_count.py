with open('src/server/session-manager.ts', 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()
    lines = content.split('\n')

# Narrow in on lines 600-650 and 460-500
ranges = [
    ("460-475", 459, 475),
    ("475-490", 474, 490),
    ("490-500", 489, 500),
    ("550-565", 549, 565),
    ("565-580", 564, 580),
    ("580-600", 579, 600),
    ("600-610", 599, 610),
    ("610-620", 609, 620),
    ("620-630", 619, 630),
    ("630-640", 629, 640),
    ("640-650", 639, 650),
    ("650-660", 649, 660),
    ("660-670", 659, 670),
    ("670-700", 669, 700),
]

for name, start, end in ranges:
    open_c = 0
    close_c = 0
    for i in range(start, min(end, len(lines))):
        for ch in lines[i]:
            if ch == '{':
                open_c += 1
            elif ch == '}':
                close_c += 1
    print(f'Lines {name}: {{ = {open_c}, }} = {close_c}, diff = {open_c - close_c}')
