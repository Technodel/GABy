import json, urllib.request
data = json.dumps({"username":"galaxy","password":"301088"}).encode()
req = urllib.request.Request("http://localhost:3500/api/login", data=data, headers={"Content-Type":"application/json"})
try:
    resp = urllib.request.urlopen(req)
    print("Status:", resp.status)
    print("Body:", resp.read().decode())
except urllib.error.HTTPError as e:
    print("Error:", e.code, e.read().decode())
