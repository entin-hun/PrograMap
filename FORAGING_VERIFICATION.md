# Foraging Data Pipeline - Verification Checklist

## Backend Changes Summary

### 1. **Weather API Enhancement** (get_openmeteo_recent)
   - **OLD**: Fetched 7-day avg temp + 7-day rain
   - **NEW**: Fetches:
     - `temp_avg`: 7-day average temperature
     - `rain_7d`: 7-day total precipitation  
     - `temp_min_last7`: Lowest temp in past 7 days
     - `temp_max_last7`: Highest temp in past 7 days
     - `humidity_avg`: 7-day average humidity
   
   **Impact**: Single API call now provides historical temp bounds instead of just min

### 2. **Temperature Filtering Logic** (foraging probability endpoint)
   - **OLD**: Only filtered if `temp_min_last5 < species_temp_min`
   - **NEW**: Filters out species if:
     - `temp_min_last7 < species_temp_min` (was too cold), OR
     - `temp_max_last7 > species_temp_max` (was too hot)
   
   **Impact**: Species are excluded only if temps ACTUALLY stayed outside range in past 7 days
   
   **Key point**: If both `temp_min_last7` and `temp_max_last7` are None (API down), species are NOT filtered out

### 3. **Data Flow Verification**

   ```
   For each grid cell:
   ├─ Weather (Open-Meteo) → temp_avg, rain_7d, temp_min_last7, temp_max_last7, humidity_avg
   ├─ Soil pH (SoilGrids) → soil_ph (defaults to 6.2 if None)
   ├─ Land classification (CORINE/EPFD/OSM) → land_cover (deciduous/coniferous/mixed/fields/built)
   ├─ Forest type (EPFD or CORINE inference) → forest_type_code
   └──  For each species:
       ├─ Score components (25% temp, 25% rain, 15% pH, 20% land, 15% tree match) → score 0-100
       ├─ If score >= 70 AND temps within range in past 7 days
       │  └─ Add to qualifying species for map + photo strip
       └─ else
          └─ Skip species
   ```

### 4. **Things Being Used in Scoring**
   
   ✓ Temperature: `cell["temp_avg"]` compared to species' [temp_min, temp_max]
   ✓ Rainfall: `cell["rain_7d"]` compared to species' rain_7d_min  
   ✓ Soil pH: `cell["soil_ph"]` compared to species' [soil_ph_min, soil_ph_max]
   ✓ Land cover: `cell["land_cover"]` matched against species' land_cover[] list
   ✓ Tree match: `cell["dominant_species"]` or `forest_type_code` matched to species' preferred_tree_genera

### 5. **pH Verification**
   
   - Line 724: `soil_ph = get_soilgrids_ph(lat_round, lng_round)`
   - Line 725: `if soil_ph is None: soil_ph = 6.2` (sensible default for European soils)
   - Lines 595-596: `ph_score = score_range(float(cell["soil_ph"]), ph_min, ph_max, 1.5)`
   - Final score includes: `0.15 * ph_score` (15% weight)
   
   **Result**: pH is ALWAYS in the scoring

### 6. **Temperature Max Usage**
   
   OLD bug: `temp_max` from species' optimal_conditions was read but never used in filtering
   - Line 593: `temp_max = float(cond.get("temp_max", 24))`  ← read from species
   - Line 604: `temp_score = score_range(..., temp_min, temp_max, ...)` ← used in SCORING
   - But NOT used to EXCLUDE species
   
   NEW: Added explicit check in qualification (lines 805-810):
   ```python
   if temp_max_last7 is not None and temp_max_last7 > species_temp_max:
       exclude_species = True
   ```

### 7. **Error Handling Improvement**
   
   - Line 719: Added logging for weather API failures instead of silent skip
   - Format: `logger.warning(f"Weather API failed for ({lat}, {lng}): {error}")`
   - This helps identify why certain cells have no output

## What Could Cause "No Data" on Mobile

1. **Zoom level too low** → Check if zoom >= 13
2. **API timeouts** → Check server logs for `Weather API failed` messages
3. **No qualifying species** → If all species filtered out by temp/pH/land
4. **Toggle not checked** → Foraging layer disabled
5. **Network error** → Browser console should show fetch error

## Testing Steps

Run this to see full logs:
```bash
tail -f backend.log | grep -E "(Weather API|Foraging probability processing|Cells)"
```

Check browser console (DevTools) for:
- `Foraging API response:` message with feature count
- `Foraging layer error:` if something fails
