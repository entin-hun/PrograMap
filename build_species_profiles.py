#!/usr/bin/env python3
import argparse
import csv
import json
import math
import ssl
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GBIF_API = "https://api.gbif.org/v1"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIDATA_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
WIKIPEDIA_SUMMARY = "https://hu.wikipedia.org/api/rest_v1/page/summary/{title}"

HU_COUNTRIES = ["HU"]
FALLBACK_COUNTRIES = ["AT", "SK", "RO", "RS", "HR", "SI", "UA"]

NO_IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg"

MIN_OBS = 10
PAGE_LIMIT = 300
MAX_PAGES = 4
REQUEST_DELAY_SEC = 0.15

DEFAULT_CONDITIONS = {
    "temp_min": 8,
    "temp_max": 24,
    "rain_7d_min": 8,
    "soil_ph_min": 5.0,
    "soil_ph_max": 7.0,
    "land_cover": ["deciduous", "coniferous"],
}

MONTHLY_TEMP_HU = {
    1: 0.0,
    2: 2.0,
    3: 7.0,
    4: 12.0,
    5: 17.0,
    6: 20.0,
    7: 22.0,
    8: 22.0,
    9: 17.0,
    10: 12.0,
    11: 6.0,
    12: 2.0,
}

MONTHLY_RAIN_HU = {
    1: 35.0,
    2: 30.0,
    3: 35.0,
    4: 45.0,
    5: 60.0,
    6: 70.0,
    7: 60.0,
    8: 55.0,
    9: 45.0,
    10: 40.0,
    11: 45.0,
    12: 40.0,
}

COLOR_PALETTE = [
    "#1F77B4",
    "#FF7F0E",
    "#2CA02C",
    "#D62728",
    "#9467BD",
    "#8C564B",
    "#E377C2",
    "#7F7F7F",
    "#BCBD22",
    "#17BECF",
    "#393B79",
    "#637939",
    "#8C6D31",
    "#843C39",
    "#7B4173",
    "#3182BD",
    "#E6550D",
    "#31A354",
    "#756BB1",
    "#636363",
]


@dataclass
class SpeciesRow:
    name_hu: str
    name_la: str


class JsonHttp:
    def __init__(self) -> None:
        self.cache: dict[str, Any] = {}
        self.ssl_context = self._build_ssl_context()

    @staticmethod
    def _build_ssl_context() -> ssl.SSLContext:
        try:
            import certifi  # type: ignore

            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            try:
                return ssl.create_default_context()
            except Exception:
                print("Warning: falling back to unverified SSL context", file=sys.stderr)
                return ssl._create_unverified_context()  # type: ignore[attr-defined]

    def get(self, url: str, timeout: int = 20) -> Any:
        if url in self.cache:
            return self.cache[url]
        req = urllib.request.Request(url, headers={"User-Agent": "trail-planner-profile-builder/1.0"})
        with urllib.request.urlopen(req, timeout=timeout, context=self.ssl_context) as response:
            payload = response.read().decode("utf-8")
            data = json.loads(payload)
            self.cache[url] = data
            time.sleep(REQUEST_DELAY_SEC)
            return data


http = JsonHttp()


def slugify_species_id(name_la: str) -> str:
    return "_".join(name_la.strip().lower().replace("-", " ").split())


def quantile(values: list[float], q: float) -> float:
    if not values:
        raise ValueError("Cannot compute quantile on empty sequence")
    if len(values) == 1:
        return values[0]
    sorted_vals = sorted(values)
    idx = (len(sorted_vals) - 1) * q
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] * (hi - idx) + sorted_vals[hi] * (idx - lo)


def bounded(value: float, min_value: float, max_value: float) -> float:
    return max(min(value, max_value), min_value)


def pick_color(index: int) -> str:
    return COLOR_PALETTE[index % len(COLOR_PALETTE)]


def wiki_title(name: str) -> str:
    return name.strip().replace(" ", "_")


def wikipedia_url_for_title(title: str) -> str:
    return f"https://hu.wikipedia.org/wiki/{urllib.parse.quote(title, safe=':_()\'!,') }"


def claim_first_string(entity: dict[str, Any], prop: str) -> str | None:
    values = claim_string_values(entity, prop)
    if values:
        return values[0]
    return None


def entity_huwiki_title(entity: dict[str, Any]) -> str | None:
    sitelinks = entity.get("sitelinks", {})
    huwiki = sitelinks.get("huwiki", {})
    title = huwiki.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip().replace(" ", "_")
    return None


def commons_file_url(filename: str) -> str:
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(filename, safe='()!') }"


def wikipedia_thumbnail_url(title: str) -> str | None:
    url = WIKIPEDIA_SUMMARY.format(title=urllib.parse.quote(title, safe=':_()\'!,'))
    try:
        payload = http.get(url)
    except Exception:
        return None
    thumbnail = payload.get("thumbnail", {})
    source = thumbnail.get("source")
    if isinstance(source, str) and source.startswith("http"):
        return source
    return None


def gbif_taxon_key(name_la: str) -> int | None:
    query = urllib.parse.urlencode({"name": name_la, "rank": "SPECIES"})
    url = f"{GBIF_API}/species/match?{query}"
    try:
        data = http.get(url)
    except Exception:
        return None
    taxon_key = data.get("usageKey") or data.get("speciesKey")
    if isinstance(taxon_key, int):
        return taxon_key
    return None


def gbif_occurrences(taxon_key: int, countries: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for country in countries:
        for page in range(MAX_PAGES):
            offset = page * PAGE_LIMIT
            params = {
                "taxonKey": str(taxon_key),
                "country": country,
                "hasCoordinate": "true",
                "limit": str(PAGE_LIMIT),
                "offset": str(offset),
            }
            url = f"{GBIF_API}/occurrence/search?{urllib.parse.urlencode(params)}"
            try:
                payload = http.get(url)
            except Exception:
                break
            chunk = payload.get("results", [])
            if not chunk:
                break
            for item in chunk:
                lat = item.get("decimalLatitude")
                lon = item.get("decimalLongitude")
                month = item.get("month")
                year = item.get("year")
                if lat is None or lon is None or month is None:
                    continue
                if year is not None and year < 1980:
                    continue
                records.append(item)
            if len(chunk) < PAGE_LIMIT:
                break
    return records


def estimate_temp_c(month: int, lat: float) -> float:
    base = MONTHLY_TEMP_HU.get(month, 12.0)
    lat_adjust = -0.65 * (lat - 47.0)
    return bounded(base + lat_adjust, -5.0, 35.0)


def estimate_rain_monthly_mm(month: int, lat: float) -> float:
    base = MONTHLY_RAIN_HU.get(month, 45.0)
    lat_adjust = 1.8 * (lat - 47.0)
    return bounded(base + lat_adjust, 10.0, 140.0)


def infer_soil_ph(name_la: str) -> tuple[float, float]:
    genus = name_la.split()[0].lower()
    acidic_genera = {"lactarius", "lactifluus", "suillus", "russula", "boletus", "cantharellus", "leccinum", "leccinellum"}
    neutral_genera = {"agaricus", "morchella", "tuber", "calocybe", "armillaria"}
    if genus in acidic_genera:
        return (4.6, 6.2)
    if genus in neutral_genera:
        return (5.8, 7.5)
    return (5.0, 7.0)


def infer_land_cover(name_la: str) -> list[str]:
    species_key = slugify_species_id(name_la)
    species_overrides = {
        "lepista_personata": ["fields", "mixed"],
        "marasmius_oreades": ["fields", "mixed"],
        "agaricus_bitorquis": ["fields", "mixed"],
    }
    if species_key in species_overrides:
        return species_overrides[species_key]

    genus = name_la.split()[0].lower()
    conifer_bias = {"suillus", "lactarius", "chroogomphus"}
    deciduous_bias = {"morchella", "calocybe", "agaricus", "pleurotus"}
    open_habitat_bias = {"lepista", "marasmius"}
    if genus in conifer_bias:
        return ["coniferous"]
    if genus in open_habitat_bias:
        return ["fields"]
    if genus in deciduous_bias:
        return ["deciduous"]
    return ["deciduous", "coniferous"]


def conditions_similarity_key(profile: dict[str, Any]) -> tuple[Any, ...]:
    conditions = profile["optimal_conditions"]
    return (
        int(conditions["temp_min"] // 2),
        int(conditions["temp_max"] // 2),
        int(conditions["rain_7d_min"] // 2),
        round(float(conditions["soil_ph_min"]), 1),
        round(float(conditions["soil_ph_max"]), 1),
        tuple(sorted(conditions["land_cover"])),
    )


def assign_colors_by_similarity(profiles: list[dict[str, Any]]) -> None:
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for profile in profiles:
        key = conditions_similarity_key(profile)
        groups.setdefault(key, []).append(profile)

    palette_size = len(COLOR_PALETTE)
    step = 7
    while math.gcd(step, palette_size) != 1:
        step += 2

    start_index = 0
    for key in sorted(groups.keys()):
        group = sorted(groups[key], key=lambda p: p["species_id"])
        for idx, profile in enumerate(group):
            profile["color"] = pick_color(start_index + idx * step)
        start_index += 3


def infer_frequency(observation_count: int) -> str:
    if observation_count >= 120:
        return "abundant"
    if observation_count >= 40:
        return "common"
    if observation_count >= 15:
        return "occasional"
    return "rare"


def taxon_risk_base(name_la: str) -> str:
    genus = name_la.split()[0].lower()
    high_risk = {"amanita", "inocybe", "cortinarius"}
    medium_risk = {"agaricus", "lepista", "clitocybe"}
    if genus in high_risk:
        return "high"
    if genus in medium_risk:
        return "medium"
    return "low"


def wikidata_search_qid(name_la: str) -> str | None:
    params = {
        "action": "wbsearchentities",
        "format": "json",
        "language": "en",
        "type": "item",
        "limit": "1",
        "search": name_la,
    }
    url = f"{WIKIDATA_API}?{urllib.parse.urlencode(params)}"
    try:
        payload = http.get(url)
    except Exception:
        return None
    search = payload.get("search", [])
    if not search:
        return None
    qid = search[0].get("id")
    if isinstance(qid, str):
        return qid
    return None


def wikidata_entity(qid: str) -> dict[str, Any] | None:
    url = WIKIDATA_ENTITY.format(qid=qid)
    try:
        payload = http.get(url)
    except Exception:
        return None
    entities = payload.get("entities", {})
    entity = entities.get(qid)
    if isinstance(entity, dict):
        return entity
    return None


def entity_label(entity: dict[str, Any], lang: str) -> str | None:
    labels = entity.get("labels", {})
    label = labels.get(lang, {})
    value = label.get("value")
    return value if isinstance(value, str) else None


def claim_item_ids(entity: dict[str, Any], prop: str) -> list[str]:
    out: list[str] = []
    claims = entity.get("claims", {})
    for claim in claims.get(prop, []):
        mainsnak = claim.get("mainsnak", {})
        datavalue = mainsnak.get("datavalue", {})
        value = datavalue.get("value", {})
        qid = value.get("id") if isinstance(value, dict) else None
        if isinstance(qid, str):
            out.append(qid)
    return out


def claim_string_values(entity: dict[str, Any], prop: str) -> list[str]:
    out: list[str] = []
    claims = entity.get("claims", {})
    for claim in claims.get(prop, []):
        mainsnak = claim.get("mainsnak", {})
        datavalue = mainsnak.get("datavalue", {})
        value = datavalue.get("value")
        if isinstance(value, str):
            out.append(value)
    return out


def batch_entity_labels(qids: list[str], lang: str) -> dict[str, str]:
    if not qids:
        return {}
    chunks: list[list[str]] = [qids[i : i + 45] for i in range(0, len(qids), 45)]
    labels: dict[str, str] = {}
    for chunk in chunks:
        params = {
            "action": "wbgetentities",
            "format": "json",
            "ids": "|".join(chunk),
            "props": "labels",
            "languages": f"{lang}|en",
        }
        url = f"{WIKIDATA_API}?{urllib.parse.urlencode(params)}"
        try:
            payload = http.get(url)
        except Exception:
            continue
        entities = payload.get("entities", {})
        for qid, entity in entities.items():
            if not isinstance(entity, dict):
                continue
            label = entity.get("labels", {}).get(lang, {}).get("value")
            if not isinstance(label, str):
                label = entity.get("labels", {}).get("en", {}).get("value")
            if isinstance(label, str):
                labels[qid] = label
    return labels


def is_toxic_entity(entity: dict[str, Any], qid_to_label_en: dict[str, str]) -> bool:
    check_props = ["P31", "P1552", "P366"]
    for prop in check_props:
        for qid in claim_item_ids(entity, prop):
            label = qid_to_label_en.get(qid, "").lower()
            if "toxic" in label or "poison" in label or "venom" in label:
                return True
    return False


def build_conditions(occurrences: list[dict[str, Any]], name_la: str) -> dict[str, Any]:
    if not occurrences:
        defaults = DEFAULT_CONDITIONS.copy()
        defaults["soil_ph_min"], defaults["soil_ph_max"] = infer_soil_ph(name_la)
        defaults["land_cover"] = infer_land_cover(name_la)
        return defaults

    temps: list[float] = []
    rains: list[float] = []
    for rec in occurrences:
        lat = rec.get("decimalLatitude")
        month = rec.get("month")
        if not isinstance(lat, (float, int)) or not isinstance(month, int):
            continue
        temps.append(estimate_temp_c(month, float(lat)))
        rains.append(estimate_rain_monthly_mm(month, float(lat)))

    if not temps or not rains:
        return build_conditions([], name_la)

    tmin = round(quantile(temps, 0.10), 1)
    tmax = round(quantile(temps, 0.90), 1)
    rain_monthly_p10 = quantile(rains, 0.10)
    rain_7d_min = round(rain_monthly_p10 / 4.3, 1)
    soil_min, soil_max = infer_soil_ph(name_la)

    return {
        "temp_min": int(round(tmin)),
        "temp_max": int(round(tmax)),
        "rain_7d_min": int(round(max(rain_7d_min, 1))),
        "soil_ph_min": soil_min,
        "soil_ph_max": soil_max,
        "land_cover": infer_land_cover(name_la),
    }


def parse_species(csv_path: Path) -> list[SpeciesRow]:
    rows: list[SpeciesRow] = []
    with csv_path.open("r", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        for row in reader:
            name_hu = (row.get("Magyar név") or "").strip()
            name_la = (row.get(" latin name") or row.get("latin name") or "").strip()
            if not name_hu or not name_la:
                continue
            rows.append(SpeciesRow(name_hu=name_hu, name_la=name_la))
    return rows


def build_profile(row: SpeciesRow) -> dict[str, Any]:
    taxon_key = gbif_taxon_key(row.name_la)
    occurrences: list[dict[str, Any]] = []

    if taxon_key is not None:
        occurrences = gbif_occurrences(taxon_key, HU_COUNTRIES)
        if len(occurrences) < MIN_OBS:
            fallback_records = gbif_occurrences(taxon_key, FALLBACK_COUNTRIES)
            seen = {(r.get("key"), r.get("datasetKey")) for r in occurrences}
            for rec in fallback_records:
                marker = (rec.get("key"), rec.get("datasetKey"))
                if marker not in seen:
                    seen.add(marker)
                    occurrences.append(rec)

    qid = wikidata_search_qid(row.name_la)
    species_entity = wikidata_entity(qid) if qid else None

    name_hu = row.name_hu
    if species_entity:
        hu_label = entity_label(species_entity, "hu")
        if hu_label and not name_hu:
            name_hu = hu_label

    lookalikes: list[dict[str, Any]] = []
    lookalike_ids: list[str] = []
    if species_entity:
        lookalike_ids = claim_item_ids(species_entity, "P1843")

    lookalike_en = batch_entity_labels(lookalike_ids, "en")
    lookalike_hu = batch_entity_labels(lookalike_ids, "hu")

    toxicity_qids: list[str] = []
    if species_entity:
        toxicity_qids.extend(claim_item_ids(species_entity, "P31"))
        toxicity_qids.extend(claim_item_ids(species_entity, "P1552"))
        toxicity_qids.extend(claim_item_ids(species_entity, "P366"))

    lookalike_entities: dict[str, dict[str, Any]] = {}
    for lid in lookalike_ids:
        entity = wikidata_entity(lid)
        if entity:
            lookalike_entities[lid] = entity
            toxicity_qids.extend(claim_item_ids(entity, "P31"))
            toxicity_qids.extend(claim_item_ids(entity, "P1552"))
            toxicity_qids.extend(claim_item_ids(entity, "P366"))

    toxicity_labels = batch_entity_labels(sorted(set(toxicity_qids)), "en")

    species_is_toxic = is_toxic_entity(species_entity, toxicity_labels) if species_entity else False

    for lid in lookalike_ids:
        entity = lookalike_entities.get(lid)
        la_names = claim_string_values(entity, "P225") if entity else []
        name_la = la_names[0] if la_names else lookalike_en.get(lid, "Unknown taxon")
        name_hu_l = lookalike_hu.get(lid, lookalike_en.get(lid, "Ismeretlen"))
        is_toxic = is_toxic_entity(entity, toxicity_labels) if entity else False
        lookalikes.append(
            {
                "name_hu": name_hu_l,
                "name_la": name_la,
                "is_toxic": is_toxic,
                "is_inedible": True if is_toxic else True,
            }
        )

    risk = taxon_risk_base(row.name_la)
    if species_is_toxic:
        risk = "critical"
    elif any(item.get("is_toxic") for item in lookalikes):
        risk = "high" if risk in {"low", "medium"} else risk

    species_title = wiki_title(name_hu)
    if species_entity:
        huwiki_title = entity_huwiki_title(species_entity)
        if huwiki_title:
            species_title = huwiki_title
    wikipedia_url = wikipedia_url_for_title(species_title)

    picture_url = None
    if species_entity:
        commons_file = claim_first_string(species_entity, "P18")
        if commons_file:
            picture_url = commons_file_url(commons_file)
    if not picture_url:
        picture_url = wikipedia_thumbnail_url(species_title)
    if not picture_url:
        picture_url = NO_IMAGE_URL

    profile = {
        "species_id": slugify_species_id(row.name_la),
        "name_hu": name_hu,
        "name_la": row.name_la,
        "wikipedia_url": wikipedia_url,
        "picture_url": picture_url,
        "color": pick_color(0),
        "optimal_conditions": build_conditions(occurrences, row.name_la),
        "frequency": infer_frequency(len(occurrences)),
        "toxicity_risk": risk,
        "lookalikes": lookalikes,
    }
    return profile


def build_profiles(csv_path: Path) -> dict[str, Any]:
    species_rows = parse_species(csv_path)
    profiles = [build_profile(row) for row in species_rows]
    profiles = [profile for profile in profiles if profile["frequency"] not in {"rare", "occasional"}]
    assign_colors_by_similarity(profiles)
    frequency_priority = {"abundant": 0, "common": 1}
    profiles.sort(key=lambda item: (frequency_priority.get(item["frequency"], 99), item["species_id"]))
    return {"species_profiles": profiles}


def main() -> None:
    parser = argparse.ArgumentParser(description="Build species_profiles.json from species.csv")
    parser.add_argument("--csv", default="species.csv", help="Path to input species CSV")
    parser.add_argument("--output", default="species_profiles.json", help="Path to output JSON")
    args = parser.parse_args()

    csv_path = Path(args.csv)
    output_path = Path(args.output)

    payload = build_profiles(csv_path)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Generated {len(payload['species_profiles'])} profiles -> {output_path}")


if __name__ == "__main__":
    main()
