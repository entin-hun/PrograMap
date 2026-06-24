# Hiking Trip Planner

A full-stack web application for hiking trip planning. Discover scenic viewpoints, save favorites, and generate hiking routes between them.

## Tech Stack

*   **Frontend**: HTML, CSS, JavaScript (Google Maps JS API, Places API)
*   **Backend**: Python (FastAPI), OpenRouteService, Overpy
*   **Storage**: Browser `localStorage`

## Setup Instructions

### 1\. Backend Setup

1.  Navigate to the `backend` directory.
2.  Create a virtual environment and activate it:
3.  Install the dependencies:
4.  Set up your OpenRouteService API Key:
    *   Edit `backend/.env` and replace `your_ors_api_key_here` with your actual ORS API key.
5.  Run the FastAPI server:The backend will run on `http://localhost:8223`.

### 2\. Frontend Setup

1.  You do not need a build step. You can serve the `frontend` directory using any static file server, for example:
2.  Open your browser to `http://localhost:8080`.
3.  The UI will prompt you to provide your **Google Maps API Key**. This key requires the **Maps JavaScript API** and **Places API** to be enabled.

## Features

*   **Satellite Base Map**: The Google Map strictly renders in Satellite view.
*   **POI Discovery**: The application queries for "scenic viewpoints" with a 4.5+ star rating and at least 20 reviews.
*   **Photo Galleries**: Click on any viewpoint marker to view a gallery of photos from Google Places Details.
*   **Favorites**: Star locations to save them persistently.
*   **Routing**: Generate a foot-hiking route between your favorited viewpoints up to 10km. Intermediate viewpoints are intelligently injected as waypoints to ensure the route is scenic!

```
cd frontend
python3 -m http.server 8080
```

```
uvicorn main:app --reload --port 8223
```

```
pip install -r requirements.txt
```

```
python3 -m venv venv
source venv/bin/activate
```