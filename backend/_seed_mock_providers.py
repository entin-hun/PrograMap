"""Seed extra mock providers into trail_planner.db."""
import sqlite3, sys
sys.path.insert(0, ".")
from db import upsert_provider, upsert_wix_connection, set_connection_location

# Fix provider 1 existing location (Belváros, Budapest)
set_connection_location(1, 47.4979, 19.0402)
print("updated provider_id=1 location → 47.4979, 19.0402")

MOCK_PROVIDERS = [
    dict(
        email="mock_provider_2@example.com",
        site_id="mock-site-2",
        account_id="mock-account-2",
        access_token="mock_access_p2",
        refresh_token="mock_refresh_p2",
        token_expires_at=None,
        scopes="offline_access bookings.read services.read",
        booking_page_url="https://www.wix.com/booking/p2",
        business_name="Szabó Gabriella Masszázs",
        business_address="Sanctuary - 1111, Bercsényi u. 5",
        business_lat=47.4785535,
        business_lng=19.0485779,
    ),
    dict(
        email="mock_provider_3@example.com",
        site_id="mock-site-3",
        account_id="mock-account-3",
        access_token="mock_access_p3",
        refresh_token="mock_refresh_p3",
        token_expires_at=None,
        scopes="offline_access bookings.read services.read",
        booking_page_url="https://www.wix.com/booking/p3",
        business_name="Farkas Szépségszalon",
        business_address="Budapest II., Margit körút 43",
        business_lat=47.5089,
        business_lng=19.0402,
    ),
]

for p in MOCK_PROVIDERS:
    email = p.pop("email")
    provider_row = upsert_provider(email)
    provider_id = provider_row["id"]
    upsert_wix_connection(provider_id=provider_id, **p)
    print(f"upserted provider_id={provider_id}  {p['business_name']}")

db = sqlite3.connect("trail_planner.db")
db.row_factory = sqlite3.Row
rows = db.execute(
    """SELECT w.provider_id, p.email, w.business_name, w.business_lat, w.business_lng
       FROM wix_connections w JOIN providers p ON p.id = w.provider_id"""
).fetchall()
print("\n--- all connections ---")
for r in rows:
    print(dict(r))
