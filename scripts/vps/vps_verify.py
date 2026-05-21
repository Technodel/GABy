import json, urllib.request, http.cookiejar, http.client

# Create cookie jar and login
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

data = json.dumps({"username":"galaxy","password":"301088"}).encode()
req = urllib.request.Request("http://localhost:3500/api/login", data=data, headers={"Content-Type":"application/json"})
resp = opener.open(req)
print("Login:", resp.status, resp.read().decode())

# Get users
cookie_header = "; ".join([f"{c.name}={c.value}" for c in cj])
conn = http.client.HTTPConnection("localhost", 3500)
conn.request("GET", "/admin/api/users", headers={"Cookie": cookie_header, "Content-Type": "application/json"})
resp2 = conn.getresponse()
users = json.loads(resp2.read().decode())
print(f"\nUsers ({len(users)}):")
for u in users:
    print(f"  - id={u['id']}: {u['username']} balance=${u['balance']} active={u['is_active']}")
conn.close()

# Get API keys
conn2 = http.client.HTTPConnection("localhost", 3500)
conn2.request("GET", "/admin/api/api-keys", headers={"Cookie": cookie_header, "Content-Type": "application/json"})
resp3 = conn2.getresponse()
keys = json.loads(resp3.read().decode())
print(f"\nAPI Keys ({len(keys)}):")
for k in keys:
    print(f"  - {k['id']}: {k['provider']} ({k['mode']}) is_active={k['is_active']} label={k.get('label','')}")
conn2.close()
