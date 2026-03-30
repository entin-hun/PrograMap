import requests
from typing import Any, Optional


def _safe_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except Exception:
        return None


def _safe_float(value: Any) -> Optional[float]:
    try:
        return float(value)
    except Exception:
        return None


def search_locations(
    api_base: str,
    *,
    location_type_id: Optional[int] = None,
    service_category_id: Optional[int] = None,
    service_type_id: Optional[int] = None,
    address: Optional[str] = None,
    keyword: Optional[str] = None,
    radius_km: Optional[float] = None,
    timeout: int = 20,
) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"format": "json"}
    if location_type_id is not None:
        params["location_type_id"] = location_type_id
    if service_category_id is not None:
        params["service_category_id"] = service_category_id
    if service_type_id is not None:
        params["service_type_id"] = service_type_id
    if address:
        params["address"] = address
    if keyword:
        params["keyword"] = keyword
    if radius_km is not None:
        params["radius"] = radius_km

    url = f"{api_base.rstrip('/')}/api/search/getlocations"
    response = requests.get(url, params=params, timeout=timeout)
    response.raise_for_status()

    payload = response.json() if response.content else {}
    raw_locations = payload.get("locations") or payload.get("items") or []
    locations: list[dict[str, Any]] = []

    for item in raw_locations:
        if not isinstance(item, dict):
            continue

        location_id = _safe_int(item.get("id") or item.get("place_id"))
        if location_id is None:
            continue

        services = item.get("services")
        if not isinstance(services, list):
            services = []

        slug = str(item.get("location_page_url") or "").strip()
        booking_url = f"https://salonic.hu/hu/{slug}" if slug else "https://salonic.hu"

        coordinates = item.get("coordinates") or {}

        locations.append(
            {
                "location_id": location_id,
                "place_name": str(item.get("place_name") or "").strip() or "Salonic partner",
                "address": str(item.get("address") or item.get("place_address") or "").strip(),
                "location_page_url": slug,
                "booking_url": booking_url,
                "location_type_name": str(
                    (item.get("location_category") or {}).get("name")
                    or item.get("location_type")
                    or ""
                ).strip(),
                "services": services,
                "lat": _safe_float(
                    item.get("lat")
                    or item.get("latitude")
                    or item.get("location_lat")
                    or coordinates.get("latitude")
                ),
                "lng": _safe_float(
                    item.get("lng")
                    or item.get("longitude")
                    or item.get("location_lng")
                    or coordinates.get("longitude")
                ),
            }
        )

    return locations
