**Role:** You are an Expert Full-Stack GIS Developer. Your task is to build a predictive "Mushroom Foraging Probability" Google Maps `Data Layer`, using a Python (FastAPI/Flask) backend.

**CRITICAL REQUIREMENT - The Rate-Limit Funnel:**
To prevent API rate limits, you MUST implement a spatial filtering funnel. Do not query weather or soil data for an entire bounding box. Follow this exact execution order on the backend when the frontend sends a bounding box:

**Step 1: Grid Generation & Zoom Constraint (Frontend -> Backend)**

* **Action:** The frontend must only trigger the Google Maps `Data Layer` calculation if the Google Maps zoom level is >= 13 (to prevent massive queries).
* **Action:** The backend receives the bounding box and generates a grid of coordinates (e.g., 500m x 500m cells).

**Step 2: The Broad Filter - Land Cover via Google Earth Engine (Backend)**

* **Action:** Authenticate with the `earthengine-api` (Python).
* **Data Source:** Use the dataset `ee.ImageCollection('ESA/WorldCover/v100')` (10m resolution) OR `COPERNICUS/CORINE/V20/100m/2018`.
* **Logic:** Filter the generated grid points. Keep ONLY the coordinates where the land cover equals "Tree cover" (or Broadleaved/Coniferous forest classes in CORINE).
* **Result:** Drop all urban, water, and agricultural coordinates. *Pass only the surviving forest coordinates to Step 3.*

**Step 3: The Dynamic Filter - Weather via Open-Meteo API (Backend)**

* **Data Source:** Use the `Open-Meteo Historical Weather API` (free, no key required).
* **Logic:** For the surviving forest coordinates, fetch the sum of `precipitation` and average `soil_moisture` over the **past 7 days**. To avoid rate limits, batch the coordinates if the API allows, or add a small delay between requests.
* **Result:** Keep ONLY coordinates where past 7-day precipitation > 15mm (or a sensible threshold). Drop the dry coordinates.

**Step 4: The Expensive Filter - Soil pH via SoilGrids API (Backend)**

* **Data Source:** Use the ISRIC SoilGrids REST API.
* **Logic:** Only query the remaining coordinates (which are confirmed wet forests). Fetch the `phh2o` (Soil pH) layer.
* **Result:** Score the coordinate based on optimal mushroom pH (e.g., pH 5.0 - 7.0 gets a high score).

**Step 5: Google Maps `Data Layer` Generation & Rendering (Backend -> Frontend)**

* **Logic:** Calculate a final probability score (0.0 to 1.0) for each surviving point based on the weather and soil values.
* **Format:** Return the data to the frontend as a GeoJSON FeatureCollection. Each feature should have a `weight` property (the probability score).
* **Frontend:** Use the Google Maps JavaScript API `Data Layer` to render the colored vector lines. Map the transparency to probability.

**Constraints & Error Handling:**

* Implement caching (e.g., Redis or simple in-memory LRU cache) for the Earth Engine and SoilGrids responses based on rounded coordinates.
* Include proper error handling if the Earth Engine API quota is exceeded, gracefully degrading the UI.

**The Scoring and Matching Algorithm (Backend)**

* For every surviving grid cell (from the weather/soil funnel), calculate a match score (0-100) for *each* species in `species_profiles.json`.
* Compare the cell's actual data (Open-Meteo temp/rain, SoilGrids pH, GEE land cover) against the species' `optimal_conditions`. Add the iNaturalist multiplier if applicable.
* **The Winner:** Select the species with the highest score for that cell. If the highest score is below 50%, mark the cell as `None` (empty).
* **Output:** Return a GeoJSON `FeatureCollection` of Polygons (squares representing the grid cells). Each Feature's `properties` must include: `dominant_species_name`, `probability_score`, and `fill_color`.

**Rendering the Categorical Grid & Legend (Frontend - Google Maps JS)**

* **Do NOT use `HeatmapLayer`.** It cannot handle multiple distinct colors representing different categories natively.
* **Action:** Use the Google Maps `Data Layer` (`map.data.addGeoJson()`) to render the polygons.
* **Styling:** Use `map.data.setStyle()` to color each polygon based on its `feature.getProperty('fill_color')`. Set `fillOpacity` to 0.5 and `strokeWeight` to 0 to make it look like a blocky heatmap.
* **Dynamic Legend:** Create a floating UI `<div>` overlay on the map (bottom-right). Iterate through the GeoJSON features, collect the unique winning species and their colors, and render a list (e.g., a small brown box next to "Vargánya (Porcini)").
* **Interactivity:** Add a click listener to the `Data Layer`. When a user clicks a colored cell, open an `InfoWindow` showing: "Dominant Species: [Name]", "Probability: [Score]%", and if you know a source for it (GBIF?) "Recent local sightings: [Yes/No]".