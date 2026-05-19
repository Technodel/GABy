"""
A simple calculator with bugs
BUGS:
1. Division by zero is not handled
2. The power function has a logic error for exponent 0
3. Missing input validation
"""

def add(a, b):
    return a + b

def subtract(a, b):
    return a - b

def multiply(a, b):
    return a * b

def divide(a, b):
    return a / b  # BUG: no zero division check

def power(base, exp):
    result = 1
    for _ in range(exp):
        result *= base  # BUG: if exp is 0, loop doesn't run, result stays 1 - actually this is correct
    # ACTUAL BUG: Doesn't handle negative exponents
    return result

def factorial(n):
    if n < 0:
        return -1  # BUG: should raise ValueError
    if n == 0:
        return 1
    return n * factorial(n - 1)

def calculate(expression):
    """Parse and evaluate a simple expression like '2 + 3' """
    parts = expression.split()
    if len(parts) != 3:
        return "Invalid expression"
    
    a, op, b = parts
    a, b = float(a), float(b)
    
    if op == '+':
        return add(a, b)
    elif op == '-':
        return subtract(a, b)
    elif op == '*':
        return multiply(a, b)
    elif op == '/':
        return divide(a, b)
    elif op == '^':
        return power(a, int(b))
    else:
        return "Unknown operator"


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        print(calculate(' '.join(sys.argv[1:])))
    else:
        print("Usage: python calculator.py <expression>")
        print("Example: python calculator.py 2 + 3")
