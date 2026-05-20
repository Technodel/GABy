import json, urllib.request, http.cookiejar

# Create cookie jar
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(cj),
)

# Login
data = json.dumps({"username":"galaxy","password":"301088"}).encode()
req = urllib.request.Request("http://localhost:3500/api/login", data=data, headers={"Content-Type":"application/json"})
resp = opener.open(req)
print("Login:", resp.status, resp.read().decode())

# Show cookies
print("\nCookies in jar:")
for c in cj:
    print(f"  {c.name}={c.value[:40]}... domain={c.domain} path={c.path} secure={c.secure}")

# Build a request manually to see what headers are sent
import http.client
conn = http.client.HTTPConnection("localhost", 3500)
cookie_header = "; ".join([f"{c.name}={c.value}" for c in cj])
print(f"\nSending Cookie header: {cookie_header[:60]}...")
conn.request("GET", "/admin/api/users", headers={"Cookie": cookie_header, "Content-Type": "application/json"})
resp2 = conn.getresponse()
print(f"Users Status: {resp2.status}")
print("Users Body:", resp2.read().decode())
conn.close()
