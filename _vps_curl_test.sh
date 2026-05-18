#!/bin/bash
echo "=== TEST 1: admin login ==="
curl -s -X POST http://127.0.0.1:3500/admin/login \
  -H "Content-Type: application/json" \
  -d '{"password":"301088"}' \
  -w '\nHTTP_CODE:%{http_code}'
echo ""
echo "=== TEST 2: user login ==="
curl -s -X POST http://127.0.0.1:3500/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"test123"}' \
  -w '\nHTTP_CODE:%{http_code}'
echo ""
echo "=== TEST 3: admin login escaped ==="
curl -s -X POST http://127.0.0.1:3500/admin/login \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"301088\"}" \
  -w '\nHTTP_CODE:%{http_code}'
echo ""
echo "=== TEST 4: user login escaped ==="
curl -s -X POST http://127.0.0.1:3500/api/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"testuser\",\"password\":\"test123\"}" \
  -w '\nHTTP_CODE:%{http_code}'
