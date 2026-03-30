Extend trail-planner/species_profiles.json for all entries in trail-planner/species.csv .

**What Wikidata CAN give you (The Taxonomy & Dangers):**

* `species_id` / `name_la` (Taxon name, e.g., *Boletus edulis*)
* `name_hu` (Hungarian labels)
* `lookalikes` (Using property P1843: "taxon confused with")
* `is_toxic` (By checking if it's an instance of a poisonous mushroom or has the "has quality: toxic" property)

**What Wikidata CANNOT give you (The Missing Half):**

* **`optimal_conditions`:** Wikidata does not store localized environmental niches (`temp_min`, `rain_7d_min`, `soil_ph_min`). Ecological traits vary wildly by region (a mushroom in Sweden behaves differently than one in Italy), so Wikidata doesn't structure this data. Maybe you can get min / max values from GBIF or iNaturalist occurrences.
* **`frequency`:** Frequency is regional. *Amanita phalloides* might be "common" in one forest and "rare" in another. Wikidata doesn't store a global "frequency" string.
* **`color`:** UI hex codes (`#8B4513`) are obviously not biological properties stored in a scientific taxonomy.

### How to Build Your `species_profiles.json`

Since you can't just download this JSON, you have to build a "Frankenstein" database. You do this by querying the structured data from Wikidata and then using an AI (like me) to programmatically fill in the ecological gaps.

Here is the exact pipeline:

#### Step 1: The Wikidata SPARQL Query

You use a Python script to hit the Wikidata Query Service. You ask it for: "Give me all items that are instances of 'edible mushroom' (Q6545135), their Latin names, their Hungarian names, and any taxa they are confused with (P1843)."

#### Step 2: The LLM Enrichment

You take that raw Wikidata list (which might be 500+ mushrooms) and you feed it into an LLM via an API. You prompt the LLM:

> *"Here is a list of edible mushrooms and their lookalikes. For each one, generate a JSON object that adds a representative UI hex `color`, and realistic European `optimal_conditions` (temp, rain, pH, land cover)."*

---

## Implemented (Hungary-optimized)

Generator script: `trail-planner/build_species_profiles.py`

### What it does now

1. Reads all species from `trail-planner/species.csv`.
2. Resolves each Latin name to a GBIF taxon key.
3. Pulls GBIF occurrences with coordinates for **HU**.
4. If HU observations are sparse (`<10`), expands to neighbors: `AT, SK, RO, RS, HR, SI, UA`.
5. Derives robust ecological ranges with **p10–p90** quantiles:
	- `temp_min`, `temp_max` from month+latitude climate proxy
	- `rain_7d_min` from precipitation proxy converted to weekly minimum
	- `soil_ph_min`, `soil_ph_max` from genus-level ecological priors
6. Enriches taxonomy with Wikidata where available:
	- tries `lookalikes` from `P1843`
	- toxicity signals from claims labels containing toxic/poisonous markers
7. Writes full `trail-planner/species_profiles.json` for all species.

### Run

From `trail-planner/`:

```bash
/Users/mac-pro/dev_projects/.venv/bin/python build_species_profiles.py
```

### Notes / limits

- GBIF and Wikidata do not directly provide localized niche thresholds, so `optimal_conditions` uses occurrence-driven proxies.
- `frequency` is inferred from regional observation density (not a biological absolute).
- `color` remains a deterministic UI attribute, not a taxonomic fact.