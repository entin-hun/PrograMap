# Wix Availability Map

A Google Maps-based web app for discovering service availability from Wix-connected providers. Providers (service businesses) connect their Wix calendars; users select services and optional time to see real-time pricing and availability pins on a map.

## Features

### For Users
- **Public map search**: No login required
- **Service selection**: Checklist of available services across all connected providers
- **Flexible scheduling**: 
  - Default to 1 hour from now
  - Optional specific time selection
  - "Soonest" mode to find immediate availability
- **Price-at-a-glance**: Markers show lowest available price per provider
- **One-click booking**: Click marker to open Wix booking page or Google Maps fallback

### For Providers  
- **Magic-link login**: No password signup (development-friendly; email in production)
- **Wix OAuth**: Secure calendar/service sync without storing credentials
- **Auto-import**: Services, prices, and availability fetch on demand
- **Timezone-aware**: Availability respects provider's timezone and location
- **Location geocoding**: Provider address auto-resolved to map coordinates

### Map Legacy Features
- Hiking trails, terrain layers, foraging probability zones
- Scenic POI discovery, fuel stations, camping/water amenities
- Route planning with GPX export

---

## Quick Start

### Prerequisites
- Python 3.8+
- A Google Maps API key (Maps, Places, Geocoding libraries)
- Optional: Wix sandbox/production OAuth app credentials
- Optional: OpenStreetMap/Overpass, Open-Meteo, EarthEngine extras (for foraging/hiking)

### Local Setup

1. **Enter project directory:**
   ```bash
   cd /Users/mac-pro/dev_projects/trail-planner
   ```

2. **Install backend dependencies:**
   ```bash
   pip install -r backend/requirements.txt
   ```

3. **Configure environment:**
   ```bash
   cp backend/.env.example backend/.env
   ```
   
   Edit `backend/.env` and set:
   - `GOOGLE_API_KEY=<your-key>` (required for maps and geocoding)
   - `WIX_MOCK_MODE=true` (dev/testing; false for production Wix API)
   - Other optional keys for hiking features

4. **Start the backend:**
   ```bash
   cd backend
   python -m uvicorn main:app --reload --host 0.0.0.0 --port 8269
   ```
   (The client defaults to port 8269; adjust BACKEND_URL in `frontend/app.js` if different.)

5. **Open the app:**
   ```
   http://localhost:8269/frontend
   ```
   OR just open `/trail-planner/frontend/index.html` in a browser (CORS will use localhost defaults).

---

## Provider Flow (Magic Link + Wix OAuth)

### 1. Request Magic Link
- Email input, click **"Request magic link"**
- In dev mode (`AUTH_RETURN_MAGIC_LINK=true`), token auto-fills for testing
- In production, email sent with link containing token

### 2. Verify Magic Token
- Paste token (or open link), click **"Verify login"**
- Session cookie set; provider now authenticated
- Status shows email
- Service catalog auto-loads (empty until Wix connected)

### 3. Connect Wix Calendar
- Click **"Connect Wix"** (only visible if `WIX_CLIENT_ID` configured)
- Redirects to Wix authorization screen
- Approve scopes: `bookings.read`, `services.read`
- Redirects back; connection saved
- Catalog auto-fetches next marketplace refresh

### 4. Logout
- Click **"Logout"** to revoke session

---

## User Flow (Service Discovery)

### 1. Select Services
- Service checklist populated from all providers' Wix calendars
- Check boxes for services you're interested in
- Visible: service name, price, provider name

### 2. Set Preferred Time (Optional)
- **Input field** defaults to current time + 1 hour
- **"Use soonest instead"** button clears and defaults search to immediate slots
- Leave empty for soonest available

### 3. Search Availability
- Click **"Show options on map"**
- Map loads availability markers for selected services
- Each marker shows lowest price among that provider's available slots
- Clustering/geospatial filtering applied if many results

### 4. Book or Explore
- **Click marker** opens Wix booking page (if bookingUrl available) OR Google Maps place card
- If neither available, fallback info window with provider details + navigation link

---

## API Reference

All endpoints use JSON. Credentials/tokens sent via:
- **Session auth**: HTTP cookie `provider_session` (secure, httponly)
- **CORS**: All origins allowed in dev; restrict in production

### Provider Auth

#### POST `/api/provider/auth/request-link`
Request a magic link for email signin.
```json
{
  "email": "provider@business.com",
  "redirect_url": "http://localhost:3000"  // Optional; used in production email link
}
```
**Response:**
```json
{
  "ok": true,
  "message": "Magic link created",
  "expires_at": "2025-09-23T10:30:00+00:00",
  "magic_token": "abc123...",  // Only if AUTH_RETURN_MAGIC_LINK=true (dev)
  "magic_link": "http://localhost:3000?magic_token=abc123..."
}
```

#### POST `/api/provider/auth/verify`
Verify a magic token and create session.
```json
{
  "token": "abc123..."
}
```
**Response:** (Sets-Cookie: provider_session)
```json
{
  "ok": true,
  "provider": {
    "id": 42,
    "email": "provider@business.com"
  },
  "expires_at": "2025-10-23T10:30:00+00:00"
}
```

#### GET `/api/provider/auth/status`
Check provider login and Wix connection status.  
**Headers:** Cookie: provider_session=...  
**Response:**
```json
{
  "authenticated": true,
  "provider": { "id": 42, "email": "provider@business.com" },
  "wix_connected": true
}
```

#### POST `/api/provider/auth/logout`
Revoke session and delete cookie.  
**Response:** (Deletes-Cookie: provider_session)
```json
{ "ok": true }
```

### Wix OAuth

#### POST `/api/provider/oauth/start`
Initiate Wix OAuth flow.  
**Headers:** Cookie: provider_session=...  
**Body:**
```json
{
  "redirect_uri": "http://localhost:8269/api/provider/oauth/callback"
}
```
**Response:**
```json
{
  "ok": true,
  "provider": "wix",
  "auth_url": "https://www.wix.com/installer/install?appId=...",
  "state": "state-token-..."
}
```

#### GET `/api/provider/oauth/callback`
Wix redirects here after authorization.  
**Query params:** `code`, `state`  
**Response:** Redirect to provider dashboard or success page (implementation-dependent)

#### GET `/api/provider/oauth/status`
Check Wix connection details.  
**Headers:** Cookie: provider_session=...  
**Response:**
```json
{
  "connected": true,
  "provider": "wix",
  "site_id": "...",
  "connected_at": "2025-09-23T10:30:00+00:00",
  "business_name": "My Salon",
  "business_address": "123 Main St, Budapest",
  "booking_page_url": "https://www.wix.com/booking/..."
}
```

#### POST `/api/provider/oauth/disconnect`
Revoke Wix connection.  
**Headers:** Cookie: provider_session=...  
**Response:**
```json
{ "ok": true }
```

### Service Discovery (Public)

#### GET `/api/services/catalog`
Fetch all services from all connected providers. No auth required.  
**Response:**
```json
{
  "services": [
    {
      "id": "42:haircut",
      "service_id": "haircut",
      "provider_id": 42,
      "provider_email": "salon@example.com",
      "provider_name": "My Salon",
      "name": "Haircut",
      "price": { "currency": "EUR", "amount": 35 },
      "duration_min": 60,
      "booking_url": "https://..."
    },
    ...
  ]
}
```

#### POST `/api/availability/search`
Find availability for selected services and time. No auth required.  
**Body:**
```json
{
  "service_ids": ["42:haircut", "43:massage"],
  "requested_time": "2025-09-23T11:30:00Z",
  "soonest": false,
  "latitude": 47.5,
  "longitude": 19.04
}
```
**Response:**
```json
{
  "requested_time": "2025-09-23T11:30:00Z",
  "soonest": false,
  "results": [
    {
      "provider_id": 42,
      "provider_name": "My Salon",
      "provider_email": "salon@example.com",
      "lat": 47.5012,
      "lng": 19.0412,
      "maps_url": "https://www.google.com/maps/search/?api=1&query=47.5012,19.0412",
      "booking_url": "https://",
      "min_price": { "currency": "EUR", "amount": 35 },
      "slots": [
        {
          "id": "42:haircut",
          "service_id": "haircut",
          "start": "2025-09-23T11:30:00Z",
          "end": "2025-09-23T12:30:00Z",
          "price": { "currency": "EUR", "amount": 35 },
          "booking_url": "https://..."
        },
        ...
      ]
    },
    ...
  ]
}
```

---

## Configuration

Set in `backend/.env`:

| Var | Default | Purpose |
|-----|---------|---------|
| `GOOGLE_API_KEY` | None | **Required** for maps, Places, Geocoding |
| `WIX_MOCK_MODE` | true | Use mock Wix API (dev) or real API |
| `WIX_CLIENT_ID` | None | Your Wix OAuth app ID |
| `WIX_CLIENT_SECRET` | None | Your Wix OAuth app secret |
| `WIX_SCOPES` | `offline_access bookings.read services.read` | Wix API scopes |
| `APP_DB_PATH` | `trail_planner.db` | SQLite DB location |
| `APP_ENCRYPTION_SECRET` | `change-me` | Secret for token encryption (change in prod) |
| `AUTH_RETURN_MAGIC_LINK` | true | Return token in response (dev only; email in prod) |
| `FRONTEND_BASE_URL` | `http://localhost:3000` | Frontend origin for OAuth redirects |
| `ORS_API_KEY` | None | OpenRouteService (hiking routes) |
| `HERE_API_KEY` | None | HERE API (fuel stations) |
| `EE_SERVICE_ACCOUNT_EMAIL` | None | Earth Engine (foraging) |
| `EE_PRIVATE_KEY_PATH` | None | Earth Engine key file path |

---

## Development Notes

### Mock Mode (Dev)
- `WIX_MOCK_MODE=true` returns fake services + availability
- Magic links are short-lived (15 min) but returned in response for instant testing
- No real Wix API calls; good for UI/UX validation

### Real Wix API
1. Create an OAuth app in Wix App Manager
2. Set `WIX_CLIENT_ID`, `WIX_CLIENT_SECRET`
3. Set `WIX_MOCK_MODE=false`
4. Scope example for production: `offlineaccess bookings.read services.read`
5. Token refresh auto-handled in callbacks

### Database
- SQLite stored at `APP_DB_PATH` (default: `trail_planner.db`)
- Tokens encrypted at rest using app secret
- Sessions auto-expire after 30 days
- Magic links auto-expire after 15 min

### Frontend State
- Service selection stored in memory (not persisted)
- Provider auth checked on page load
- Service catalog auto-loaded after successful auth
- Availability markers cleared on new search

---

## Testing Checklist

- [ ] Backend starts and serves `/api/config`
- [ ] Google Maps API key configured and tiles load
- [ ] Provider: Request magic link → receive token (dev mode)
- [ ] Provider: Verify token → session set → logged in
- [ ] Provider (mock mode): Wix OAuth start → fake auth_url generated
- [ ] Provider (mock mode): Services catalog populated after Wix "connection"
- [ ] User: Service checklist renders with mock services
- [ ] User: Select 2+ services → set time OR use soonest → click search
- [ ] User: Availability markers render on map with price labels
- [ ] User: Click marker → opens booking URL or Google Maps fallback
- [ ] Provider: Logout → session revoked, auth status refreshed
- [ ] Existing hiking/trail/foraging features still work (regression test)

---

## Future Enhancements

- **Real-time socket updates** for provider availability changes
- **Provider-managed time slots** (manual availability override)
- **Multi-language support** for non-English locales
- **Analytics dashboard** for provider bookings/traffic
- **User reviews & ratings** per service
- **Advanced filtering** by service duration, price range, provider tags
- **WhatsApp/SMS integration** for booking confirmations
- **Mobile app** (React Native)
- **Stripe/PayPal** for online payments
- **Admin panel** for platform management

---

## Troubleshooting

**"Could not connect to backend"**
- Verify `BACKEND_URL` matches running backend (default: `http://localhost:8269`)
- Check backend is running: `python -m uvicorn main:app --reload --host 0.0.0.0 --port 8269`

**"Google Maps API key not found"**
- Set `GOOGLE_API_KEY` in `backend/.env` and restart backend

**"Magic link sent but never received (production)"**
- Email delivery depends on mail service setup (not in scope for dev)
- For testing, use dev mode: `AUTH_RETURN_MAGIC_LINK=true`

**"Wix OAuth fails with 'appId not found'"**
- Verify `WIX_CLIENT_ID` is your actual Wix app ID (not placeholder)
- Ensure OAuth redirect URI matches exactly in Wix App Manager

**"Services don't load after Wix connect"**
- Refresh page to trigger catalog fetch
- Check provider `/api/provider/oauth/status` shows site_id set
- Verify `WIX_MOCK_MODE=false` if using real Wix API
- Check backend logs for API errors

---

**Built on [trail-planner](../README.md) hiking/foraging base.**
