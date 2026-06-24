let map;
let markers = [];
let suggestionMarkers = [];
let favorites = JSON.parse(localStorage.getItem('favorites')) || {};
let savedRoutes = JSON.parse(localStorage.getItem('savedRoutes')) || {};
let savedDescriptions = JSON.parse(localStorage.getItem('savedDescriptions')) || {};
let mentionedPOINames = [];
let currentPlace = null;
let routePolylines = {};
let fuelMarkers = [];
let carRepairMarkers = [];
let allCarRepairPlaces = [];
let carRepairFetchTimer = null;
let carRepairBoundsKey = null;
let carRepairFiltersDirty = false;
let activityMarkers = [];
let activityConnectorLines = [];
let activityAnchorMarkers = [];
let allActivities = [];
let filteredActivities = [];
let activityFetchTimer = null;
let lastActivityBoundsKey = null;
let suppressActivityRefreshUntil = 0;
let activityClusterExpanded = new Map();
let dynamicOverpassFeatures = [];
let sharedInfoWindow = null;
let foragingLabels = [];
let foragingFetchTimer = null;
let lastForagingBoundsKey = null;
let ForagingLabel = null;
let lastFuelCountry = null;
let fuelCountryTimer = null;
let availabilityMarkers = [];
let serviceCatalog = [];
let selectedServiceIds = new Set();
let providerAuthState = { authenticated: false, wix_connected: false };
let AdvancedMarkerCtor = null;

const FUEL_COUNTRY_ALLOW = new Set([
    "Austria",
    "Belgium",
    "Denmark",
    "France",
    "Germany",
    "Italy",
    "Liechtenstein",
    "Luxembourg",
    "Monaco",
    "Netherlands",
    "Norway",
    "Poland",
    "San Marino",
    "Spain",
    "Sweden",
    "Switzerland",
    "United Kingdom",
    "Vatican City"
]);

// Automatically use the host IP the page was loaded from, keeping the backend port
const BACKEND_URL = `http://${window.location.hostname}:8269`;

async function initMap() {
    const { Map } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const { PlaceAutocompleteElement } = await google.maps.importLibrary("places");
    AdvancedMarkerCtor = AdvancedMarkerElement;
    
    map = new Map(document.getElementById("map"), {
        center: { lat: 46.715674, lng: 25.6799302 }, // Parcul national Hasmasul Mare
        zoom: 12,
        mapTypeId: "hybrid", // "hybrid" shows satellite + labels (city names, roads)
        mapId: "DEMO_MAP_ID",
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
    });

    ForagingLabel = class extends google.maps.OverlayView {
        constructor(position, text, color, wikipediaUrl, yOffset) {
            super();
            this.position = position;
            this.text = text;
            this.color = color;
            this.wikipediaUrl = wikipediaUrl;
            this.yOffset = yOffset || 0;
            this.div = null;
        }

        onAdd() {
            this.div = document.createElement('div');
            this.div.className = 'foraging-label';
            this.div.style.color = this.color;
            this.div.textContent = this.text;
            this.div.title = this.text;
            this.div.addEventListener('click', () => {
                if (this.wikipediaUrl) {
                    window.open(this.wikipediaUrl, '_blank');
                }
            });
            const panes = this.getPanes();
            panes.overlayMouseTarget.appendChild(this.div);
        }

        draw() {
            if (!this.div) return;
            const projection = this.getProjection();
            const point = projection.fromLatLngToDivPixel(this.position);
            if (point) {
                this.div.style.left = `${point.x}px`;
                this.div.style.top = `${point.y + this.yOffset}px`;
            }
        }

        onRemove() {
            if (this.div && this.div.parentNode) {
                this.div.parentNode.removeChild(this.div);
            }
            this.div = null;
        }
    };

    window.setOverlayLayer = function(layer, enabled) {
        if (!layer || !map) return;
        const arr = map.overlayMapTypes.getArray();
        const idx = arr.indexOf(layer);
        if (enabled && idx === -1) {
            map.overlayMapTypes.push(layer);
        } else if (!enabled && idx !== -1) {
            map.overlayMapTypes.removeAt(idx);
        }
    };

    // Try HTML5 geolocation to jump to user's location when received
    const placeUserDot = (lat, lng, isApprox) => {
        const pos = { lat, lng };
        map.setCenter(pos);
        map.setZoom(isApprox ? 11 : 13);
        
        const userDot = document.createElement("div");
        userDot.style.width = "16px";
        userDot.style.height = "16px";
        // Gray dot if approximate (IP based), Blue if exact (GPS)
        userDot.style.backgroundColor = isApprox ? "#9e9e9e" : "#4285F4";
        userDot.style.border = "3px solid white";
        userDot.style.borderRadius = "50%";
        userDot.style.boxShadow = "0 0 8px rgba(0,0,0,0.4)";
        
        new AdvancedMarkerElement({
            map,
            position: pos,
            title: isApprox ? "Approximate Location" : "Your Location",
            content: userDot
        });
    };

    const fallbackIPLocation = async () => {
        try {
            const res = await fetch("https://ipapi.co/json/");
            if (!res.ok) return;
            const data = await res.json();
            if (data.latitude && data.longitude) {
                placeUserDot(data.latitude, data.longitude, true);
            }
        } catch (e) {
            console.warn("IP geolocation fallback failed:", e);
        }
    };

    // Browsers block geolocation on non-secure connections (like HTTP over local IP)
    if (navigator.geolocation && (window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        navigator.geolocation.getCurrentPosition(
            (position) => placeUserDot(position.coords.latitude, position.coords.longitude, false),
            (error) => {
                console.warn("Geolocation blocked or failed. Falling back to IP.", error);
                fallbackIPLocation();
            },
            { timeout: 5000, maximumAge: 60000 }
        );
    } else {
        console.warn("Secure context not found. Using IP geolocation fallback.");
        fallbackIPLocation();
    }
    
    // Setup Search Bar using the new PlaceAutocompleteElement (replaces deprecated Autocomplete)
    // Migrated from google.maps.places.Autocomplete -> google.maps.places.PlaceAutocompleteElement
    const citySearchInput = document.getElementById("city-search");
    if (citySearchInput) {
        const inputContainer = citySearchInput.parentElement;
        citySearchInput.remove();
        const placeAutocomplete = new PlaceAutocompleteElement({
            placeholder: "Search a city or place...",
        });
        placeAutocomplete.id = "city-search";
        placeAutocomplete.style.width = "100%";
        if (inputContainer) {
            inputContainer.appendChild(placeAutocomplete);
        }

        // Bias predictions to the visible map bounds
        const updateLocationRestriction = () => {
            if (map && placeAutocomplete) {
                const bounds = map.getBounds();
                if (bounds) placeAutocomplete.locationRestriction = bounds;
            }
        };
        // Initial restriction + update on pan/zoom
        updateLocationRestriction();
        map.addListener('bounds_changed', updateLocationRestriction);

        // New API uses the `gmp-select` event and `placePrediction.toPlace()`.
        // We fetch the location/viewport fields explicitly because the widget no
        // longer returns them eagerly like the classic Autocomplete.getPlace() did.
        placeAutocomplete.addEventListener("gmp-select", async (event) => {
            const placePrediction = event.placePrediction;
            if (!placePrediction) return;
            const place = placePrediction.toPlace();
            try {
                await place.fetchFields({ fields: ['location', 'viewport'] });
            } catch (e) {
                console.warn('PlaceAutocompleteElement: fetchFields failed', e);
            }
            if (place.viewport) {
                map.fitBounds(place.viewport);
            } else if (place.location) {
                map.setCenter(place.location);
                map.setZoom(13);
            }
        });
    }

    // Add marked trails overlay from Waymarked Trails (Hiking)
    window.trailsLayer = new google.maps.ImageMapType({
        getTileUrl: function(coord, zoom) {
            return `https://tile.waymarkedtrails.org/hiking/${zoom}/${coord.x}/${coord.y}.png`;
        },
        tileSize: new google.maps.Size(256, 256),
        maxZoom: 18,
        minZoom: 0,
        name: 'Trails'
    });

    const getCappedTile = (coord, zoom, maxZoom) => {
        if (zoom <= maxZoom) {
            return { z: zoom, x: coord.x, y: coord.y };
        }
        const scale = 1 << (zoom - maxZoom);
        return {
            z: maxZoom,
            x: Math.floor(coord.x / scale),
            y: Math.floor(coord.y / scale)
        };
    };

    window.terrainLayer = new google.maps.ImageMapType({
        getTileUrl: function(coord, zoom) {
            const { z, x, y } = getCappedTile(coord, zoom, 17);
            return `https://tile.opentopomap.org/${z}/${x}/${y}.png`;
        },
        tileSize: new google.maps.Size(256, 256),
        maxZoom: 17,
        minZoom: 0,
        name: 'Terrain',
        opacity: 0.85
    });

    window.steepnessLayer = {
        tileSize: new google.maps.Size(256, 256),
        maxZoom: 16,
        minZoom: 0,
        name: 'Steepness',
        getTile: function(coord, zoom, ownerDocument) {
            const { z, x, y } = getCappedTile(coord, zoom, 16);
            const url = `https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/${z}/${y}/${x}`;

            const doc = ownerDocument || document;
            const canvas = doc.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;

            const ctx = canvas.getContext('2d');
            if (!ctx) return canvas;

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                ctx.clearRect(0, 0, 256, 256);
                ctx.drawImage(img, 0, 0, 256, 256);
                const imgData = ctx.getImageData(0, 0, 256, 256);
                const data = imgData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const intensity = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    const steep = 1 - intensity / 255;
                    const boosted = Math.pow(steep, 0.6);
                    const alpha = Math.min(1, Math.max(0, boosted * 1.1));
                    data[i] = 245;
                    data[i + 1] = 25;
                    data[i + 2] = 15;
                    data[i + 3] = Math.round(alpha * 255);
                }
                ctx.putImageData(imgData, 0, 0);
            };
            img.onerror = () => {
                ctx.clearRect(0, 0, 256, 256);
            };
            img.src = url;
            return canvas;
        }
    };

    window.setOverlayLayer(window.trailsLayer, document.getElementById("toggle-trails").checked);
    window.setOverlayLayer(window.terrainLayer, document.getElementById("toggle-terrain").checked);
    window.setOverlayLayer(window.steepnessLayer, document.getElementById("toggle-steepness").checked);
    
    map.addListener("idle", () => {
        searchPOIs(AdvancedMarkerElement);
        searchFuelStations(AdvancedMarkerElement);
        searchOverpassPOIs(AdvancedMarkerElement);
        searchDrinkingWater(AdvancedMarkerElement);
        scheduleCarRepairRefresh(AdvancedMarkerElement);
        scheduleActivityRefresh(AdvancedMarkerElement);
        updateForagingLayer();
        updateFuelAvailability();
    });

    renderFavoritesList();
    bindToggles(AdvancedMarkerElement);
    await initializeBookingFeatures();
}

function bindToggles(AdvancedMarkerElement) {

    document.getElementById('toggle-trails').addEventListener('change', (e) => {
        window.setOverlayLayer(window.trailsLayer, e.target.checked);
    });

    document.getElementById('toggle-terrain').addEventListener('change', (e) => {
        window.setOverlayLayer(window.terrainLayer, e.target.checked);
    });

    document.getElementById('toggle-steepness').addEventListener('change', (e) => {
        window.setOverlayLayer(window.steepnessLayer, e.target.checked);
    });

    document.getElementById('toggle-scenic').addEventListener('change', (e) => {
        const show = e.target.checked;
        markers.forEach(m => {
            // keep favorites visible
            if (!favorites[m.place_id]) {
                m.map = show ? map : null;
            }
        });
        if (show) searchPOIs(AdvancedMarkerElement);
        // Car repair filter depends on the set of currently visible scenic spots.
        // Re-apply the filter so the count badge and visibility stay in sync.
        const carRepairToggle = document.getElementById('toggle-car-repair');
        if (carRepairToggle && carRepairToggle.checked && allCarRepairPlaces.length > 0) {
            applyCarRepairFilters(AdvancedMarkerElement);
        }
    });

    document.getElementById('toggle-fuel').addEventListener('change', (e) => {
        const show = e.target.checked;
        fuelMarkers.forEach(m => {
            m.map = show ? map : null;
        });
        if (show) searchFuelStations(AdvancedMarkerElement);
    });

    const updateRoutePolylines = () => {
        const showParks = document.getElementById('toggle-parks').checked;
        const showTolls = document.getElementById('toggle-tolls').checked;
        const showScenic = document.getElementById('toggle-scenic').checked;
        const showWater = document.getElementById('toggle-water').checked;
        
        Object.values(routePolylines).forEach(arr => {
            if (Array.isArray(arr)) {
                arr.forEach(item => {
                    if (item.poiType) {
                        if (item.poiType === 'camp_site' || item.poiType === 'caravan_site') {
                            item.map = showParks ? map : null;
                        
                        } else if (item.poiType === 'toll_road') {
                            item.setMap(showTolls ? map : null);
                        } else if (item.poiType === 'viewpoint') {
                            item.map = showScenic ? map : null;
                        } else if (item.poiType === 'drinking_water') {
                            item.map = showWater ? map : null;
                        }
                    }
                });
            }
        });
    };

    document.getElementById('toggle-parks').addEventListener('change', (e) => {
        const showParks = e.target.checked;
        dynamicOverpassFeatures.forEach(item => {
            if (item.poiType === 'camp_site' || item.poiType === 'caravan_site') {
                if (item.setMap) item.setMap(showParks ? map : null);
                else item.map = showParks ? map : null;
            }
        });
        if (showParks) searchOverpassPOIs(AdvancedMarkerElement);
        updateRoutePolylines();
    });

    document.getElementById('toggle-tolls').addEventListener('change', (e) => {
        const showTolls = e.target.checked;
        dynamicOverpassFeatures.forEach(item => {
            if (item.poiType === 'toll_road') {
                if (item.setMap) item.setMap(showTolls ? map : null);
                else item.map = showTolls ? map : null;
            }
        });
        if (showTolls) searchOverpassPOIs(AdvancedMarkerElement);
        updateRoutePolylines();
    });

    document.getElementById('toggle-scenic').addEventListener('change', (e) => {
        updateRoutePolylines();
    });

    document.getElementById('toggle-water').addEventListener('change', (e) => {
        const showWater = e.target.checked;
        dynamicOverpassFeatures.forEach(item => {
            if (item.poiType === 'drinking_water') {
                if (item.setMap) item.setMap(showWater ? map : null);
                else item.map = showWater ? map : null;
            }
        });
        if (showWater) { searchOverpassPOIs(AdvancedMarkerElement); searchDrinkingWater(AdvancedMarkerElement); }
        updateRoutePolylines();
    });

    document.getElementById('toggle-car-repair').addEventListener('change', (e) => {
        const showCarRepair = e.target.checked;
        const filtersPanel = document.getElementById('car-repair-filters');
        if (filtersPanel) filtersPanel.style.display = showCarRepair ? 'block' : 'none';
        if (showCarRepair) {
            searchCarRepair(AdvancedMarkerElement);
        } else {
            clearCarRepairMarkers();
            allCarRepairPlaces = [];
            if (carRepairFetchTimer) clearTimeout(carRepairFetchTimer);
            carRepairFetchTimer = null;
            carRepairBoundsKey = null;
            setTextStatus('car-repair-status', '');
        }
    });

    const carRepairFilterIds = ['car-repair-min-spots', 'car-repair-radius'];
    const onCarRepairFilterChange = () => {
        // Filters changed. Re-apply to existing data; if no data yet, fetch fresh.
        const toggle = document.getElementById('toggle-car-repair');
        if (!toggle || !toggle.checked) return;
        if (allCarRepairPlaces.length > 0) {
            applyCarRepairFilters(AdvancedMarkerElement);
        } else {
            carRepairFiltersDirty = true;
            searchCarRepair(AdvancedMarkerElement);
        }
    };
    carRepairFilterIds.forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('input', onCarRepairFilterChange);
        input.addEventListener('change', onCarRepairFilterChange);
    });

    document.getElementById('toggle-activities').addEventListener('change', (e) => {
        const showActivities = e.target.checked;
        const filtersPanel = document.getElementById('activities-filters');
        if (filtersPanel) filtersPanel.style.display = showActivities ? 'block' : 'none';
        activityMarkers.forEach(marker => {
            marker.map = showActivities ? map : null;
        });
        activityConnectorLines.forEach(line => {
            line.setMap(showActivities ? map : null);
        });
        activityAnchorMarkers.forEach(marker => {
            if (typeof marker.setMap === 'function') marker.setMap(showActivities ? map : null);
            else marker.map = showActivities ? map : null;
        });
        if (showActivities) {
            searchActivities(AdvancedMarkerElement);
        } else {
            clearActivityMarkers();
            if (activityFetchTimer) clearTimeout(activityFetchTimer);
            activityFetchTimer = null;
            lastActivityBoundsKey = null;
            setTextStatus('activities-status', '');
        }
    });

    const activityFilterIds = [
        'activities-price-max',
        'activities-date-from',
        'activities-date-to',
    ];
    activityFilterIds.forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('input', () => applyActivityFiltersAndRender(AdvancedMarkerElement));
        input.addEventListener('change', () => applyActivityFiltersAndRender(AdvancedMarkerElement));
    });

    const maxRange = document.getElementById('activities-price-max-range');
    const minInput = document.getElementById('activities-price-min');
    const maxInput = document.getElementById('activities-price-max');

    const syncFromRange = () => {
        if (!maxRange || !minInput || !maxInput) return;
        const minVal = parseNumber(minInput.value) ?? 0;
        const maxVal = Number(maxRange.value || 0);
        maxInput.value = String(maxVal);
        const currency = (allActivities.find(a => a?.price?.currency)?.price?.currency) || 'EUR';
        syncActivityPriceLabels(minVal, maxVal, currency);
        applyActivityFiltersAndRender(AdvancedMarkerElement);
    };

    const syncFromInputs = () => {
        if (!maxRange || !minInput || !maxInput) return;
        let minVal = parseNumber(minInput.value);
        let maxVal = parseNumber(maxInput.value);
        if (minVal === null || maxVal === null) return;
        maxRange.value = String(maxVal);
        const currency = (allActivities.find(a => a?.price?.currency)?.price?.currency) || 'EUR';
        syncActivityPriceLabels(minVal, maxVal, currency);
    };

    if (maxRange) maxRange.addEventListener('input', syncFromRange);
    if (minInput) minInput.addEventListener('change', syncFromInputs);
    if (maxInput) maxInput.addEventListener('change', syncFromInputs);

    const resetBtn = document.getElementById('activities-reset-filters');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetActivityFilters();
            applyActivityFiltersAndRender(AdvancedMarkerElement);
        });
    }

    document.getElementById('toggle-foraging').addEventListener('change', (e) => {
        const enabled = e.target.checked;
        const strip = document.getElementById('foraging-strip');
        if (strip) {
            strip.classList.toggle('hidden', !enabled);
        }
        if (!enabled) {
            clearForagingLayer();
        } else {
            updateForagingLayer(true);
        }
    });

    document.getElementById('toggle-services').addEventListener('change', (e) => {
        const checked = e.target.checked;
        const servicesPanel = document.getElementById('services-panel');
        const providerPanel = document.getElementById('provider-panel');
        if (servicesPanel) {
            servicesPanel.style.display = checked ? 'block' : 'none';
        }
        if (providerPanel) {
            providerPanel.style.display = checked ? 'block' : 'none';
        }
    });

    const updateHikingFeaturesVisibility = () => {
        const showScenic = document.getElementById('toggle-scenic').checked;
        const showTrails = document.getElementById('toggle-trails').checked;
        const hikingFeatures = document.getElementById('hiking-features');
        if (hikingFeatures) {
            hikingFeatures.style.display = (showScenic || showTrails) ? 'block' : 'none';
        }
    };

    const updateSacFiltersVisibility = () => {
        const showTrails = document.getElementById('toggle-trails').checked;
        const sacFilters = document.getElementById('sac-filters');
        if (sacFilters) {
            sacFilters.style.display = showTrails ? 'block' : 'none';
        }
    };

    document.getElementById('toggle-scenic').addEventListener('change', updateHikingFeaturesVisibility);
    document.getElementById('toggle-trails').addEventListener('change', updateHikingFeaturesVisibility);
    document.getElementById('toggle-trails').addEventListener('change', updateSacFiltersVisibility);
    updateHikingFeaturesVisibility();
    updateSacFiltersVisibility();

    // Help toggle
    document.getElementById('help-toggle').addEventListener('click', () => {
        const helpPanel = document.getElementById('help-panel');
        if (helpPanel) {
            helpPanel.classList.toggle('hidden');
        }
    });

    // Show/hide fuel help item based on fuel toggle availability
    const labelFuel = document.getElementById('label-fuel');
    if (labelFuel && labelFuel.style.display !== 'none') {
        const helpFuel = document.getElementById('help-fuel');
        if (helpFuel) helpFuel.style.display = 'block';
    }
}

function clearForagingLayer() {
    foragingLabels.forEach(label => label.setMap(null));
    foragingLabels = [];
    const strip = document.getElementById('foraging-strip');
    if (strip) {
        strip.innerHTML = '';
        strip.classList.add('hidden');
    }
    lastForagingBoundsKey = null;
}

function boundsKey(bounds) {
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    return [ne.lat().toFixed(3), ne.lng().toFixed(3), sw.lat().toFixed(3), sw.lng().toFixed(3)].join(',');
}

function renderForagingStrip(speciesSummary, speciesIndex) {
    const strip = document.getElementById('foraging-strip');
    if (!strip) {
        console.error('foraging-strip element not found!');
        return;
    }
    strip.innerHTML = '';
    console.log('Rendering foraging strip with', speciesSummary.length, 'species');

    speciesSummary.forEach(speciesId => {
        const item = speciesIndex[speciesId];
        if (!item) {
            console.warn('Species ID not found in index:', speciesId);
            return;
        }
        console.log('Rendering species card:', {
            id: speciesId,
            name: item.name_hu,
            picture_url: item.picture_url,
            has_picture: !!item.picture_url
        });
        const card = document.createElement('a');
        card.className = 'foraging-card';
        card.href = item.wikipedia_url || '#';
        card.target = '_blank';
        card.rel = 'noopener';

        if (item.toxicity_risk === 'high') {
            card.classList.add('tox-high');
        } else if (item.toxicity_risk === 'low') {
            card.classList.add('tox-low');
        }

        const img = document.createElement('img');
        img.src = item.picture_url || '';
        img.alt = item.name_hu || 'Mushroom';
        img.onerror = function() {
            console.warn('Failed to load image:', item.picture_url, 'for species:', item.name_hu);
            img.style.display = 'none'; // Hide broken image
        };
        img.onload = function() {
            console.log('Successfully loaded image for:', item.name_hu);
        };
        
        const label = document.createElement('span');
        label.textContent = item.name_hu || '';
        label.style.color = item.color || '#222';

        card.appendChild(img);
        card.appendChild(label);
        strip.appendChild(card);
    });

    strip.classList.toggle('hidden', speciesSummary.length === 0);
}

function renderForagingLabels(features, speciesIndex) {
    foragingLabels.forEach(label => label.setMap(null));
    foragingLabels = [];

    if (!ForagingLabel) return;

    const grouped = {};
    features.forEach(feature => {
        const props = feature.properties || {};
        const lat = props.center_lat;
        const lng = props.center_lng;
        if (typeof lat !== 'number' || typeof lng !== 'number') return;
        const key = `${lat.toFixed(4)}|${lng.toFixed(4)}`;
        grouped[key] = grouped[key] || [];
        grouped[key].push(feature);
    });

    Object.values(grouped).forEach((group) => {
        group.forEach((feature, index) => {
            const props = feature.properties || {};
            const lat = props.center_lat;
            const lng = props.center_lng;
            const meta = speciesIndex[props.species_id] || {};
            const label = new ForagingLabel(
                new google.maps.LatLng(lat, lng),
                meta.name_hu || props.dominant_species_name || 'Unknown',
                meta.color || '#ffffff',
                meta.wikipedia_url || '',
                index * 14
            );
            label.setMap(map);
            foragingLabels.push(label);
        });
    });
}

function updateForagingLayer(force = false) {
    const toggle = document.getElementById('toggle-foraging');
    if (!toggle || !toggle.checked) return;
    if (!map) return;
    if (map.getZoom() < 13) {
        clearForagingLayer();
        return;
    }

    const bounds = map.getBounds();
    if (!bounds) return;

    const key = boundsKey(bounds);
    if (!force && key === lastForagingBoundsKey) return;
    lastForagingBoundsKey = key;

    if (foragingFetchTimer) {
        clearTimeout(foragingFetchTimer);
    }

    foragingFetchTimer = setTimeout(async () => {
        const spinner = document.getElementById('loading-foraging');
        if (spinner) spinner.style.display = 'inline';
        
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const params = new URLSearchParams({
            min_lat: sw.lat(),
            min_lng: sw.lng(),
            max_lat: ne.lat(),
            max_lng: ne.lng(),
            zoom: map.getZoom()
        });
        try {
            const res = await fetch(`${BACKEND_URL}/api/foraging-probability?${params.toString()}`);
            if (!res.ok) throw new Error('Foraging request failed');
            const payload = await res.json();
            console.log('Foraging API response:', {
                features: payload.features?.length || 0,
                species_summary: payload.species_summary || [],
                species_index_keys: Object.keys(payload.species_index || {}),
                message: payload.message
            });
            if (payload.message === 'zoom_too_low') {
                clearForagingLayer();
                return;
            }
            renderForagingLabels(payload.features || [], payload.species_index || {});
            renderForagingStrip(payload.species_summary || [], payload.species_index || {});
        } catch (e) {
            console.warn('Foraging layer error:', e);
        } finally {
            const spinner = document.getElementById('loading-foraging');
            if (spinner) spinner.style.display = 'none';
        }
    }, 400);
}

async function searchPOIs(AdvancedMarkerElement) {
    const bounds = map.getBounds();
    if (!bounds) return;

    // Check if toggle is checked FIRST before making any requests
    const showScenic = document.getElementById('toggle-scenic').checked;
    if (!showScenic) return;

    const spinner = document.getElementById('loading-scenic');
    if (spinner) spinner.style.display = 'inline';

    // Use the New Places API to fetch "scenic viewpoints OR hiking areas OR gorges OR waterfalls OR nature reserves"
    const { Place } = await google.maps.importLibrary("places");

    const request = {
        textQuery: "scenic viewpoint OR hiking area OR gorge OR waterfall OR nature reserve",
        fields: ["id", "displayName", "location", "rating", "userRatingCount", "photos"],
        locationRestriction: bounds,
    };

    try {
        const { places } = await Place.searchByText(request);
        
        let filteredResults = [];
        if (places && places.length > 0) {
            filteredResults = places.filter(place => 
                place.rating && place.rating >= 4.5 && 
                place.userRatingCount && place.userRatingCount >= 20 &&
                place.photos && place.photos.length > 0
            );

            filteredResults.forEach(place => {
                createMarker(place, AdvancedMarkerElement);
            });
        }
        
        // Always render favorites regardless of search results
        Object.values(favorites).forEach(fav => {
            const isPlotted = filteredResults.some(r => r.id === (fav.id || fav.place_id));
            if (!isPlotted) {
                createMarker(fav, AdvancedMarkerElement, true);
            }
        });  
    } catch (e) {
        console.error("Places search error:", e);
    } finally {
        const spinner = document.getElementById('loading-scenic');
        if (spinner) spinner.style.display = 'none';
        // Scenic spots just got updated — re-apply the car repair filter so
        // the count badge and visibility stay in sync with the new data.
        const carRepairToggle = document.getElementById('toggle-car-repair');
        if (carRepairToggle && carRepairToggle.checked && allCarRepairPlaces.length > 0) {
            applyCarRepairFilters(AdvancedMarkerElement);
        }
    }
}

function createMarker(place, AdvancedMarkerElement, isFavFallback = false, isSuggestion = false) {
    const pid = place.id || place.place_id;
    const isFav = favorites[pid] !== undefined;
    const title = place.displayName || place.name || "Unknown Place";
    
    const markerDiv = document.createElement("div");
    let classes = ["custom-marker"];
    if (isFav) classes.push("favorite");
    if (isSuggestion) classes.push("suggestion");
    
    // Check if place was mentioned by AI
    const titleLower = title.toLowerCase();
    const isMentioned = mentionedPOINames.some(name => titleLower.includes(name) || name.includes(titleLower));
    if (isMentioned) classes.push("mentioned-poi");
    
    markerDiv.className = classes.join(" ");
    
    let photoUrl = null;
    if (place.photos && place.photos.length > 0) {
        if (typeof place.photos[0].getURI === 'function') {
            photoUrl = place.photos[0].getURI({maxHeight: 250, maxWidth: 250});
        } else if (typeof place.photos[0] === 'string') {
            photoUrl = place.photos[0];
        }
    } else if (place.photoUrl) {
        photoUrl = place.photoUrl;
    }
    
    if (photoUrl) {
        markerDiv.style.backgroundImage = `url(${photoUrl})`;
    }
    
    const rating = place.rating || 4.5;
    const clampedRating = Math.max(4.5, Math.min(5.0, rating));
    const factor = 1 + (clampedRating - 4.5) * 2; // 4.5 -> 1.0x, 5.0 -> 2.0x
    const size = Math.round(80 * factor);
    
    markerDiv.style.width = `${size}px`;
    markerDiv.style.height = `${size}px`;
    
    const position = place.location ? place.location : {lat: place.lat, lng: place.lng};
    
    const marker = new AdvancedMarkerElement({
        map,
        position: position,
        title: title,
        content: markerDiv
    });
    
    marker.place_id = pid;
    
    marker.addListener("gmp-click", () => {
        openModal(place);
    });
    
    if (isSuggestion) {
        suggestionMarkers.push(marker);
    } else {
        markers.push(marker);
    }
}

function clearMarkers() {
    markers.forEach(m => m.map = null);
    markers = [];
    
    // We intentionally do NOT clear suggestionMarkers here, 
    // so they persist while the user pans the map to view them.
    // They are cleared when a new suggestion is requested.
}

function clearFuelMarkers() {
    fuelMarkers.forEach(m => m.map = null);
    fuelMarkers = [];
}


function clearActivityMarkers() {
    activityMarkers.forEach(m => m.map = null);
    activityMarkers = [];
    activityConnectorLines.forEach(line => line.setMap(null));
    activityConnectorLines = [];
    activityAnchorMarkers.forEach(m => {
        if (typeof m.setMap === 'function') m.setMap(null);
        else m.map = null;
    });
    activityAnchorMarkers = [];
}


function metersToLatLngOffset(baseLat, baseLng, eastMeters, northMeters) {
    const dLat = northMeters / 111320;
    const dLng = eastMeters / (111320 * Math.cos(baseLat * Math.PI / 180));
    return {
        lat: baseLat + dLat,
        lng: baseLng + dLng,
    };
}


function getActivityClusterRadiusMeters(zoom) {
    // Larger grouping at low zoom, tighter grouping when zoomed in.
    const z = Number.isFinite(zoom) ? zoom : 13;
    return Math.max(35, Math.min(180, 220 - (z * 10)));
}


function clusterActivitiesByDistance(items, zoom) {
    const radiusMeters = getActivityClusterRadiusMeters(zoom);
    const clusters = [];

    items.forEach((item) => {
        if (typeof item.lat !== 'number' || typeof item.lng !== 'number') return;

        let target = null;
        let bestDistance = Infinity;
        clusters.forEach((cluster) => {
            const distanceMeters = getDistanceKm(item.lat, item.lng, cluster.centerLat, cluster.centerLng) * 1000;
            if (distanceMeters <= radiusMeters && distanceMeters < bestDistance) {
                target = cluster;
                bestDistance = distanceMeters;
            }
        });

        if (!target) {
            clusters.push({
                items: [item],
                centerLat: item.lat,
                centerLng: item.lng,
            });
            return;
        }

        target.items.push(item);
        const n = target.items.length;
        target.centerLat = ((target.centerLat * (n - 1)) + item.lat) / n;
        target.centerLng = ((target.centerLng * (n - 1)) + item.lng) / n;
    });

    return clusters;
}


function activityClusterKey(cluster) {
    return cluster.items
        .map(item => `${item.name || 'activity'}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`)
        .sort()
        .join('|');
}


function activityBoundsKey(bounds) {
    if (!bounds) return '';
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    // 4 decimals ~= 11m, enough to avoid churn from tiny viewport shifts
    return [ne.lat().toFixed(4), ne.lng().toFixed(4), sw.lat().toFixed(4), sw.lng().toFixed(4)].join(',');
}


function scheduleActivityRefresh(AdvancedMarkerElement) {
    const toggle = document.getElementById('toggle-activities');
    if (!toggle || !toggle.checked) return;

    const now = Date.now();
    if (now < suppressActivityRefreshUntil) return;

    const bounds = map?.getBounds();
    if (!bounds) return;

    const key = activityBoundsKey(bounds);
    if (key && key === lastActivityBoundsKey) return;

    if (activityFetchTimer) clearTimeout(activityFetchTimer);
    activityFetchTimer = setTimeout(() => {
        searchActivities(AdvancedMarkerElement);
    }, 250);
}


function toDateOnly(value) {
    if (!value) return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}


function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}


function syncActivityPriceLabels(minValue, maxValue, currency = 'EUR') {
    const minLabel = document.getElementById('activities-price-min-label');
    const maxLabel = document.getElementById('activities-price-max-label');
    if (minLabel) minLabel.textContent = `${Math.round(minValue)} ${currency}`;
    if (maxLabel) maxLabel.textContent = `Up to ${Math.round(maxValue)} ${currency}`;
}


function syncActivityPriceControlsFromData() {
    const prices = allActivities
        .map(item => parseNumber(item?.price?.amount))
        .filter(v => v !== null);
    if (!prices.length) return;

    const minBound = Math.floor(Math.min(...prices));
    const maxBound = Math.ceil(Math.max(...prices));
    const currency = (allActivities.find(a => a?.price?.currency)?.price?.currency) || 'EUR';

    const minInput = document.getElementById('activities-price-min');
    const maxInput = document.getElementById('activities-price-max');
    const maxRange = document.getElementById('activities-price-max-range');

    [minInput, maxInput, maxRange].forEach(el => {
        if (!el) return;
        el.min = String(minBound);
        el.max = String(maxBound);
    });

    const currentMax = parseNumber(maxInput?.value);
    const safeMin = minBound;
    const safeMax = currentMax === null ? maxBound : Math.max(Math.min(currentMax, maxBound), minBound);

    if (minInput) minInput.value = String(safeMin);
    if (maxInput) maxInput.value = String(safeMax);
    if (maxRange) maxRange.value = String(safeMax);

    syncActivityPriceLabels(safeMin, safeMax, currency);
}


function resetActivityFilters() {
    const minInput = document.getElementById('activities-price-min');
    const maxInput = document.getElementById('activities-price-max');
    const fromInput = document.getElementById('activities-date-from');
    const toInput = document.getElementById('activities-date-to');
    if (fromInput) fromInput.value = '';
    if (toInput) toInput.value = '';

    if (minInput) minInput.value = '';
    if (maxInput) maxInput.value = '';
    syncActivityPriceControlsFromData();
}


function renderActivityMarkers(items, AdvancedMarkerElement) {
    clearActivityMarkers();

    const clusters = clusterActivitiesByDistance(items, map?.getZoom());

    // Keep expansion state only for currently visible clusters.
    const validKeys = new Set(clusters.map(cluster => activityClusterKey(cluster)));
    activityClusterExpanded.forEach((_, key) => {
        if (!validKeys.has(key)) activityClusterExpanded.delete(key);
    });

    clusters.forEach((cluster) => {
        const originLat = cluster.centerLat;
        const originLng = cluster.centerLng;
        const clusterSize = cluster.items.length;
        const key = activityClusterKey(cluster);
        const expanded = activityClusterExpanded.has(key)
            ? !!activityClusterExpanded.get(key)
            : clusterSize === 1;

        const anchorDiv = document.createElement('div');
        anchorDiv.style.width = clusterSize > 1 ? '28px' : '14px';
        anchorDiv.style.height = clusterSize > 1 ? '28px' : '14px';
        anchorDiv.style.borderRadius = '50%';
        anchorDiv.style.background = '#5a32a3';
        anchorDiv.style.border = '2px solid #fff';
        anchorDiv.style.boxShadow = '0 0 0 2px rgba(90,50,163,0.25)';
        anchorDiv.style.color = '#fff';
        anchorDiv.style.fontSize = '11px';
        anchorDiv.style.fontWeight = '700';
        anchorDiv.style.display = 'flex';
        anchorDiv.style.alignItems = 'center';
        anchorDiv.style.justifyContent = 'center';
        anchorDiv.textContent = clusterSize > 1 ? String(clusterSize) : '';
        anchorDiv.title = clusterSize > 1
            ? `${clusterSize} nearby activities (${expanded ? 'hide' : 'show'})`
            : 'Activity location';

        const anchorMarker = new AdvancedMarkerElement({
            map,
            position: { lat: originLat, lng: originLng },
            title: anchorDiv.title,
            content: anchorDiv,
            collisionBehavior: google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL,
        });
        anchorMarker.addListener('gmp-click', () => {
            suppressActivityRefreshUntil = Date.now() + 700;
            const current = activityClusterExpanded.has(key)
                ? !!activityClusterExpanded.get(key)
                : clusterSize === 1;
            activityClusterExpanded.set(key, !current);
            renderActivityMarkers(filteredActivities, AdvancedMarkerElement);
        });
        activityAnchorMarkers.push(anchorMarker);

        if (!expanded) return;

        cluster.items.forEach((item, idx) => {
            if (typeof item.lat !== 'number' || typeof item.lng !== 'number') return;

            const amount = item.price?.amount;
            const currency = item.price?.currency || 'EUR';
            const priceLabel = typeof amount === 'number' ? `${Math.round(amount)} ${currency}` : 'Info';
            const title = item.name || 'Activity';

            // Side-by-side grid around real location.
            const cols = 4;
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const eastMeters = 70 + (col * 95);
            const northMeters = 60 - (row * 70);
            const labelPos = metersToLatLngOffset(originLat, originLng, eastMeters, northMeters);

            const markerDiv = document.createElement('div');
            markerDiv.className = 'custom-marker extra-poi activity-poi';
            markerDiv.style.backgroundColor = '#6f42c1';
            markerDiv.style.borderColor = '#5a32a3';
            markerDiv.style.width = 'auto';
            markerDiv.style.height = 'auto';
            markerDiv.style.minHeight = 'unset';
            markerDiv.style.maxWidth = '260px';
            markerDiv.style.padding = '4px 8px';
            markerDiv.style.borderRadius = '8px';
            markerDiv.style.display = 'flex';
            markerDiv.style.flexDirection = 'column';
            markerDiv.style.alignItems = 'center';
            markerDiv.style.justifyContent = 'center';
            markerDiv.style.lineHeight = '1.2';
            markerDiv.style.gap = '4px';
            markerDiv.innerHTML = `<div style="font-size:10px;font-weight:700;color:#fff;white-space:normal;overflow-wrap:anywhere;word-break:break-word;text-align:center;max-width:240px;display:block;">${title}</div><div style="font-size:10px;font-weight:700;color:#fff;display:block;margin-top:2px;">${priceLabel}</div>`;

            const connector = new google.maps.Polyline({
                path: [
                    { lat: originLat, lng: originLng },
                    { lat: labelPos.lat, lng: labelPos.lng },
                ],
                geodesic: true,
                strokeColor: '#5a32a3',
                strokeOpacity: 0.9,
                strokeWeight: 4,
                map,
            });
            activityConnectorLines.push(connector);

            const marker = new AdvancedMarkerElement({
                map,
                position: labelPos,
                title,
                content: markerDiv,
                // Expanded cluster must reveal all connected labels, not hide overlapping ones.
                collisionBehavior: google.maps.CollisionBehavior.REQUIRED,
                zIndex: 2000 + idx,
            });

            marker.addListener('gmp-click', () => {
                if (!sharedInfoWindow) {
                    sharedInfoWindow = new google.maps.InfoWindow({ disableAutoPan: true, maxWidth: 320 });
                }
                // Clicking a marker should not immediately trigger a refresh cycle caused by map movement.
                suppressActivityRefreshUntil = Date.now() + 1200;
                const book = item.booking_link
                    ? `<a href="${item.booking_link}" target="_blank" style="display:inline-block;margin-top:8px;padding:5px 10px;background:#6f42c1;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;">Open Activity</a>`
                    : `<a href="${item.maps_url}" target="_blank" style="display:inline-block;margin-top:8px;padding:5px 10px;background:#0d6efd;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;">Open in Maps</a>`;

                const rating = item.rating ? `<div style="font-size:12px;color:#555;">Rating: ${item.rating}</div>` : '';
                const details = item.short_description ? `<div style="font-size:12px;color:#444;margin-top:4px;">${item.short_description}</div>` : '';
                const amountText = typeof item.price?.amount === 'number' ? `${Math.round(item.price.amount)} ${item.price.currency || 'EUR'}` : 'Price on request';
                const dateLine = (item.start_date || item.end_date)
                    ? `<div style="font-size:12px;color:#555;">${item.start_date || ''}${item.end_date ? ` - ${item.end_date}` : ''}</div>`
                    : '';

                sharedInfoWindow.setContent(`
                    <div style="color:#111;max-width:260px;">
                        <div style="font-size:14px;font-weight:700;">${title}</div>
                        <div style="font-size:13px;color:#6f42c1;font-weight:600;margin-top:2px;">${amountText}</div>
                        ${dateLine}
                        ${rating}
                        ${details}
                        ${book}
                    </div>
                `);
                sharedInfoWindow.open({ map, anchor: marker });
            });

            marker.markerType = 'activity';
            activityMarkers.push(marker);
        });
    });
}


function applyActivityFiltersAndRender(AdvancedMarkerElement) {
    const minInput = document.getElementById('activities-price-min');
    const maxInput = document.getElementById('activities-price-max');
    const fromInput = document.getElementById('activities-date-from');
    const toInput = document.getElementById('activities-date-to');
    const dateFiltersWrap = document.getElementById('activities-date-filters');

    const minPrice = parseNumber(minInput?.value);
    const maxPrice = parseNumber(maxInput?.value);
    const fromDate = fromInput?.value || '';
    const toDate = toInput?.value || '';

    const hasDateData = allActivities.some(a => toDateOnly(a.start_date) || toDateOnly(a.end_date));
    if (dateFiltersWrap) dateFiltersWrap.style.display = hasDateData ? 'block' : 'none';

    filteredActivities = allActivities.filter((item) => {
        const amount = item.price?.amount;
        if (minPrice !== null && typeof amount === 'number' && amount < minPrice) return false;
        if (maxPrice !== null && typeof amount === 'number' && amount > maxPrice) return false;

        if (hasDateData && (fromDate || toDate)) {
            const start = toDateOnly(item.start_date);
            const end = toDateOnly(item.end_date) || start;
            if (!start && !end) return false;
            if (fromDate && end && end < fromDate) return false;
            if (toDate && start && start > toDate) return false;
        }
        return true;
    });

    renderActivityMarkers(filteredActivities, AdvancedMarkerElement);
    setTextStatus('activities-status', `Showing ${filteredActivities.length} of ${allActivities.length} activities`);
}


async function searchActivities(AdvancedMarkerElement) {
    const toggle = document.getElementById('toggle-activities');
    if (!toggle || !toggle.checked) return;

    const bounds = map.getBounds();
    if (!bounds) return;
    const currentKey = activityBoundsKey(bounds);

    const spinner = document.getElementById('loading-activities');
    if (spinner) spinner.style.display = 'inline';

    try {
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const center = map.getCenter();
        const radiusKm = Math.min(Math.max(Math.round(getDistanceKm(center.lat(), center.lng(), ne.lat(), ne.lng())), 1), 50);

        const url = `${BACKEND_URL}/api/activities?min_lat=${sw.lat()}&min_lng=${sw.lng()}&max_lat=${ne.lat()}&max_lng=${ne.lng()}&lat=${center.lat()}&lng=${center.lng()}&radius_km=${radiusKm}`;
        const res = await fetch(url);
        if (!res.ok) return;

        const payload = await res.json();
        allActivities = payload.data || [];
        syncActivityPriceControlsFromData();
        applyActivityFiltersAndRender(AdvancedMarkerElement);
        lastActivityBoundsKey = currentKey;
    } catch (e) {
        console.error('Activities search error:', e);
    } finally {
        if (spinner) spinner.style.display = 'none';
    }
}


async function searchDrinkingWater(AdvancedMarkerElement) {
    const bounds = map.getBounds();
    if (!bounds) return;
    
    const showWater = document.getElementById('toggle-water').checked;
    if (!showWater) return;
    
    const spinner = document.getElementById('loading-water');
    if (spinner) spinner.style.display = 'inline';
    
    const { Place } = await google.maps.importLibrary("places");
    
    const request = {
        textQuery: "drinking water OR water fountain OR public water",
        locationRestriction: bounds,
        fields: ["id", "displayName", "location", "nationalPhoneNumber"]
    };
    
    try {
        const { places } = await Place.searchByText(request);
        if (!places || places.length === 0) return;
        
        places.forEach(place => {
            const pid = place.id || place.place_id;
            // Prevent duplicates
            if (dynamicOverpassFeatures.some(f => f.poiId === pid)) return;
            
            const position = place.location ? place.location : {lat: place.lat, lng: place.lng};
            const markerDiv = document.createElement("div");
            markerDiv.className = "custom-marker extra-poi";
            markerDiv.style.backgroundColor = "#0dcaf0";
            markerDiv.style.borderColor = "#087990";
            markerDiv.innerHTML = `<span style="font-size: 24px; display: flex; justify-content: center; align-items: center; width: 100%; height: 100%;">💧</span>`;
            
            const marker = new AdvancedMarkerElement({
                map: map,
                position: position,
                title: place.displayName || place.name || "Drinking Water",
                content: markerDiv
            });
            
            marker.addListener('gmp-click', () => {
                if (!sharedInfoWindow) sharedInfoWindow = new google.maps.InfoWindow();
                const props = {
                    type: "drinking_water",
                    name: place.displayName || place.name || "Drinking Water",
                    phone: place.nationalPhoneNumber || ""
                };
                // Make sure we pass place_id so the generic populatePlaceDetails works if needed
                // actually populatePlaceDetails uses props.id
                props.id = pid; 
                populatePlaceDetails(props, position, sharedInfoWindow, marker);
            });
            
            marker.poiType = "drinking_water";
            marker.poiId = pid;
            dynamicOverpassFeatures.push(marker);
        });
    } catch (e) {
        console.error("Drinking water places search error:", e);
    } finally {
        const spinner = document.getElementById('loading-water');
        if (spinner) spinner.style.display = 'none';
    }
}


function carRepairBoundsKeyValue(bounds) {
    if (!bounds) return '';
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    return [
        ne.lat().toFixed(4),
        ne.lng().toFixed(4),
        sw.lat().toFixed(4),
        sw.lng().toFixed(4),
    ].join(',');
}


function scheduleCarRepairRefresh(AdvancedMarkerElement) {
    const toggle = document.getElementById('toggle-car-repair');
    if (!toggle || !toggle.checked) return;
    if (!map) return;
    const bounds = map.getBounds();
    if (!bounds) return;
    const key = carRepairBoundsKeyValue(bounds);
    if (key && key === carRepairBoundsKey) return;
    if (carRepairFetchTimer) clearTimeout(carRepairFetchTimer);
    carRepairFetchTimer = setTimeout(() => {
        searchCarRepair(AdvancedMarkerElement);
    }, 350);
}


function getCarRepairFilterValues() {
    const minRaw = document.getElementById('car-repair-min-spots')?.value;
    const radRaw = document.getElementById('car-repair-radius')?.value;
    // Treat empty string as "use default" so the user can clear inputs to fall back to defaults.
    const minSpots = (minRaw === '' || minRaw === null || minRaw === undefined)
        ? 3
        : Math.max(0, Math.floor(Number(minRaw) || 0));
    const radiusKm = (radRaw === '' || radRaw === null || radRaw === undefined)
        ? 30
        : Math.max(1, Number(radRaw) || 30);
    return { minSpots, radiusKm };
}


function getVisibleScenicSpots() {
    // Use the scenic spots that are currently in the global `markers` array.
    // These are visible when the scenic layer is on.
    const scenicToggle = document.getElementById('toggle-scenic');
    const scenicOn = scenicToggle ? scenicToggle.checked : false;
    if (!scenicOn) return { visible: false, spots: [] };

    const spots = [];
    markers.forEach((m) => {
        if (!m || !m.position) return;
        const pos = typeof m.position === 'function' ? m.position() : m.position;
        if (!pos) return;
        const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
        const lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
        if (typeof lat === 'number' && typeof lng === 'number') {
            spots.push({ lat, lng, place_id: m.place_id || null });
        }
    });
    return { visible: true, spots };
}


function countScenicSpotsNearby(repairLat, repairLng, spots, radiusKm) {
    if (!spots || spots.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        if (getDistanceKm(repairLat, repairLng, s.lat, s.lng) <= radiusKm) {
            count += 1;
        }
    }
    return count;
}


async function searchCarRepair(AdvancedMarkerElement) {
    const toggle = document.getElementById('toggle-car-repair');
    if (!toggle || !toggle.checked) return;
    if (!map) return;
    const bounds = map.getBounds();
    if (!bounds) return;

    const currentKey = carRepairBoundsKeyValue(bounds);
    const spinner = document.getElementById('loading-car-repair');
    if (spinner) spinner.style.display = 'inline';

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const url = `${BACKEND_URL}/api/car-repair?min_lat=${sw.lat()}&min_lng=${sw.lng()}&max_lat=${ne.lat()}&max_lng=${ne.lng()}`;

    try {
        const res = await fetch(url);
        if (!res.ok) {
            setTextStatus('car-repair-status', `Car repair lookup failed (HTTP ${res.status})`, true);
            return;
        }
        const payload = await res.json();
        allCarRepairPlaces = Array.isArray(payload.data) ? payload.data : [];
        carRepairBoundsKey = currentKey;
        applyCarRepairFilters(AdvancedMarkerElement);
    } catch (e) {
        console.error('Car repair search error:', e);
        setTextStatus('car-repair-status', e.message || 'Car repair search failed', true);
    } finally {
        if (spinner) spinner.style.display = 'none';
        carRepairFiltersDirty = false;
    }
}


function applyCarRepairFilters(AdvancedMarkerElement) {
    const toggle = document.getElementById('toggle-car-repair');
    if (!toggle || !toggle.checked) return;

    const { minSpots, radiusKm } = getCarRepairFilterValues();
    const scenicState = getVisibleScenicSpots();
    const scenicEnabled = scenicState.visible;
    const scenicSpots = scenicState.spots;

    const visiblePlaces = [];
    const totalCount = allCarRepairPlaces.length;
    let hiddenByFilter = 0;
    allCarRepairPlaces.forEach((place) => {
        let count = 0;
        if (scenicEnabled) {
            count = countScenicSpotsNearby(place.lat, place.lng, scenicSpots, radiusKm);
        }
        // When scenic layer is OFF we have no spots to count, so fall back to "0" which
        // would otherwise hide the place. Treat the filter as disabled in that case.
        if (!scenicEnabled) {
            visiblePlaces.push({ place, scenicCount: 0 });
        } else if (count >= minSpots) {
            visiblePlaces.push({ place, scenicCount: count });
        } else {
            hiddenByFilter += 1;
        }
    });

    clearCarRepairMarkers();
    visiblePlaces.forEach(({ place, scenicCount }) => {
        const marker = createCarRepairMarker(place, scenicCount, scenicEnabled, AdvancedMarkerElement);
        if (marker) carRepairMarkers.push(marker);
    });

    let statusText;
    if (!scenicEnabled) {
        statusText = `Showing ${visiblePlaces.length} of ${totalCount} car repair shops (scenic layer is OFF — turn it on to apply spot filter).`;
    } else if (visiblePlaces.length === totalCount) {
        statusText = `Showing all ${totalCount} car repair shops (≥ 4.2★) with at least ${minSpots} scenic spot${minSpots === 1 ? '' : 's'} within ${radiusKm} km.`;
    } else {
        statusText = `Showing ${visiblePlaces.length} of ${totalCount} car repair shops (≥ 4.2★) with at least ${minSpots} scenic spot${minSpots === 1 ? '' : 's'} within ${radiusKm} km.`;
    }
    setTextStatus('car-repair-status', statusText);
}


function createCarRepairMarker(place, scenicCount, scenicEnabled, AdvancedMarkerElement) {
    if (!place || typeof place.lat !== 'number' || typeof place.lng !== 'number') return null;
    const title = place.name || 'Car repair';
    const rating = typeof place.rating === 'number' ? place.rating.toFixed(1) : '–';
    const userRatings = place.user_rating_count ? ` (${place.user_rating_count})` : '';
    const scenicBadge = scenicEnabled && scenicCount > 0
        ? ` <span style="background:#28a745;color:#fff;border-radius:8px;padding:1px 4px;font-size:10px;margin-left:2px;">${scenicCount}★</span>`
        : '';
    const icon = `<span style="font-size:18px;line-height:1;">🔧</span>`;
    const ratingLabel = `<span style="font-size:11px;font-weight:700;color:#fff;background:rgba(0,0,0,0.45);border-radius:6px;padding:1px 4px;margin-left:3px;">★${rating}${userRatings}</span>`;

    const markerDiv = document.createElement('div');
    markerDiv.className = 'custom-marker extra-poi car-repair-poi';
    markerDiv.style.backgroundColor = '#d97706';
    markerDiv.style.borderColor = '#92400e';
    markerDiv.style.color = '#fff';
    markerDiv.style.padding = '2px 4px';
    markerDiv.style.minWidth = 'unset';
    markerDiv.style.minHeight = 'unset';
    markerDiv.style.width = 'auto';
    markerDiv.style.height = 'auto';
    markerDiv.style.display = 'flex';
    markerDiv.style.alignItems = 'center';
    markerDiv.style.justifyContent = 'center';
    markerDiv.style.gap = '2px';
    markerDiv.innerHTML = `${icon}${ratingLabel}${scenicBadge}`;
    markerDiv.title = `${title} — ★${rating}${userRatings}${scenicEnabled && scenicCount > 0 ? ` • ${scenicCount} scenic spot${scenicCount === 1 ? '' : 's'} within filter radius` : ''}`;

    const marker = new AdvancedMarkerElement({
        map,
        position: { lat: place.lat, lng: place.lng },
        title: markerDiv.title,
        content: markerDiv,
    });
    marker.poiType = 'car_repair';
    marker.poiId = place.id;

    marker.addListener('gmp-click', () => {
        if (!sharedInfoWindow) sharedInfoWindow = new google.maps.InfoWindow();
        const types = Array.isArray(place.types) && place.types.length
            ? place.types.filter((t) => t !== 'point_of_interest' && t !== 'establishment').slice(0, 4).join(', ')
            : 'car_repair';
        const scenicLine = scenicEnabled
            ? `<div style="font-size:12px;color:#333;margin-top:4px;">📸 ${scenicCount} scenic spot${scenicCount === 1 ? '' : 's'} within ${getCarRepairFilterValues().radiusKm} km</div>`
            : `<div style="font-size:12px;color:#666;margin-top:4px;">ℹ️ Turn on the Scenic layer to see nearby scenic spots.</div>`;
        const addressLine = place.address
            ? `<div style="font-size:12px;color:#555;margin-top:4px;">${place.address}</div>`
            : '';
        const content = `
            <div style="color:#222;padding:6px;max-width:240px;">
                <strong>${title}</strong>
                <div style="font-size:12px;color:#444;margin-top:3px;">⭐ ${rating}${userRatings} <span style="color:#888;">•</span> ${types}</div>
                ${addressLine}
                ${scenicLine}
                <div style="margin-top:8px;text-align:center;">
                    <button onclick="window.open('https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}', '_blank')"
                        style="padding:5px 10px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;width:100%;">
                        Open in Google Maps
                    </button>
                </div>
            </div>`;
        sharedInfoWindow.setContent(content);
        sharedInfoWindow.open({ map, anchor: marker });
    });

    return marker;
}


function clearCarRepairMarkers() {
    carRepairMarkers.forEach((m) => { m.map = null; });
    carRepairMarkers = [];
}


async function searchFuelStations(AdvancedMarkerElement) {
    // Check if toggle is checked FIRST before making any requests
    const showFuel = document.getElementById('toggle-fuel').checked;
    if (!showFuel) return;
    
    const spinner = document.getElementById('loading-fuel');
    if (spinner) spinner.style.display = 'inline';
    
    const bounds = map.getBounds();
    if (!bounds) return;
    
    const center = map.getCenter();
    const ne = bounds.getNorthEast();
    
    const cLat = center.lat();
    const cLng = center.lng();
    
    // Calculate radius in meters based on distance to the furthest visible point (top-right)
    const radiusKm = getDistanceKm(cLat, cLng, ne.lat(), ne.lng());
    // HERE API might have a max limit for radius, capping at a reasonable number (e.g. 50km = 50000m)
    const radiusM = Math.min(Math.round(radiusKm * 1000), 50000);
    
    try {
        const response = await fetch(`${BACKEND_URL}/api/fuel-stations?lat=${cLat}&lng=${cLng}&radius=${radiusM}`);
        if (!response.ok) return; // Silent fail if HERE API isn't configured
        
        const data = await response.json();
        clearFuelMarkers();
        
        let stations = [];
        if (data.stations) {
            stations = data.stations;
        } else if (data.fuelStations && data.fuelStations.fuelStation) {
            stations = data.fuelStations.fuelStation;
        }

        if (stations.length > 0) {
            // Extract prices to find min and max
            let allPrices = [];
            stations.forEach(s => {
                const sp = s.prices || s.fuelPrice;
                if (sp && sp.length > 0) {
                    const sortedPrices = [...sp].sort((a,b) => a.price - b.price);
                    allPrices.push(sortedPrices[0].price);
                }
            });
            const minPrice = allPrices.length ? Math.min(...allPrices) : null;
            const maxPrice = allPrices.length ? Math.max(...allPrices) : null;

            stations = stations.filter(s => (s.prices && s.prices.length > 0) || (s.fuelPrice && s.fuelPrice.length > 0));
            stations.forEach(station => {
                let price = null;
                let priceText = "";
                let isMin = false;
                let isMax = false;
                let priceListHtml = "";
                
                const sp = station.prices || station.fuelPrice;
                if (sp && sp.length > 0) {
                    const sortedPrices = [...sp].sort((a,b) => a.price - b.price);
                    price = sortedPrices[0].price;
                    priceText = `${price} ${sortedPrices[0].currency}`;
                    if (price === minPrice) isMin = true;
                    if (price === maxPrice && price !== minPrice) isMax = true;
                    
                    priceListHtml = `<table style="width:100%; font-size:12px; margin-top:5px; border-collapse: collapse;">`;
                    sp.forEach(p => {
                        let typeName = p.fuelType;
                        if (typeName == "1" || typeName == "11") typeName = "Diesel";
                        if (typeName == "53" || typeName == "54" || typeName == "55" || typeName == "56") typeName = "Petrol";
                        priceListHtml += `<tr style="border-bottom: 1px solid #ccc;">
                            <td style="padding: 2px;">${typeName}</td>
                            <td style="padding: 2px; text-align: right; font-weight: bold;">${p.price} ${p.currency}</td>
                        </tr>`;
                    });
                    priceListHtml += `</table>`;
                }
                
                const markerDiv = document.createElement("div");
                markerDiv.className = "custom-marker fuel-station";
                
                // Base styling
                markerDiv.style.borderRadius = "8px";
                markerDiv.style.display = "flex";
                markerDiv.style.flexDirection = "column";
                markerDiv.style.alignItems = "center";
                markerDiv.style.justifyContent = "center";
                markerDiv.style.boxShadow = "0 2px 4px rgba(0,0,0,0.3)";
                markerDiv.style.backgroundImage = "none";
                markerDiv.style.padding = "4px";
                
                if (isMin) {
                    // Big Green
                    markerDiv.style.width = "60px";
                    markerDiv.style.height = "auto";
                    markerDiv.style.minHeight = "60px";
                    markerDiv.style.backgroundColor = "#28a745";
                    markerDiv.style.borderColor = "#1e7e34";
                    markerDiv.style.zIndex = "100";
                    markerDiv.innerHTML = `
                        <span style="font-size: 28px;">⛽</span>
                        ${priceText ? `<div style="font-size:12px; background:white; color:black; padding:1px 3px; border-radius:3px; margin-top:2px; font-weight:bold; white-space:nowrap;">${priceText}</div>` : ''}
                    `;
                } else if (isMax) {
                    // Small Red (Text Only)
                    markerDiv.style.zIndex = "10";
                    markerDiv.style.width = "auto";
                    markerDiv.style.height = "auto";
                    markerDiv.style.minHeight = "auto";
                    markerDiv.style.backgroundColor = "transparent";
                    markerDiv.style.borderColor = "transparent";
                    markerDiv.style.boxShadow = "none";
                    markerDiv.style.padding = "0px";
                    markerDiv.innerHTML = `${priceText ? `<div style="font-size:10px; background:#dc3545; color:white; padding:2px 4px; border-radius:3px; font-weight:bold; white-space:nowrap; border: 1px solid #c82333;">${priceText}</div>` : ''}`;
                } else {
                    // Normal Yellow (Text Only, like Red)
                    markerDiv.style.zIndex = "50";
                    markerDiv.style.width = "auto";
                    markerDiv.style.height = "auto";
                    markerDiv.style.minHeight = "auto";
                    markerDiv.style.backgroundColor = "transparent";
                    markerDiv.style.borderColor = "transparent";
                    markerDiv.style.boxShadow = "none";
                    markerDiv.style.padding = "0px";
                    markerDiv.innerHTML = `${priceText ? `<div style="font-size:10px; background:#ff9800; color:white; padding:2px 4px; border-radius:3px; font-weight:bold; white-space:nowrap; border: 1px solid #e68a00;">${priceText}</div>` : ''}`;
                }

                
                const lat = station.position.lat !== undefined ? station.position.lat : station.position.latitude;
                const lng = station.position.lng !== undefined ? station.position.lng : station.position.longitude;
                
                const marker = new AdvancedMarkerElement({
                    map,
                    position: { lat: lat, lng: lng },
                    title: station.name || "Fuel Station",
                    content: markerDiv
                });
                
                marker.addListener('gmp-click', () => {
                    if (!sharedInfoWindow) sharedInfoWindow = new google.maps.InfoWindow();
                    let content = `<div style="color: black; padding: 5px;"><strong>${station.name || "Fuel Station"}</strong>`;
                    
                    if (priceListHtml) {
                        content += `<div style="margin-top: 5px;">${priceListHtml}</div>`;
                    }
                    if (station.stationDetails && station.stationDetails.openingHours && station.stationDetails.openingHours.regularSchedule) {
                        const sched = station.stationDetails.openingHours.regularSchedule[0];
                        if (sched && sched.periods && sched.periods.length > 0) {
                            const p = sched.periods[0];
                            content += `<div style="margin-top: 5px; font-size: 12px; color: #555;">🕒 ${p.from} - ${p.to}</div>`;
                        }
                    }
                    content += `<div style="margin-top: 10px; text-align: center;">
                        <button onclick="window.open('https://www.google.com/maps/search/?api=1&query=${lat},${lng}', '_blank')" 
                            style="padding: 5px 10px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                            Open in Maps
                        </button>
                    </div>`;

                    content += `</div>`;
                    sharedInfoWindow.setContent(content);
                    sharedInfoWindow.open({ map: map, anchor: marker });
                });
                
                marker.markerType = "fuel";
                fuelMarkers.push(marker);
            });
        }
    } catch (e) {
        console.error("Fuel stations search error:", e);
    } finally {
        const spinner = document.getElementById('loading-fuel');
        if (spinner) spinner.style.display = 'none';
    }
}

async function searchOverpassPOIs(AdvancedMarkerElement) {
    const bounds = map.getBounds();
    if (!bounds) return;
    
    const showParks = document.getElementById('toggle-parks').checked;
    const showTolls = document.getElementById('toggle-tolls').checked;
    if (!showParks && !showTolls) return; // Don't fetch if all are hidden

    const spinnerParks = document.getElementById('loading-parks');
    const spinnerTolls = document.getElementById('loading-tolls');
    if (showParks && spinnerParks) spinnerParks.style.display = 'inline';
    if (showTolls && spinnerTolls) spinnerTolls.style.display = 'inline';

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    
    // Safety check so we don't query the entire world
    const radiusKm = getDistanceKm(sw.lat(), sw.lng(), ne.lat(), ne.lng());
    if (radiusKm > 200) return; // Ignore if zoomed out too far

    try {
        const url = `${BACKEND_URL}/api/overpass-pois?min_lat=${sw.lat()}&min_lng=${sw.lng()}&max_lat=${ne.lat()}&max_lng=${ne.lng()}`;
        const res = await fetch(url);
        if (!res.ok) return;
        
        const geojson = await res.json();
        
        
        
        geojson.features.forEach(feature => {
            const type = feature.geometry.type;
            const props = feature.properties || {};

            if (type === "LineString" && props.type === "toll_road") {
                if (props.id && dynamicOverpassFeatures.some(f => f.poiId === props.id)) return;
                const path = feature.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
                const polyline = new google.maps.Polyline({
                    path: path,
                    geodesic: true,
                    strokeColor: '#FF0000',
                    strokeOpacity: 0.7,
                    strokeWeight: 6,
                    map: showTolls ? map : null
                });
                polyline.poiType = props.type;
                polyline.poiId = props.id;
                dynamicOverpassFeatures.push(polyline);
            } 
            else if (type === "Point") {
                if (props.id && dynamicOverpassFeatures.some(f => f.poiId === props.id)) return;
                let showMarker = false;
                
                if ((props.type === "caravan_site" || props.type === "camp_site") && showParks) showMarker = true;
                

                if (true) {
                    const position = { lat: feature.geometry.coordinates[1], lng: feature.geometry.coordinates[0] };
                    
                    const markerDiv = document.createElement("div");
                    markerDiv.className = "custom-marker extra-poi";
                    
                    let icon = "📍";
                    if (props.type === "caravan_site" || props.type === "camp_site") {
                        icon = "🚐"; 
                        markerDiv.style.backgroundColor = "#17a2b8"; 
                        markerDiv.style.borderColor = "#117a8b";
                    
                    }

                    markerDiv.innerHTML = `<span style="font-size: 24px; display: flex; justify-content: center; align-items: center; width: 100%; height: 100%;">${icon}</span>`;
                    
                    if (window.google && google.maps && google.maps.marker && google.maps.marker.AdvancedMarkerElement) {
                        const marker = new google.maps.marker.AdvancedMarkerElement({
                            map: showMarker ? map : null,
                            position: position,
                            title: props.name || props.type,
                            content: markerDiv
                        });
                        
                        marker.addListener('gmp-click', () => {
                            if (!sharedInfoWindow) sharedInfoWindow = new google.maps.InfoWindow();
                            populatePlaceDetails(props, position, sharedInfoWindow, marker);
                        });

                        marker.poiType = props.type;
                        marker.poiId = props.id;
                        dynamicOverpassFeatures.push(marker);
                    }
                }
            }
        });
    } catch (e) {
        console.error("Overpass POI error:", e);
    } finally {
        const spinnerParks = document.getElementById('loading-parks');
        const spinnerTolls = document.getElementById('loading-tolls');
        if (spinnerParks) spinnerParks.style.display = 'none';
        if (spinnerTolls) spinnerTolls.style.display = 'none';
    }
}

async function openModal(place) {
    currentPlace = place;
    const modal = document.getElementById("gallery-modal");
    const title = document.getElementById("modal-title");
    const gallery = document.getElementById("modal-photos");
    const favBtn = document.getElementById("favorite-btn");
    const gmapsBtn = document.getElementById("gmaps-btn");
    const wazeBtn = document.getElementById("waze-btn");
    
    const pid = place.id || place.place_id;
    title.textContent = place.displayName || place.name || "Unknown Place";
    gallery.innerHTML = "Loading photos...";
    
    updateFavButton(favBtn, pid);
    
    let lat, lng;
    if (place.location && typeof place.location.lat === 'function') {
        lat = place.location.lat();
        lng = place.location.lng();
    } else {
        lat = place.lat || place.location.lat;
        lng = place.lng || place.location.lng;
    }
    
    gmapsBtn.onclick = () => {
        window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${pid}`, '_blank');
    };
    
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
        wazeBtn.style.display = "inline-block";
        wazeBtn.onclick = () => {
            window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, '_blank');
        };
    } else {
        wazeBtn.style.display = "none";
    }
    
    // Fetch place details for extra photos using New Places API
    if (typeof place.fetchFields === 'function') {
        try {
            await place.fetchFields({ fields: ['photos'] });
            gallery.innerHTML = "";
            if (place.photos && place.photos.length > 0) {
                place.photos.forEach(photo => {
                    const img = document.createElement("img");
                    img.src = photo.getURI({maxHeight: 400, maxWidth: 400});
                    gallery.appendChild(img);
                });
                
                // Keep photos fetched attached to place so save uses all photos
                currentPlace.photos = place.photos;
                currentPlace.photoUrl = place.photos[0].getURI({maxHeight: 200, maxWidth: 200});
            } else {
                gallery.innerHTML = "<p>No extra photos found.</p>";
            }
        } catch (e) {
            console.error("Error fetching fields:", e);
            gallery.innerHTML = "<p>Error loading photos.</p>";
        }
    } else {
        // Fallback for saved favorites
        gallery.innerHTML = "";
        if (place.photoUrl) {
            const img = document.createElement("img");
            img.src = place.photoUrl;
            gallery.appendChild(img);
        } else {
            gallery.innerHTML = "<p>No extra photos found.</p>";
        }
    }
    
    modal.style.display = "block";
}

document.querySelector('.close-btn').addEventListener('click', () => {
    document.getElementById("gallery-modal").style.display = "none";
});

window.addEventListener('click', (event) => {
    const modal = document.getElementById("gallery-modal");
    if (event.target == modal) {
        modal.style.display = "none";
    }
});

document.getElementById('favorite-btn').addEventListener('click', () => {
    if (!currentPlace) return;
    
    const pid = currentPlace.id || currentPlace.place_id;
    if (favorites[pid]) {
        // remove
        delete favorites[pid];
    } else {
        // add
        let lat, lng;
        if (currentPlace.location && typeof currentPlace.location.lat === 'function') {
            lat = currentPlace.location.lat();
            lng = currentPlace.location.lng();
        } else {
            lat = currentPlace.lat || currentPlace.location.lat;
            lng = currentPlace.lng || currentPlace.location.lng;
        }
        
        let savedUrl = null;
        if (currentPlace.photos && currentPlace.photos.length > 0) {
            if (typeof currentPlace.photos[0].getURI === 'function') {
                savedUrl = currentPlace.photos[0].getURI({maxHeight: 250, maxWidth: 250});
            } else if (typeof currentPlace.photos[0] === 'string') {
                savedUrl = currentPlace.photos[0];
            }
        } else if (currentPlace.photoUrl) {
            savedUrl = currentPlace.photoUrl;
        }
        
        favorites[pid] = {
            id: pid,
            name: currentPlace.displayName || currentPlace.name,
            lat: lat,
            lng: lng,
            photoUrl: savedUrl,
            rating: currentPlace.rating || 4.5,
            userRatingCount: currentPlace.userRatingCount || 20
        };
    }
    
    localStorage.setItem('favorites', JSON.stringify(favorites));
    updateFavButton(document.getElementById('favorite-btn'), pid);
    renderFavoritesList();
    
    // Update map marker style
    const m = markers.find(mark => mark.place_id === pid);
    if (m && m.content) {
        if (favorites[pid]) {
            m.content.classList.add("favorite");
        } else {
            m.content.classList.remove("favorite");
        }
    }
});

function updateFavButton(btn, pid) {
    if (favorites[pid]) {
        btn.textContent = "★ Unfavorite";
        btn.classList.add("is-fav");
    } else {
        btn.textContent = "☆ Favorite";
        btn.classList.remove("is-fav");
    }
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function groupFavorites(favArray) {
    const groups = [];
    for (const fav of favArray) {
        let added = false;
        for (const group of groups) {
            // Check if this favorite is within 50km of any place in this group
            const isClose = group.some(gFav => getDistanceKm(fav.lat, fav.lng, gFav.lat, gFav.lng) <= 50);
            if (isClose) {
                group.push(fav);
                added = true;
                break;
            }
        }
        if (!added) {
            groups.push([fav]);
        }
    }
    return groups;
}

function renderFavoritesList() {
    const container = document.getElementById("favorites-container");
    const count = document.getElementById("fav-count");
    
    // Clear old must-see highlights
    markers.forEach(m => {
        if (m.content) m.content.classList.remove("must-see");
    });
    
    container.innerHTML = "";
    
    const favArray = Object.values(favorites);
    count.textContent = favArray.length;
    
    const groups = groupFavorites(favArray);
    
    Object.values(routePolylines).forEach(arr => {
        if (Array.isArray(arr)) {
            arr.forEach(item => {
                if (item.setMap) item.setMap(null); // Polyline
                if (item.map) item.map = null; // Marker
            });
        } else if (arr.setMap) {
            arr.setMap(null);
        }
    });
    routePolylines = {};
    
    const validGroupKeys = [];
    
    groups.forEach((group, index) => {
        const groupKey = group.map(f => f.id || f.place_id).sort().join(',');
        validGroupKeys.push(groupKey);
        
        const groupDiv = document.createElement("div");
        groupDiv.className = "fav-group";
        
        const groupHeader = document.createElement("h4");
        groupHeader.id = `group-header-${index}`;
        groupHeader.textContent = `Group ${index + 1} (${group.length} places)`;
        groupDiv.appendChild(groupHeader);
        
        const summaryP = document.createElement("p");
        summaryP.className = "group-summary";
        summaryP.id = `group-summary-${index}`;
        summaryP.textContent = "Loading region info...";
        groupDiv.appendChild(summaryP);
        
        const ul = document.createElement("ul");
        
        group.forEach(fav => {
            const li = document.createElement("li");
            
            const nameSpan = document.createElement("span");
            nameSpan.textContent = fav.name || fav.displayName;
            nameSpan.style.cursor = "pointer";
            nameSpan.style.textDecoration = "underline";
            nameSpan.className = "fav-name";
            nameSpan.title = "Click to jump to location";
            nameSpan.onclick = () => {
                map.setCenter({ lat: fav.lat, lng: fav.lng });
                map.setZoom(15);
                openModal(fav);
            };
            li.appendChild(nameSpan);
            
            const removeBtn = document.createElement("button");
            removeBtn.className = "remove-btn";
            removeBtn.textContent = "Remove";
            removeBtn.onclick = () => {
                const pid = fav.id || fav.place_id;
                delete favorites[pid];
                localStorage.setItem('favorites', JSON.stringify(favorites));
                renderFavoritesList();
                
                const m = markers.find(mark => mark.place_id === pid);
                if (m && m.content) {
                    m.content.classList.remove("favorite");
                }
            };
            
            li.appendChild(removeBtn);
            ul.appendChild(li);
        });
        
        groupDiv.appendChild(ul);
        
        const generateBtn = document.createElement("button");
        generateBtn.className = "generate-group-btn";
        generateBtn.textContent = "Generate Route for Group";
        generateBtn.disabled = group.length < 2;
        
        const downloadBtn = document.createElement("button");
        downloadBtn.className = "gpx-btn";
        downloadBtn.id = `gpx-btn-${index}`;
        downloadBtn.textContent = "📥 Download GPX";
        downloadBtn.style.display = "none";
        
        generateBtn.onclick = () => generateRouteForGroup(group, index);
        
        if (savedRoutes[groupKey]) {
            drawRoute(savedRoutes[groupKey], groupKey, false);
            generateBtn.textContent = "Regenerate Route";
            downloadBtn.style.display = "inline-block";
            downloadBtn.onclick = () => downloadGPX(savedRoutes[groupKey], index);
        }
        
        groupDiv.appendChild(generateBtn);
        groupDiv.appendChild(downloadBtn);
        
        // Add "Suggest More Places" button
        const suggestBtn = document.createElement("button");
        suggestBtn.className = "suggest-btn";
        suggestBtn.id = `suggest-btn-${index}`;
        suggestBtn.textContent = "💡 Suggest More Places";
        // Button will be enabled and bound in enhanceGroup once we know the city name
        suggestBtn.disabled = true;
        groupDiv.appendChild(suggestBtn);
        
        const suggestionsDiv = document.createElement("div");
        suggestionsDiv.id = `suggestions-div-${index}`;
        suggestionsDiv.className = "suggestions-container";
        groupDiv.appendChild(suggestionsDiv);
        
        container.appendChild(groupDiv);
        
        enhanceGroup(group, index);
    });
    
    // Cleanup old saved routes
    Object.keys(savedRoutes).forEach(key => {
        if (!validGroupKeys.includes(key)) {
            delete savedRoutes[key];
        }
    });
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
}

async function getCityName(lat, lng) {
    try {
        const { Geocoder } = await google.maps.importLibrary("geocoding");
        const geocoder = new Geocoder();
        const response = await geocoder.geocode({ location: { lat, lng } });
        if (response.results && response.results.length > 0) {
            const locality = response.results.find(r => r.types.includes("locality"));
            if (locality) return locality.address_components[0].long_name;
            
            const admin = response.results.find(r => r.types.includes("administrative_area_level_3") || r.types.includes("administrative_area_level_2"));
            if (admin) return admin.address_components[0].long_name;
            
            return response.results[0].address_components[0].long_name;
        }
    } catch (e) {
        console.error("Geocoding error", e);
    }
    return "Unknown Region";
}

async function getGeminiSummary(cityName, poiNames) {
    if (!window.GOOGLE_API_KEY) {
        return `The region around ${cityName} is characterized by breathtaking natural beauty.`;
    }
    
    const prompt = `Write a short, engaging summary (max 3 sentences) about the natural beauty and hiking opportunities around ${cityName}. Highlight these specific points of interest (the user already has them favorited): ${poiNames.join(", ")}. If you mention any OTHER specific places, landmarks, or parks that are NOT in this list, wrap their names in a <span class="mentioned-place">...</span> tag. Use a tone suitable for a travel guide.`;
    
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${window.GOOGLE_API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });
        
        if (res.ok) {
            const data = await res.json();
            if (data.candidates && data.candidates.length > 0) {
                // Convert simple Markdown bold to HTML strong tags
                let text = data.candidates[0].content.parts[0].text;
                return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            }
        } else {
            const errData = await res.json();
            if (res.status !== 403) {
                console.error("Gemini API returned error status:", res.status, errData);
            }
            if (res.status === 403 && errData.error && errData.error.message.includes("Generative Language API has not been used")) {
                return `<span style="color:#d9534f; font-size:12px;"><strong>API Error:</strong> The Generative Language API is not enabled for your Google Maps API key. Please enable it in the Google Cloud Console.</span>`;
            } else if (errData.error && errData.error.message) {
                return `<span style="color:#d9534f; font-size:12px;"><strong>AI Error:</strong> ${errData.error.message}</span>`;
            }
        }
    } catch (e) {
        console.error("Gemini API fetch error:", e);
    }
    
    return `The region around ${cityName} is characterized by breathtaking natural beauty and scenic outdoor landscapes.`;
}

async function enhanceGroup(group, index) {
    let sumLat = 0, sumLng = 0;
    group.forEach(f => { sumLat += f.lat; sumLng += f.lng; });
    const cLat = sumLat / group.length;
    const cLng = sumLng / group.length;

    const cityName = await getCityName(cLat, cLng);
    
    const header = document.getElementById(`group-header-${index}`);
    if (header) header.textContent = `Near ${cityName} (${group.length} places)`;

    const sorted = [...group].sort((a, b) => {
        const scoreA = (a.rating || 4.5) * Math.log10(a.userRatingCount || 20);
        const scoreB = (b.rating || 4.5) * Math.log10(b.userRatingCount || 20);
        return scoreB - scoreA;
    });

    const mustSees = sorted.slice(0, Math.min(2, group.length));
    const poiNames = group.map(g => g.name || g.displayName);
    const groupKey = group.map(f => f.id || f.place_id).sort().join(',');
    
    let summaryText;
    if (savedDescriptions[groupKey]) {
        summaryText = savedDescriptions[groupKey];
    } else {
        summaryText = await getGeminiSummary(cityName, poiNames);
        savedDescriptions[groupKey] = summaryText;
        localStorage.setItem('savedDescriptions', JSON.stringify(savedDescriptions));
    }

    // Extract mentioned places to highlight on map
    const regex = /<span class="mentioned-place">(.*?)<\/span>/g;
    let match;
    while ((match = regex.exec(summaryText)) !== null) {
        const name = match[1].toLowerCase().trim();
        if (!mentionedPOINames.includes(name)) {
            mentionedPOINames.push(name);
        }
    }
    
    // Clean summary for display (remove span tags but keep text bold)
    const cleanSummary = summaryText.replace(/<span class="mentioned-place">(.*?)<\/span>/g, '<strong>$1</strong>');

    const summaryEl = document.getElementById(`group-summary-${index}`);
    if (summaryEl) summaryEl.innerHTML = cleanSummary;

    // Immediately update existing markers
    markers.forEach(m => {
        if (m.title && m.content) {
            const titleLower = m.title.toLowerCase();
            const isMentioned = mentionedPOINames.some(name => titleLower.includes(name) || name.includes(titleLower));
            if (isMentioned) {
                m.content.classList.add("mentioned-poi");
            }
        }
    });

    const suggestBtn = document.getElementById(`suggest-btn-${index}`);
    if (suggestBtn) {
        suggestBtn.disabled = false;
        suggestBtn.onclick = () => suggestMorePlaces(group, index, cityName);
    }

    mustSees.forEach(ms => {
        const pid = ms.id || ms.place_id;
        const marker = markers.find(m => m.place_id === pid);
        if (marker && marker.content) {
            marker.content.classList.add("must-see");
        }
    });
}

async function suggestMorePlaces(group, index, cityName) {
    if (!window.GOOGLE_API_KEY) return;
    
    const btn = document.getElementById(`suggest-btn-${index}`);
    const suggestionsDiv = document.getElementById(`suggestions-div-${index}`);
    if (!btn || !suggestionsDiv) return;
    
    btn.textContent = "Analyzing Preferences...";
    btn.disabled = true;
    suggestionsDiv.innerHTML = "<em>Extracting preference vectors and searching route...</em>";
    
    try {
        const { Place } = await google.maps.importLibrary("places");
        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        
        // 1. Extract Preference Vector
        const typeFrequency = {};
        for (const fav of group) {
            const place = new Place({id: fav.id || fav.place_id});
            await place.fetchFields({fields: ['types']});
            if (place.types) {
                place.types.forEach(t => {
                    if (!['point_of_interest', 'establishment'].includes(t)) {
                        typeFrequency[t] = (typeFrequency[t] || 0) + 1;
                    }
                });
            }
        }
        
        // Sort and pick top 3 types
        const sortedTypes = Object.entries(typeFrequency)
            .sort((a, b) => b[1] - a[1])
            .map(e => e[0])
            .slice(0, 3);
            
        // Fallback if none found
        if (sortedTypes.length === 0) {
            sortedTypes.push("hiking_area", "scenic_viewpoint", "gorge", "waterfall", "nature_reserve");
        }
        
        const prefVectorStr = sortedTypes.map(t => t.replace(/_/g, ' ')).join(" OR ");
        
        // 2. Define search area around group route/places
        let bounds = new google.maps.LatLngBounds();
        const groupKey = group.map(f => f.id || f.place_id).sort().join(',');
        
        if (savedRoutes[groupKey] && savedRoutes[groupKey].features && savedRoutes[groupKey].features.length > 0) {
            // Expand bounds along the route
            const coords = savedRoutes[groupKey].features[0].geometry.coordinates;
            coords.forEach(c => bounds.extend({lat: c[1], lng: c[0]}));
        } else {
            // Or just the group places
            group.forEach(f => bounds.extend({lat: f.lat, lng: f.lng}));
        }
        
        // 3. Search Google Places API
        const request = {
            textQuery: prefVectorStr,
            fields: ["id", "displayName", "location", "rating", "userRatingCount", "photos", "types"],
            locationRestriction: bounds
        };
        
        const { places } = await Place.searchByText(request);
        
        // Filter out places already in group or favorites, sort by rating
        const groupIds = group.map(f => f.id || f.place_id);
        const filteredPlaces = places.filter(p => !groupIds.includes(p.id) && !favorites[p.id])
                                     .sort((a, b) => (b.rating || 0) - (a.rating || 0))
                                     .slice(0, 3);
        
        // Clear old suggestion markers
        suggestionMarkers.forEach(m => m.map = null);
        suggestionMarkers = [];
        
        if (filteredPlaces.length === 0) {
            suggestionsDiv.innerHTML = "<em>No new places found matching your preferences along this route.</em>";
            return;
        }
        
        suggestionsDiv.innerHTML = `<h4>Suggested for your Group:</h4>`;
        const ul = document.createElement("ul");
        ul.className = "suggestion-list";
        
        for (const place of filteredPlaces) {
            createMarker(place, AdvancedMarkerElement, false, true);
            
            const li = document.createElement("li");
            li.className = "suggestion-item";
            
            const nameSpan = document.createElement("strong");
            nameSpan.textContent = place.displayName || place.name;
            nameSpan.onclick = () => {
                map.setCenter(place.location);
                map.setZoom(14);
                openModal(place);
            };
            
            const reasonSpan = document.createElement("span");
            reasonSpan.className = "suggestion-reason";
            
            // Format matched types as "reason"
            const matchedTypes = (place.types || []).filter(t => sortedTypes.includes(t));
            if (matchedTypes.length > 0) {
                reasonSpan.textContent = ` - Matches your interest in: ${matchedTypes.map(t => t.replace(/_/g, ' ')).join(', ')}`;
            } else {
                reasonSpan.textContent = ` - Highly rated place near your route`;
            }
            
            li.appendChild(nameSpan);
            li.appendChild(reasonSpan);
            ul.appendChild(li);
        }
        
        suggestionsDiv.appendChild(ul);
        
        // Fit map bounds to show new markers
        const mapBounds = new google.maps.LatLngBounds();
        [...markers, ...suggestionMarkers].forEach(m => {
            if (m.position) mapBounds.extend(m.position);
        });
        map.fitBounds(mapBounds);
        
    } catch (e) {
        console.error("Suggestion error:", e);
        suggestionsDiv.innerHTML = "<span style='color:red'>Failed to generate suggestions.</span>";
    } finally {
        btn.textContent = "💡 Suggest More Places";
        btn.disabled = false;
    }
}

async function generateRouteForGroup(group, index) {
    if (group.length < 2) return;
    
    const minSac = document.getElementById('min-sac').value;
    const maxSac = document.getElementById('max-sac').value;
    
    const requestPayload = {
        favorites: group.map(f => ({ lat: f.lat, lng: f.lng })),
        min_sac: minSac,
        max_sac: maxSac
    };
    
    const infoDiv = document.getElementById("route-info");
    infoDiv.classList.remove("hidden");
    infoDiv.innerHTML = "Generating route... Please wait.";
    
    try {
        const response = await fetch(`${BACKEND_URL}/generate-route`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestPayload)
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Server error");
        }
        
        const geojson = await response.json();
        
        const groupKey = group.map(f => f.id || f.place_id).sort().join(',');
        savedRoutes[groupKey] = geojson;
        localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
        
        drawRoute(geojson, groupKey, true);
        
        // Update the download button
        const downloadBtn = document.getElementById(`gpx-btn-${index}`);
        if (downloadBtn) {
            downloadBtn.style.display = "inline-block";
            downloadBtn.onclick = () => downloadGPX(geojson, index);
        }
        
        let msg = "Route generated successfully!";
        if (geojson.features && geojson.features.length > 0) {
            const props = geojson.features[0].properties;
            if (props.summary) {
                msg += `<br>Distance: ${(props.summary.distance / 1000).toFixed(2)} km`;
                msg += `<br>Duration: ${(props.summary.duration / 60).toFixed(0)} min`;
            }
            if (props.warning) {
                msg += `<br><strong style="color:red">${props.warning}</strong>`;
            }
        }
        infoDiv.innerHTML = msg;
        
    } catch (e) {
        infoDiv.innerHTML = `<span style="color:red">Error: ${e.message}</span>`;
    }
}


async function populatePlaceDetails(props, position, infoWindow, marker) {
    let content = `<div style="color: black; padding: 5px; min-width: 200px;">
        <strong>${props.name || ( props.type === "drinking_water" ? "Drinking Water" : props.type === "viewpoint" ? "Viewpoint" : "Campsite")}</strong><br>
        <span style="font-size:12px; color:#666;">Loading details from Google...</span>
    </div>`;
    infoWindow.setContent(content);
    infoWindow.open({ map: map, anchor: marker });

    if (!window.google || !google.maps.places) return;

    // Use Places API to find more details
    const service = new google.maps.places.PlacesService(map);
    const request = {
        location: new google.maps.LatLng(position.lat, position.lng),
        radius: 50,
        query: props.name || (props.type === "drinking_water" ? "drinking water" : props.type === "camp_site" ? "campsite" : props.type.replace('_', ' '))
    };

    service.textSearch(request, (results, status) => {
        let finalContent = `<div style="color: black; padding: 5px; min-width: 200px;">
            <strong>${props.name || ( props.type === "drinking_water" ? "Drinking Water" : props.type === "viewpoint" ? "Viewpoint" : "Campsite")}</strong>`;
        
        let placeFound = null;
        if (status === google.maps.places.PlacesServiceStatus.OK && results && results.length > 0) {
            placeFound = results[0];
            if (placeFound.rating) {
                finalContent += `<br>⭐ ${placeFound.rating} (${placeFound.user_ratings_total || 0} reviews)`;
            }
            if (placeFound.photos && placeFound.photos.length > 0) {
                finalContent += `<div style="margin-top: 5px;"><img src="${placeFound.photos[0].getUrl({maxWidth: 200, maxHeight: 150})}" style="width:100%; border-radius:4px;"></div>`;
            }
        }

        // Add Overpass website/phone if available
        if (props.website) {
            finalContent += `<br>🌐 <a href="${props.website.startsWith('http') ? props.website : 'http://' + props.website}" target="_blank">Website</a>`;
        }
        if (props.phone) {
            finalContent += `<br>📞 <a href="tel:${props.phone}">${props.phone}</a>`;
        }

        
        let mapsUrl = `https://www.google.com/maps/search/?api=1&query=${position.lat},${position.lng}`;
        if (placeFound && placeFound.place_id) {
            mapsUrl += `&query_place_id=${placeFound.place_id}`;
        }
        
        finalContent += `<div style="margin-top: 10px; text-align: center;">
            <button onclick="window.open('${mapsUrl}', '_blank')" 
                style="padding: 5px 10px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; width:100%;">
                Open in Google Maps
            </button>
        </div>`;



        finalContent += `</div>`;
        
        // Update window only if it's still open on this marker
        if (infoWindow.anchor === marker) {
            infoWindow.setContent(finalContent);
        }
    });
}

function drawRoute(geojson, groupKey, doFitBounds = true) {
    if (routePolylines[groupKey]) {
        routePolylines[groupKey].forEach(item => {
            if (item.setMap) item.setMap(null); // polylines
            if (item.map) item.map = null; // markers
        });
    }
    routePolylines[groupKey] = [];
    
    if (!geojson.features || geojson.features.length === 0) return;
    
    let bounds = new google.maps.LatLngBounds();
    let hasBounds = false;

    geojson.features.forEach(feature => {
        const type = feature.geometry.type;
        const props = feature.properties || {};

        if (type === "LineString") {
            const coords = feature.geometry.coordinates;
            const path = coords.map(c => ({ lat: c[1], lng: c[0] }));
            
            let color = '#007bff'; // Default blue route
            if (props.type === "toll_road") {
                color = '#FF0000'; // Red for toll road
            }

            const polyline = new google.maps.Polyline({
                path: path,
                geodesic: true,
                strokeColor: color,
                strokeOpacity: 1.0,
                strokeWeight: props.type === "toll_road" ? 8 : 5,
                zIndex: props.type === "toll_road" ? 2 : 1,
                map: props.type === "toll_road" && !document.getElementById('toggle-tolls').checked ? null : map
            });
            
            polyline.poiType = props.type;
            routePolylines[groupKey].push(polyline);
            
            path.forEach(p => {
                bounds.extend(p);
                hasBounds = true;
            });
        } 
        else if (type === "Point") {
            const coords = feature.geometry.coordinates;
            const position = { lat: coords[1], lng: coords[0] };
            
            const markerDiv = document.createElement("div");
            markerDiv.className = "custom-marker extra-poi";
            
            let icon = "📍";
            if (props.type === "caravan_site" || props.type === "camp_site") {
                icon = "🚐"; // Campervan icon
                markerDiv.style.backgroundColor = "#17a2b8";
                markerDiv.style.borderColor = "#117a8b";
            } else if (props.type === "viewpoint") {
                // Do not plot raw overpass viewpoints as there are too many and they clutter the map
                return;
            } else if (props.type === "drinking_water") {
                icon = "💧";
                markerDiv.style.backgroundColor = "#0dcaf0";
                markerDiv.style.borderColor = "#087990";
            }

            markerDiv.innerHTML = `<span style="font-size: 24px; display: flex; justify-content: center; align-items: center; width: 100%; height: 100%;">${icon}</span>`;
            
            // Re-use map initialization promise approach assuming AdvancedMarkerElement is loaded
            if (window.google && google.maps && google.maps.marker && google.maps.marker.AdvancedMarkerElement) {
                let showMarker = true;
                
                if ((props.type === "caravan_site" || props.type === "camp_site") && !document.getElementById('toggle-parks').checked) showMarker = false;
                if (props.type === "viewpoint" && !document.getElementById('toggle-scenic').checked) showMarker = false;
                if (props.type === "drinking_water" && !document.getElementById('toggle-water').checked) showMarker = false;
                
                const marker = new google.maps.marker.AdvancedMarkerElement({
                    map: showMarker ? map : null,
                    position: position,
                    title: props.name || props.type,
                    content: markerDiv
                });
                
                marker.addListener('gmp-click', () => {
                            if (!sharedInfoWindow) sharedInfoWindow = new google.maps.InfoWindow();
                            populatePlaceDetails(props, position, sharedInfoWindow, marker);
                        });

                marker.poiType = props.type;
                routePolylines[groupKey].push(marker);
            }
        }
    });

    if (doFitBounds && hasBounds) {
        map.fitBounds(bounds);
    }
}

function formatLocalDateTimeInput(dateValue) {
    const year = dateValue.getFullYear();
    const month = `${dateValue.getMonth() + 1}`.padStart(2, '0');
    const day = `${dateValue.getDate()}`.padStart(2, '0');
    const hours = `${dateValue.getHours()}`.padStart(2, '0');
    const minutes = `${dateValue.getMinutes()}`.padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function setDefaultServiceTime() {
    const input = document.getElementById('service-time');
    if (!input) return;
    if (input.value) return;
    const oneHourAhead = new Date(Date.now() + 60 * 60 * 1000);
    input.value = formatLocalDateTimeInput(oneHourAhead);
}

function setTextStatus(elementId, message, isError = false) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? '#b3261e' : '#444';
}

function clearAvailabilityMarkers() {
    availabilityMarkers.forEach(marker => marker.map = null);
    availabilityMarkers = [];
}

function providerLinkTarget(result) {
    const firstSlot = (result.slots || [])[0] || {};
    return firstSlot.booking_url || result.booking_url || result.maps_url;
}

function renderAvailabilityMarkers(results) {
    clearAvailabilityMarkers();
    if (!AdvancedMarkerCtor || !Array.isArray(results)) return;

    results.forEach(result => {
        if (typeof result.lat !== 'number' || typeof result.lng !== 'number') return;

        const slots = result.slots && result.slots.length ? result.slots : [null];
        const providerName = result.provider_name || 'Provider';
        const providerEmail = result.provider_email || '';

        slots.forEach((slot, idx) => {
            const price = slot ? (slot.price || {}) : (result.min_price || {});
            const amount = Number(price.amount || 0).toFixed(0);
            const currency = price.currency || '';

            // Resolve service name from the shared catalog
            const slotServiceId = slot ? slot.id : null;
            const catalogEntry = slotServiceId ? serviceCatalog.find(s => s.id === slotServiceId) : null;
            const serviceName = catalogEntry ? catalogEntry.name : (slot ? slot.service_id : 'Service');

            // Small jitter so stacked markers at same location are visible
            const jitterLat = result.lat + (idx * 0.00015);
            const jitterLng = result.lng + (idx * 0.00020);

            const markerDiv = document.createElement('div');
            markerDiv.className = 'custom-marker service-marker';
            markerDiv.style.background = '#0d6efd';
            markerDiv.style.color = 'white';
            markerDiv.style.width = 'auto';
            markerDiv.style.minWidth = '72px';
            markerDiv.style.height = '44px';
            markerDiv.style.borderRadius = '10px';
            markerDiv.style.display = 'flex';
            markerDiv.style.flexDirection = 'column';
            markerDiv.style.alignItems = 'center';
            markerDiv.style.justifyContent = 'center';
            markerDiv.style.fontSize = '11px';
            markerDiv.style.fontWeight = '700';
            markerDiv.style.backgroundImage = 'none';
            markerDiv.style.padding = '2px 6px';
            markerDiv.innerHTML = `<div style="font-size:10px;font-weight:500;opacity:0.9;">${serviceName}</div><div>${amount} ${currency}</div>`.trim();

            const marker = new AdvancedMarkerCtor({
                map,
                position: { lat: jitterLat, lng: jitterLng },
                title: `${providerName} – ${serviceName}`,
                content: markerDiv,
            });

            marker.addListener('gmp-click', () => {
                const bookingUrl = (slot && slot.booking_url) || result.booking_url || '';
                const bookBtn = bookingUrl
                    ? `<a href="${bookingUrl}" target="_blank" style="display:inline-block;margin-top:6px;padding:4px 10px;background:#0d6efd;color:white;border-radius:6px;text-decoration:none;font-size:12px;">Book</a>`
                    : '';

                const infoHtml = `
                    <div style="color:#111;font-family:sans-serif;min-width:160px;max-width:220px;">
                        <div style="font-weight:700;font-size:14px;margin-bottom:2px;">${providerName}</div>
                        ${providerEmail ? `<div style="font-size:11px;color:#555;margin-bottom:4px;">${providerEmail}</div>` : ''}
                        <hr style="margin:4px 0;border-color:#ddd;">
                        <div style="font-size:13px;"><strong>${serviceName}</strong></div>
                        <div style="font-size:13px;color:#0d6efd;font-weight:600;">${amount} ${currency}</div>
                        ${bookBtn}
                    </div>`;

                if (!sharedInfoWindow) sharedInfoWindow = new google.maps.InfoWindow();
                sharedInfoWindow.setContent(infoHtml);
                sharedInfoWindow.open({ map, anchor: marker });
            });

            availabilityMarkers.push(marker);
        });
    });
}

function renderServiceChecklist() {
    const container = document.getElementById('services-checklist');
    if (!container) return;

    if (!serviceCatalog.length) {
        container.innerHTML = '<div class="status-text">No services yet. Ask providers to connect Wix.</div>';
        return;
    }

    // Group by category name (one checkbox per service type, all providers)
    const categories = new Map(); // name → [id, ...]
    serviceCatalog.forEach(service => {
        const cat = service.name || 'Service';
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat).push(service.id);
    });

    container.innerHTML = '';
    categories.forEach((ids, catName) => {
        const row = document.createElement('label');
        row.className = 'service-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = ids.every(id => selectedServiceIds.has(id));
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                ids.forEach(id => selectedServiceIds.add(id));
            } else {
                ids.forEach(id => selectedServiceIds.delete(id));
            }
            if (selectedServiceIds.size > 0) {
                searchServiceAvailability();
            } else {
                clearAvailabilityMarkers();
                setTextStatus('services-status', '');
            }
        });

        const label = document.createElement('span');
        label.textContent = catName;

        row.appendChild(checkbox);
        row.appendChild(label);
        container.appendChild(row);
    });
}

async function refreshServiceCatalog() {
    try {
        const res = await fetch(`${BACKEND_URL}/api/services/catalog`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load catalog');
        const payload = await res.json();
        serviceCatalog = payload.services || [];
        const currentIds = new Set(serviceCatalog.map(item => item.id));
        selectedServiceIds.forEach(id => {
            if (!currentIds.has(id)) selectedServiceIds.delete(id);
        });
        renderServiceChecklist();
    } catch (e) {
        setTextStatus('services-status', 'Could not load services catalog', true);
    }
}

async function refreshProviderStatus() {
    try {
        const res = await fetch(`${BACKEND_URL}/api/provider/auth/status`, { credentials: 'include' });
        if (!res.ok) throw new Error('Status request failed');
        providerAuthState = await res.json();
        if (providerAuthState.authenticated) {
            const wixText = providerAuthState.wix_connected ? 'Wix connected' : 'Wix not connected';
            setTextStatus('provider-status', `${providerAuthState.provider.email} · ${wixText}`);
        } else {
            setTextStatus('provider-status', 'Not logged in');
        }
    } catch (e) {
        setTextStatus('provider-status', 'Auth status unavailable', true);
    }
}

async function requestProviderMagicLink() {
    const emailInput = document.getElementById('provider-email');
    const email = (emailInput?.value || '').trim();
    if (!email) {
        setTextStatus('provider-status', 'Enter provider email first', true);
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/api/provider/auth/request-link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, redirect_url: window.location.origin }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.detail || 'Magic link request failed');
        if (payload.magic_token) {
            const tokenInput = document.getElementById('provider-magic-token');
            if (tokenInput) tokenInput.value = payload.magic_token;
            setTextStatus('provider-status', 'Magic token generated (dev mode). Verify to sign in.');
        } else {
            setTextStatus('provider-status', 'Magic link sent. Check email.');
        }
    } catch (e) {
        setTextStatus('provider-status', e.message || 'Magic link failed', true);
    }
}

async function verifyProviderMagicToken() {
    const tokenInput = document.getElementById('provider-magic-token');
    const token = (tokenInput?.value || '').trim();
    if (!token) {
        setTextStatus('provider-status', 'Paste magic token first', true);
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/api/provider/auth/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ token }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.detail || 'Verification failed');
        setTextStatus('provider-status', `Signed in as ${payload.provider.email}`);
        await refreshProviderStatus();
        await refreshServiceCatalog();
    } catch (e) {
        setTextStatus('provider-status', e.message || 'Verification failed', true);
    }
}

async function logoutProvider() {
    try {
        await fetch(`${BACKEND_URL}/api/provider/auth/logout`, {
            method: 'POST',
            credentials: 'include',
        });
        setTextStatus('provider-status', 'Logged out');
        await refreshProviderStatus();
    } catch (e) {
        setTextStatus('provider-status', 'Logout failed', true);
    }
}

async function connectWixOAuth() {
    try {
        const callbackUrl = `${BACKEND_URL}/api/provider/oauth/callback`;
        const res = await fetch(`${BACKEND_URL}/api/provider/oauth/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ redirect_uri: callbackUrl }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.detail || 'Wix OAuth start failed');
        if (!payload.auth_url) throw new Error('No authorization URL returned');
        
        // In mock mode, navigate to callback directly instead of opening Wix
        if (payload.mock_mode) {
            setTextStatus('provider-status', 'Mock mode: connecting...');
            window.location.href = payload.auth_url;
        } else {
            // Real Wix OAuth
            window.open(payload.auth_url, '_blank');
            setTextStatus('provider-status', 'Wix auth opened. Complete authorization, then refresh status.');
        }
    } catch (e) {
        setTextStatus('provider-status', e.message || 'Connect failed', true);
    }
}

async function searchServiceAvailability() {
    const ids = Array.from(selectedServiceIds);
    if (!ids.length) {
        setTextStatus('services-status', 'Select at least one service', true);
        return;
    }

    const timeInput = document.getElementById('service-time');
    const requested = (timeInput?.value || '').trim();
    const center = map?.getCenter();
    const body = {
        service_ids: ids,
        requested_time: requested ? new Date(requested).toISOString() : null,
        soonest: !requested,
        latitude: center ? center.lat() : null,
        longitude: center ? center.lng() : null,
    };

    try {
        setTextStatus('services-status', 'Searching availability...');
        const res = await fetch(`${BACKEND_URL}/api/availability/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.detail || 'Availability search failed');
        renderAvailabilityMarkers(payload.results || []);
        const mappedCount = (payload.results || []).filter(item => typeof item.lat === 'number' && typeof item.lng === 'number').length;
        setTextStatus('services-status', `Found ${payload.results?.length || 0} providers, mapped ${mappedCount}. Tap marker to open booking/maps.`);
    } catch (e) {
        setTextStatus('services-status', e.message || 'Availability search failed', true);
    }
}

async function initializeBookingFeatures() {
    setDefaultServiceTime();

    const requestLinkBtn = document.getElementById('provider-request-link');
    const verifyBtn = document.getElementById('provider-verify-link');
    const logoutBtn = document.getElementById('provider-logout');
    const connectWixBtn = document.getElementById('provider-connect-wix');
    const clearTimeBtn = document.getElementById('clear-service-time');

    if (requestLinkBtn) requestLinkBtn.onclick = requestProviderMagicLink;
    if (verifyBtn) verifyBtn.onclick = verifyProviderMagicToken;
    if (logoutBtn) logoutBtn.onclick = logoutProvider;
    if (connectWixBtn) connectWixBtn.onclick = connectWixOAuth;
    if (clearTimeBtn) {
        clearTimeBtn.onclick = () => {
            const input = document.getElementById('service-time');
            if (input) input.value = '';
            setTextStatus('services-status', 'Using soonest available slots');
            if (selectedServiceIds.size > 0) searchServiceAvailability();
        };
    }

    // Re-search whenever the time filter changes
    const serviceTimeInput = document.getElementById('service-time');
    if (serviceTimeInput) {
        serviceTimeInput.addEventListener('change', () => {
            if (selectedServiceIds.size > 0) searchServiceAvailability();
        });
    }

    const params = new URLSearchParams(window.location.search);
    const magicToken = params.get('magic_token');
    if (magicToken) {
        const tokenInput = document.getElementById('provider-magic-token');
        if (tokenInput) tokenInput.value = magicToken;
    }

    await refreshProviderStatus();
    await refreshServiceCatalog();
}

// Function to load Google Maps script dynamically 
function loadGoogleMaps(apiKey) {
    (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({
      key: apiKey,
      v: "weekly" // Restored to weekly
    });

    initMap();
}

async function initializeApp() {
    try {
        const response = await fetch(`${BACKEND_URL}/api/config`);
        if (!response.ok) throw new Error("Failed to fetch config");
        const config = await response.json();
        
        if (config.google_maps_api_key) {
            window.GOOGLE_API_KEY = config.google_maps_api_key;
            if (config.has_here_api_key) {
                document.getElementById('label-fuel').style.display = 'flex';
            }
            loadGoogleMaps(config.google_maps_api_key);
        } else {
            document.body.innerHTML = `
                <div style="padding: 20px; font-family: Arial;">
                    <h2>Configuration Error</h2>
                    <p>Could not find the Google Maps API Key.</p>
                    <p>Please ensure you have set <strong>GOOGLE_API_KEY</strong> in your <code>backend/.env</code> file and restarted the FastAPI server.</p>
                </div>
            `;
        }
    } catch (e) {
        console.error("Initialization error:", e);
        document.body.innerHTML = `
            <div style="padding: 20px; font-family: Arial;">
                <h2>Connection Error</h2>
                <p>Could not connect to the backend server to retrieve configuration.</p>
                <p>Ensure your backend server is running at <strong>${BACKEND_URL}</strong>.</p>
            </div>
        `;
    }
}

async function updateFuelAvailability() {
    const labelFuel = document.getElementById('label-fuel');
    const toggleFuel = document.getElementById('toggle-fuel');
    if (!labelFuel || !toggleFuel || !map) return;

    if (!window.GOOGLE_API_KEY || labelFuel.style.display === 'none') {
        toggleFuel.checked = false;
        return;
    }

    if (fuelCountryTimer) {
        clearTimeout(fuelCountryTimer);
    }

    fuelCountryTimer = setTimeout(async () => {
        try {
            const { Geocoder } = await google.maps.importLibrary("geocoding");
            const geocoder = new Geocoder();
            const center = map.getCenter();
            if (!center) return;
            const response = await geocoder.geocode({ location: { lat: center.lat(), lng: center.lng() } });
            if (!response.results || response.results.length === 0) return;
            const countryComponent = response.results[0].address_components.find(c => c.types.includes("country"));
            const countryName = countryComponent ? countryComponent.long_name : null;
            if (countryName && countryName === lastFuelCountry) return;
            lastFuelCountry = countryName;

            if (countryName && FUEL_COUNTRY_ALLOW.has(countryName)) {
                labelFuel.style.display = 'flex';
            } else {
                labelFuel.style.display = 'none';
                toggleFuel.checked = false;
                fuelMarkers.forEach(m => m.map = null);
            }
        } catch (e) {
            console.warn("Fuel country check failed", e);
        }
    }, 400);
}

initializeApp();

function downloadGPX(geojson, index) {
    if (!geojson || !geojson.features || geojson.features.length === 0) return;
    const coords = geojson.features[0].geometry.coordinates;

    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpx += `<gpx version="1.1" creator="HikingPlanner" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    gpx += `  <trk>\n`;
    gpx += `    <name>Route - Group ${index + 1}</name>\n`;
    gpx += `    <trkseg>\n`;

    coords.forEach(c => {
        // GeoJSON uses [longitude, latitude], GPX needs lat and lon
        gpx += `      <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>\n`;
    });

    gpx += `    </trkseg>\n`;
    gpx += `  </trk>\n`;
    gpx += `</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Group_${index + 1}_Route.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', () => {
    const dragHandle = document.getElementById('drag-handle');
    const sidebar = document.getElementById('sidebar');

    if (dragHandle && sidebar) {
        dragHandle.addEventListener('click', () => {
            if (sidebar.classList.contains('sidebar-collapsed')) {
                sidebar.classList.remove('sidebar-collapsed');
                sidebar.classList.add('sidebar-expanded');
            } else {
                sidebar.classList.remove('sidebar-expanded');
                sidebar.classList.add('sidebar-collapsed');
            }
        });

        // Swipe down to close
        let startY;
        dragHandle.addEventListener('touchstart', e => {
            startY = e.touches[0].clientY;
        }, {passive: true});

        dragHandle.addEventListener('touchend', e => {
            const endY = e.changedTouches[0].clientY;
            if (endY - startY > 30) {
                sidebar.classList.add('sidebar-collapsed');
                sidebar.classList.remove('sidebar-expanded');
            } else if (startY - endY > 30) {
                sidebar.classList.remove('sidebar-collapsed');
                sidebar.classList.add('sidebar-expanded');
            }
        }, {passive: true});
    }
});
