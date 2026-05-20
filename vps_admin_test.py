import json, urllib.request, http.cookiejar, ssl

# Create cookie jar
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# Login - use localhost
data = json.dumps({"username":"galaxy","password":"301088"}).encode()
req = urllib.request.Request("http://localhost:3500/api/login", data=data, headers={"Content-Type":"application/json"})
resp = opener.open(req)
print("Login:", resp.status, resp.read().decode())

# Show cookies
print("\nCookies:")
for c in cj:
    print(f"  {c.name}={c.value[:20]}... domain={c.domain} path={c.path} secure={c.secure}")

# Get users - try with the cookie
req2 = urllib.request.Request("http://localhost:3500/admin/api/users", headers={"Content-Type":"application/json"})
try:
    resp2 = opener.open(req2)
    print("\nUsers:", resp2.status)
    users = json.loads(resp2.read().decode())
    print(f"Count: {len(users)}")
    for u in users:
        print(f"  - {u['id']}: {u['username']} ({u['role']}) balance=${u['balance']}")
except urllib.error.HTTPError as e:
    print(f"\nUsers Error: {e.code}")
    print("Response:", e.read().decode())
