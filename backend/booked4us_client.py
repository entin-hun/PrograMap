"""Booked4Us public booking platform adapter.

Uses the public REST-v2 API of a Booked4Us instance to:
  - List available calendars (service providers)
  - Query free time intervals for a calendar on a given date

Authentication is optional: many endpoints are publicly accessible.
If BOOKED4US_USERNAME / BOOKED4US_PASSWORD are configured, an OAuth2
password-flow token will be fetched and attached to requests.

Key endpoints:
  GET  {api_base}/api/Calendars                           -> calendar list
  GET  {api_base}/api/Calendars/{id}/AllIntervals         -> intervals with reserved status
  POST {site_base}/api/token                              -> OAuth2 bearer token
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)
_DEFAULT_TIMEOUT = 10


def _site_base(api_base: str) -> str:
    """Strip /rest-v2 from the API base to get the customer site URL."""
    base = api_base.rstrip("/")
    return base[:-8] if base.endswith("/rest-v2") else base


def get_auth_token(
    api_base: str,
    username: str,
    password: str,
    timeout: int = _DEFAULT_TIMEOUT,
) -> Optional[str]:
    """
    Obtain an OAuth2 bearer token via the password grant flow.
    Returns None on any failure so callers can degrade gracefully.
    """
    url = f"{_site_base(api_base)}/api/token"
    try:
        resp = requests.post(
            url,
            data={"grant_type": "password", "username": username, "password": password},
            timeout=timeout,
        )
        resp.raise_for_status()
        return resp.json().get("access_token")
    except Exception as exc:
        logger.warning("Booked4Us auth failed (%s): %s", url, exc)
        return None


def get_calendars(
    api_base: str,
    token: Optional[str] = None,
    timeout: int = _DEFAULT_TIMEOUT,
) -> list[dict[str, Any]]:
    """
    Return all non-hidden calendars from the Booked4Us instance.

    Each result dict contains:
      calendar_id, name, phone_number, description, day_start, day_end, booking_url
    """
    url = f"{api_base.rstrip('/')}/api/Calendars"
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        resp = requests.get(url, headers=headers, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("Booked4Us get_calendars failed: %s", exc)
        return []

    site_url = _site_base(api_base)
    calendars: list[dict[str, Any]] = []
    for item in data.get("Data") or []:
        if item.get("Hidden"):
            continue
        cal_id = item.get("Id")
        if cal_id is None:
            continue
        calendars.append(
            {
                "calendar_id": cal_id,
                "name": item.get("Name") or f"Calendar {cal_id}",
                "phone_number": item.get("PhoneNumber"),
                "description": item.get("ShortDescription") or item.get("Description"),
                "picture_link": item.get("PictureLink"),
                "day_start": item.get("DayStart"),
                "day_end": item.get("DayEnd"),
                "booking_url": site_url,
            }
        )
    return calendars


def get_free_intervals(
    api_base: str,
    calendar_id: int,
    target_date: str,
    requested_hour: Optional[int] = None,
    person_count: int = 1,
    token: Optional[str] = None,
    timeout: int = _DEFAULT_TIMEOUT,
) -> list[dict[str, Any]]:
    """
    Return free time slots for *calendar_id* on *target_date* ("YYYY-MM-DD").

    If *requested_hour* is given (0-23), only slots starting in that hour are returned.
    Each result dict: {date, start ("HH:MM:SS"), end ("HH:MM:SS"), free_places}
    """
    url = f"{api_base.rstrip('/')}/api/Calendars/{calendar_id}/AllIntervals"
    try:
        dt = datetime.strptime(target_date, "%Y-%m-%d")
    except ValueError:
        return []

    start_dt = dt.replace(tzinfo=timezone.utc)
    end_dt = (dt + timedelta(days=1)).replace(tzinfo=timezone.utc)

    params = {
        "StartDate": start_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "EndDate": end_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "PersonCount": person_count,
        "IsUtc": "true",
    }
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning(
            "Booked4Us get_free_intervals calendar=%s date=%s failed: %s",
            calendar_id,
            target_date,
            exc,
        )
        return []

    response_data = data.get("Data") or {}
    intervals_by_date = response_data.get("Intervals") or []

    free_slots: list[dict[str, Any]] = []
    for day_data in intervals_by_date:
        day_date = day_data.get("Date") or target_date
        for interval in day_data.get("Intervals") or []:
            if interval.get("Reserved"):
                continue
            free_places = interval.get("FreePlaces")
            if free_places is not None and free_places <= 0:
                continue
            slot_start = interval.get("Start") or ""
            if requested_hour is not None and slot_start:
                try:
                    if int(slot_start.split(":")[0]) != requested_hour:
                        continue
                except Exception:
                    pass
            free_slots.append(
                {
                    "date": day_date,
                    "start": slot_start,
                    "end": interval.get("End"),
                    "free_places": free_places,
                }
            )
    return free_slots
