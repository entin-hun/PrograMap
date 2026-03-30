import os
from datetime import datetime, timedelta, timezone
from typing import Any

import requests


WIX_MOCK_MODE = os.getenv("WIX_MOCK_MODE", "true").lower() == "true"
WIX_TOKEN_URL = os.getenv("WIX_TOKEN_URL", "https://www.wixapis.com/oauth2/token")
WIX_API_BASE = os.getenv("WIX_API_BASE", "https://www.wixapis.com")

# Spread mock providers around Budapest so they never overlap on the map
_MOCK_COORDS = [
    (47.4785535, 19.0485779),   # Sancturary (provider 1)
    (47.4953, 19.0714),   # VIII. kerület (provider 2)
    (47.5089, 19.0402),   # II. kerület (provider 3)
    (47.4848, 19.0567),   # IX. kerület (provider 4)
    (47.5175, 19.0726),   # XIV. kerület (provider 5)
]

def _mock_coords_for_code(code: str) -> tuple[float, float]:
    """Return a deterministic, distinct lat/lng based on the OAuth code."""
    idx = int.from_bytes(code.encode()[:4], "big") % len(_MOCK_COORDS)
    return _MOCK_COORDS[idx]


def _iso_after(hours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def build_oauth_url(client_id: str, redirect_uri: str, state: str, scope: str) -> str:
    scope_param = scope or "offline_access"
    return (
        "https://www.wix.com/installer/install"
        f"?appId={client_id}"
        f"&redirectUrl={requests.utils.quote(redirect_uri, safe='')}"
        f"&state={requests.utils.quote(state, safe='')}"
        f"&scope={requests.utils.quote(scope_param, safe='')}"
    )


def exchange_code_for_tokens(code: str, client_id: str, client_secret: str, redirect_uri: str) -> dict[str, Any]:
    if WIX_MOCK_MODE:
        lat, lng = _mock_coords_for_code(code)
        return {
            "access_token": f"mock_access_{code[:8]}",
            "refresh_token": f"mock_refresh_{code[:8]}",
            "expires_in": 3600,
            "scope": "offline_access bookings.read services.read",
            "site_id": "mock-site",
            "account_id": "mock-account",
            "business_name": "Szabó Gabriella",
            "business_address": "Sanctuary - 1111, Bercsényi u. 5",
            "business_lat": lat,
            "business_lng": lng,
            "booking_page_url": "https://www.wix.com/booking",
        }

    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
    }
    response = requests.post(WIX_TOKEN_URL, json=payload, timeout=20)
    response.raise_for_status()
    return response.json()


def fetch_services(connection: dict[str, Any]) -> list[dict[str, Any]]:
    if WIX_MOCK_MODE:
        base_url = connection.get("booking_page_url") or "https://www.wix.com/booking"
        provider_id = connection.get("provider_id")
        return [
            {
                "service_id": f"{provider_id}-haircut",
                "name": "Haircut",
                "currency": "EUR",
                "amount": 35,
                "duration_min": 60,
                "booking_url": base_url,
            },
            {
                "service_id": f"{provider_id}-massage",
                "name": "Massage",
                "currency": "EUR",
                "amount": 60,
                "duration_min": 90,
                "booking_url": base_url,
            },
        ]

    token = connection.get("access_token")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    response = requests.get(f"{WIX_API_BASE}/bookings/v1/services", headers=headers, timeout=20)
    response.raise_for_status()
    payload = response.json()
    services = []
    for item in payload.get("services", []):
        services.append(
            {
                "service_id": item.get("id"),
                "name": item.get("name") or "Service",
                "currency": item.get("price", {}).get("currency") or "USD",
                "amount": float(item.get("price", {}).get("value") or 0),
                "duration_min": int(item.get("schedule", {}).get("durationInMinutes") or 60),
                "booking_url": item.get("bookingUrl") or connection.get("booking_page_url") or "",
            }
        )
    return services


def fetch_availability(
    connection: dict[str, Any],
    service_ids: list[str],
    start_datetime: str | None,
    soonest: bool,
) -> list[dict[str, Any]]:
    # Map service-type keywords to catalogue prices so availability matches the pane
    _MOCK_PRICES: dict[str, float] = {"haircut": 35, "massage": 60}

    def _mock_price(service_id: str, fallback: float) -> float:
        key = service_id.rsplit("-", 1)[-1].lower() if "-" in service_id else service_id.lower()
        return _MOCK_PRICES.get(key, fallback)

    if WIX_MOCK_MODE:
        base_start = start_datetime or _iso_after(1)
        slots = []
        for idx, service_id in enumerate(service_ids):
            slots.append(
                {
                    "service_id": service_id,
                    "start": base_start if idx == 0 else _iso_after(idx + 1),
                    "end": _iso_after(idx + 2),
                    "currency": "EUR",
                    "amount": _mock_price(service_id, 30 + idx * 10),
                    "booking_url": connection.get("booking_page_url") or "https://www.wix.com/booking",
                    "soonest": soonest,
                }
            )
        if not service_ids:
            slots.append(
                {
                    "service_id": "general",
                    "start": _iso_after(1),
                    "end": _iso_after(2),
                    "currency": "EUR",
                    "amount": 40,
                    "booking_url": connection.get("booking_page_url") or "https://www.wix.com/booking",
                    "soonest": True,
                }
            )
        return slots

    token = connection.get("access_token")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "serviceIds": service_ids,
        "startDateTime": start_datetime,
        "soonest": soonest,
    }
    response = requests.post(f"{WIX_API_BASE}/bookings/v1/availability/query", headers=headers, json=payload, timeout=20)
    response.raise_for_status()
    data = response.json()

    slots = []
    for slot in data.get("availabilitySlots", []):
        slots.append(
            {
                "service_id": slot.get("serviceId"),
                "start": slot.get("startDateTime"),
                "end": slot.get("endDateTime"),
                "currency": slot.get("price", {}).get("currency") or "USD",
                "amount": float(slot.get("price", {}).get("value") or 0),
                "booking_url": slot.get("bookingUrl") or connection.get("booking_page_url") or "",
                "soonest": soonest,
            }
        )
    return slots
