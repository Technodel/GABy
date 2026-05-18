#!/bin/bash
curl -s -X POST http://localhost:3500/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"empy","password":"301088"}'
echo ""
curl -s -X POST http://localhost:3500/api/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"empy\",\"password\":\"301088\"}"
