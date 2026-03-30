import overpy

api = overpy.Overpass()
min_lat, min_lng, max_lat, max_lng = 47.05, 18.35, 47.10, 18.45
query = f"""
[out:json][timeout:25];
(
  way["toll"="yes"]({min_lat},{min_lng},{max_lat},{max_lng});
);
out body;
>;
out skel qt;
"""
result = api.query(query)
for way in result.ways:
    print(way.tags)
