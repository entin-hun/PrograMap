import base64
import hashlib
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


DB_PATH = os.getenv("APP_DB_PATH", os.path.join(os.path.dirname(__file__), "trail_planner.db"))
SESSION_COOKIE_NAME = "provider_session"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def _resolve_secret() -> str:
    return os.getenv("APP_ENCRYPTION_SECRET") or os.getenv("APP_SECRET") or "dev-secret-change-me"


def _fernet() -> Fernet:
    digest = hashlib.sha256(_resolve_secret().encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_value(value: Optional[str]) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_value(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return ""


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = get_conn()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS magic_links (
            token_hash TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            redirect_url TEXT,
            expires_at TEXT NOT NULL,
            used_at TEXT
        );

        CREATE TABLE IF NOT EXISTS provider_sessions (
            token_hash TEXT PRIMARY KEY,
            provider_id INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS oauth_states (
            state TEXT PRIMARY KEY,
            provider_id INTEGER NOT NULL,
            redirect_uri TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS wix_connections (
            provider_id INTEGER PRIMARY KEY,
            site_id TEXT,
            account_id TEXT,
            access_token_enc TEXT,
            refresh_token_enc TEXT,
            token_expires_at TEXT,
            scopes TEXT,
            connected_at TEXT NOT NULL,
            booking_page_url TEXT,
            business_name TEXT,
            business_address TEXT,
            business_lat REAL,
            business_lng REAL,
            FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS service_cache (
            provider_id INTEGER NOT NULL,
            service_id TEXT NOT NULL,
            name TEXT NOT NULL,
            currency TEXT,
            amount REAL,
            duration_min INTEGER,
            booking_url TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(provider_id, service_id),
            FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS availability_cache (
            provider_id INTEGER NOT NULL,
            cache_key TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            PRIMARY KEY(provider_id, cache_key),
            FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE
        );
        """
    )
    conn.commit()
    conn.close()


def upsert_provider(email: str) -> sqlite3.Row:
    normalized = email.strip().lower()
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO providers(email, created_at) VALUES(?, ?) ON CONFLICT(email) DO NOTHING",
        (normalized, utc_iso(utc_now())),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM providers WHERE email = ?", (normalized,)).fetchone()
    conn.close()
    return row


def create_magic_link(email: str, redirect_url: Optional[str], ttl_minutes: int = 15) -> tuple[str, str]:
    token = new_token()
    th = token_hash(token)
    expires_at = utc_now() + timedelta(minutes=ttl_minutes)
    conn = get_conn()
    conn.execute(
        "INSERT INTO magic_links(token_hash, email, redirect_url, expires_at) VALUES(?, ?, ?, ?)",
        (th, email.strip().lower(), redirect_url or "", utc_iso(expires_at)),
    )
    conn.commit()
    conn.close()
    return token, utc_iso(expires_at)


def consume_magic_link(token: str) -> Optional[sqlite3.Row]:
    th = token_hash(token)
    conn = get_conn()
    row = conn.execute("SELECT * FROM magic_links WHERE token_hash = ?", (th,)).fetchone()
    if not row:
        conn.close()
        return None
    if row["used_at"]:
        conn.close()
        return None
    expires_at = parse_iso(row["expires_at"])
    if not expires_at or expires_at < utc_now():
        conn.close()
        return None
    conn.execute("UPDATE magic_links SET used_at = ? WHERE token_hash = ?", (utc_iso(utc_now()), th))
    conn.commit()
    conn.close()
    return row


def create_session(provider_id: int, ttl_days: int = 30) -> tuple[str, str]:
    token = new_token()
    th = token_hash(token)
    now = utc_now()
    expires = now + timedelta(days=ttl_days)
    conn = get_conn()
    conn.execute(
        "INSERT INTO provider_sessions(token_hash, provider_id, expires_at, created_at) VALUES(?, ?, ?, ?)",
        (th, provider_id, utc_iso(expires), utc_iso(now)),
    )
    conn.commit()
    conn.close()
    return token, utc_iso(expires)


def get_session_provider(session_token: str) -> Optional[sqlite3.Row]:
    conn = get_conn()
    row = conn.execute(
        """
        SELECT p.*
        FROM provider_sessions s
        JOIN providers p ON p.id = s.provider_id
        WHERE s.token_hash = ?
        """,
        (token_hash(session_token),),
    ).fetchone()
    if not row:
        conn.close()
        return None
    session_row = conn.execute(
        "SELECT * FROM provider_sessions WHERE token_hash = ?",
        (token_hash(session_token),),
    ).fetchone()
    expires_at = parse_iso(session_row["expires_at"]) if session_row else None
    if not expires_at or expires_at < utc_now():
        conn.execute("DELETE FROM provider_sessions WHERE token_hash = ?", (token_hash(session_token),))
        conn.commit()
        conn.close()
        return None
    conn.close()
    return row


def revoke_session(session_token: str) -> None:
    conn = get_conn()
    conn.execute("DELETE FROM provider_sessions WHERE token_hash = ?", (token_hash(session_token),))
    conn.commit()
    conn.close()


def create_oauth_state(provider_id: int, redirect_uri: str, ttl_minutes: int = 10) -> str:
    state = new_token()
    now = utc_now()
    expires = now + timedelta(minutes=ttl_minutes)
    conn = get_conn()
    conn.execute(
        "INSERT INTO oauth_states(state, provider_id, redirect_uri, expires_at, created_at) VALUES(?, ?, ?, ?, ?)",
        (state, provider_id, redirect_uri, utc_iso(expires), utc_iso(now)),
    )
    conn.commit()
    conn.close()
    return state


def consume_oauth_state(state: str) -> Optional[sqlite3.Row]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM oauth_states WHERE state = ?", (state,)).fetchone()
    if not row:
        conn.close()
        return None
    expires_at = parse_iso(row["expires_at"])
    conn.execute("DELETE FROM oauth_states WHERE state = ?", (state,))
    conn.commit()
    conn.close()
    if not expires_at or expires_at < utc_now():
        return None
    return row


def upsert_wix_connection(
    provider_id: int,
    site_id: str,
    account_id: str,
    access_token: str,
    refresh_token: str,
    token_expires_at: Optional[str],
    scopes: str,
    booking_page_url: str,
    business_name: str,
    business_address: str,
    business_lat: Optional[float] = None,
    business_lng: Optional[float] = None,
) -> None:
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO wix_connections(
            provider_id, site_id, account_id, access_token_enc, refresh_token_enc,
            token_expires_at, scopes, connected_at, booking_page_url,
            business_name, business_address, business_lat, business_lng
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
            site_id=excluded.site_id,
            account_id=excluded.account_id,
            access_token_enc=excluded.access_token_enc,
            refresh_token_enc=excluded.refresh_token_enc,
            token_expires_at=excluded.token_expires_at,
            scopes=excluded.scopes,
            connected_at=excluded.connected_at,
            booking_page_url=excluded.booking_page_url,
            business_name=excluded.business_name,
            business_address=excluded.business_address,
            business_lat=excluded.business_lat,
            business_lng=excluded.business_lng
        """,
        (
            provider_id,
            site_id,
            account_id,
            encrypt_value(access_token),
            encrypt_value(refresh_token),
            token_expires_at or "",
            scopes,
            utc_iso(utc_now()),
            booking_page_url,
            business_name,
            business_address,
            business_lat,
            business_lng,
        ),
    )
    conn.commit()
    conn.close()


def set_connection_location(provider_id: int, lat: float, lng: float) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE wix_connections SET business_lat = ?, business_lng = ? WHERE provider_id = ?",
        (lat, lng, provider_id),
    )
    conn.commit()
    conn.close()


def get_wix_connection(provider_id: int) -> Optional[sqlite3.Row]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM wix_connections WHERE provider_id = ?", (provider_id,)).fetchone()
    conn.close()
    return row


def get_all_wix_connections() -> list[sqlite3.Row]:
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT w.*, p.email as provider_email
        FROM wix_connections w
        JOIN providers p ON p.id = w.provider_id
        """
    ).fetchall()
    conn.close()
    return rows


def clear_wix_connection(provider_id: int) -> None:
    conn = get_conn()
    conn.execute("DELETE FROM wix_connections WHERE provider_id = ?", (provider_id,))
    conn.execute("DELETE FROM service_cache WHERE provider_id = ?", (provider_id,))
    conn.commit()
    conn.close()


def cache_services(provider_id: int, services: list[dict]) -> None:
    now = utc_iso(utc_now())
    conn = get_conn()
    conn.execute("DELETE FROM service_cache WHERE provider_id = ?", (provider_id,))
    for service in services:
        conn.execute(
            """
            INSERT INTO service_cache(provider_id, service_id, name, currency, amount, duration_min, booking_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                provider_id,
                service.get("service_id", ""),
                service.get("name", "Service"),
                service.get("currency", "USD"),
                float(service.get("amount") or 0),
                int(service.get("duration_min") or 60),
                service.get("booking_url") or "",
                now,
            ),
        )
    conn.commit()
    conn.close()


def get_cached_services(provider_id: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT service_id, name, currency, amount, duration_min, booking_url FROM service_cache WHERE provider_id = ?",
        (provider_id,),
    ).fetchall()
    conn.close()
    payload = []
    for row in rows:
        payload.append(
            {
                "service_id": row["service_id"],
                "name": row["name"],
                "currency": row["currency"],
                "amount": row["amount"],
                "duration_min": row["duration_min"],
                "booking_url": row["booking_url"],
            }
        )
    return payload
