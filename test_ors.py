import urllib.request
import urllib.parse
import json
import os
from dotenv import load_dotenv

load_dotenv("backend/.env")
api_key = os.environ.get("ORS_API_KEY")

body = {"coordinates":[[18.39, 47.07],[18.42, 47.08]], "format": "geojson", "profile": "foot-hiking", "extra_info": ["tollways"]}
req = urllib.request.Request("https://api.openrouteservice.org/v2/directions/foot-hiking/geojson", data=json.dumps(body).encode('utf-8'), headers={"Authorization": api_key, "Content-Type": "application/json"})
try:
    res = urllib.request.urlopen(req)
    data = json.loads(res.read())
    print(json.dumps(data["features"][0]["properties"], indent=2))
except Exception as e:
    print(e)
