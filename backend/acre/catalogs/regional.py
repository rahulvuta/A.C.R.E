"""The catalog for a location (card B2): ``catalog_for_location(loc) -> (index, state)``.

* **North Carolina** gets the verified v2 catalog and nothing else.
* **Anywhere else**: the region profile for the first key of the location's region chain
  (``AR-B`` → ``AR`` → ``koppen:Cfa``) that has one, committed under ``data/catalogs/regions/`` or
  written by the research step into ``$ACRE_CACHE_DIR/regions/``, merged with the SAGE crop
  calendars of the location's 0.5° cell (``dataset_estimate``). A profile calendar wins over SAGE
  for the same crop. NC rules never enter a non-NC index (``US-NC`` is skipped outside NC, and v1/v2
  rows are never read there).

The location is described **without the network** by default (fixtures and the geocoder cache;
``/v1/locations/capabilities`` and ``/v1/geo/reverse`` warm that cache). Without a known country the
chain is only the climate class. Nothing here logs or stores coordinates: cache keys are the
region key and the SAGE cell.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from acre.catalogs import crop_ids, sage, v3
from acre.catalogs.index import CatalogIndex
from acre.catalogs.loader import Catalog, CatalogManifest
from acre.catalogs.models import Crop, CropRule
from acre.geo.config import BACKEND_ROOT, cache_root

NC_KEY = "US-NC"
REGIONS_DIR = BACKEND_ROOT / "data" / "catalogs" / "regions"
PROFILE_FILE = "profile.json"
RULES_FILE = "crop_rules.csv"
DISCLAIMER = ("Suggestions to check with a local adviser; not verified advice. Crop calendars from "
              "SAGE are gridded estimates (mostly circa 1990-2000), not this farm's dates.")  # fmt: skip
_KEY_RE = re.compile(r"^(?:[A-Z]{2}(?:-[A-Z0-9]{1,3})?|koppen:[A-Za-z]{1,3})$")


def valid_region_key(key: str) -> bool:
    return bool(_KEY_RE.fullmatch(key or ""))


def _key_dir(key: str) -> str:
    return key.replace(":", "_")


# --------------------------------------------------------------------------- the index


class RegionalIndex(CatalogIndex):
    """A :class:`CatalogIndex` plus what a region knows beyond rules: calendars, covers, rotations.

    ``crop()`` also answers for aliases (``field_corn`` finds ``maize`` and vice versa).
    """

    def __init__(self, catalog: Catalog, *, region_key: str | None, region_keys: list[str],
                 in_nc: bool, calendars: dict[str, dict[str, Any]], profile: dict[str, Any] | None,
                 profile_key: str | None, gaps: list[str]):  # fmt: skip
        super().__init__(catalog)
        self.region_key = region_key
        self.region_keys = region_keys
        self.in_nc = in_nc
        self.calendars = calendars  # crop_id -> {plant, harvest, origin, source, ...}
        self.profile = profile
        self.profile_key = profile_key
        self.gaps = gaps

    def crop(self, crop_id: str) -> Crop | None:
        found = crop_ids.id_in_catalog(crop_id, self.crops)
        return self.crops.get(found) if found else None

    def catalog_id(self, crop_id: str) -> str | None:
        """The id this catalog uses for ``crop_id`` (an alias or another catalog's id)."""
        return crop_ids.id_in_catalog(crop_id, self.crops)

    def calendar(self, crop_id: str) -> dict[str, Any] | None:
        for cand in crop_ids.equivalents(crop_id):
            if cand in self.calendars:
                return self.calendars[cand]
        return None

    @property
    def origin(self) -> str:
        if self.in_nc:
            return "verified_source"
        if self.profile is not None and isinstance(self.profile.get("origin"), str):
            return self.profile["origin"]
        return sage.ORIGIN

    def cover_crop_options(self) -> list[dict[str, Any]]:
        return list((self.profile or {}).get("cover_crops") or [])

    def rotations(self) -> list[dict[str, Any]]:
        return list((self.profile or {}).get("rotations") or [])

    def double_crops(self) -> list[dict[str, Any]]:
        return list((self.profile or {}).get("double_crops") or [])

    def state(self) -> dict[str, Any]:
        """The ``catalog_state`` block A's analysis reports (contract §4 ``features.catalog``)."""
        if self.in_nc:
            return {"status": "complete", "origin": "verified_source", "region_key": NC_KEY,
                    "reason": None, "reason_text": None, "catalog_version": self.version}  # fmt: skip
        if not self.calendars and not self.catalog.rules:
            return {"status": "insufficient_data", "origin": None, "region_key": self.region_key,
                    "reason": "no_regional_evidence",
                    "reason_text": "No crop calendars or regional guidance exist for this place, "
                    "so no rule is checked; the weather results still apply.",
                    "catalog_version": self.version, "gaps": list(self.gaps)}  # fmt: skip
        if self.profile is not None and not (_sage_only(self.profile) and not self.catalog.rules):
            return {"status": "partial", "origin": self.origin, "region_key": self.profile_key,
                    "reason": "regional_profile",
                    "reason_text": "Regional suggestions and gridded crop calendars; check them "
                    "with a local adviser.", "catalog_version": self.version,
                    "gaps": list(self.gaps)}  # fmt: skip
        return {"status": "partial", "origin": sage.ORIGIN, "region_key": self.region_key,
                "reason": "sage_only",
                "reason_text": "Only gridded crop-calendar estimates (SAGE) are available here; "
                "there is no verified local guidance, so no rule is checked.",
                "catalog_version": self.version, "gaps": list(self.gaps)}  # fmt: skip


# --------------------------------------------------------------------------- profiles on disk


def profile_dirs(key: str) -> list[Path]:
    """Where a region's profile may live: committed first, then the research cache."""
    return [REGIONS_DIR / _key_dir(key), cache_root() / "regions" / _key_dir(key)]


def _sage_only(doc: dict[str, Any]) -> bool:
    return doc.get("origin") == "dataset_estimate" and not (doc.get("research") or {}).get(
        "job_status") == "ready"


def find_profile(key: str) -> tuple[Path, dict[str, Any]] | None:
    """The profile to use: a committed one, unless it is only a SAGE placeholder and research has
    written one into the cache since."""
    found: list[tuple[Path, dict[str, Any]]] = []
    for d in profile_dirs(key):
        try:
            doc = json.loads((d / PROFILE_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and doc.get("region_key") == key:
            found.append((d, doc))
    if len(found) == 2 and _sage_only(found[0][1]):
        return found[1]
    return found[0] if found else None


def _stamp(d: Path) -> tuple[float, float]:
    out = []
    for name in (PROFILE_FILE, RULES_FILE):
        try:
            out.append((d / name).stat().st_mtime)
        except OSError:
            out.append(0.0)
    return out[0], out[1]


# --------------------------------------------------------------------------- building


def _manifest(version: str, digest: str) -> CatalogManifest:
    return CatalogManifest(version=version, content_hash=digest,
                           loaded_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), files={})  # fmt: skip


def _crop_row(crop_id: str, origin: str, source: dict[str, Any] | None, role: str | None = None,
              name: str | None = None) -> Crop:  # fmt: skip
    info = crop_ids.info(crop_id)
    return Crop(crop_id=crop_id, common_name=name or (info.name if info else crop_id),
                crop_role=role or (info.role if info else None), origin=origin,
                family=info.family if info else None,
                source_title=(source or {}).get("title"), source_url=(source or {}).get("url"))  # fmt: skip


def _profile_calendars(profile: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for c in profile.get("crops") or []:
        cal = c.get("calendar") if isinstance(c, dict) else None
        cid = crop_ids.canonical(c.get("crop_id")) if isinstance(c, dict) else None
        if cid and isinstance(cal, dict) and isinstance(cal.get("plant"), dict):
            # the calendar's own origin, else the crop entry's, else the profile's
            out[cid] = {**cal, "origin": cal.get("origin") or c.get("origin")
                        or profile.get("origin")}  # fmt: skip
    return out


def _origin_ok(o: Any) -> bool:
    return isinstance(o, str) and o in v3.RULE_ORIGINS


def clean_profile(doc: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """Drop every profile entry whose ``origin`` is not a catalog origin; ``None`` if the profile
    itself has none. A stored file cannot claim a provenance the vocabulary does not have."""
    gaps: list[str] = []
    if not _origin_ok(doc.get("origin")):
        return None, [f"The stored {doc.get('region_key')} profile has no valid origin and was "
                      "not used."]  # fmt: skip
    out = dict(doc)
    for section in ("crops", "cover_crops", "rotations", "double_crops"):
        kept = []
        for item in doc.get(section) or []:
            if not isinstance(item, dict):
                continue
            cal = item.get("calendar")
            explicit = [item["origin"]] if "origin" in item else []
            if isinstance(cal, dict) and "origin" in cal:
                explicit.append(cal["origin"])
            if all(_origin_ok(o) for o in explicit) and (section in ("rotations",) or crop_ids.is_known(
                    item.get("crop_id") or item.get("winter_crop") or item.get("next_crop"))):  # fmt: skip
                kept.append(item)
            else:
                gaps.append(f"A {section} entry of the stored profile was dropped (unknown crop "
                            "or origin).")  # fmt: skip
        out[section] = kept
    return out, gaps


def _library_calendars(region_keys: tuple[str, ...]) -> dict[str, dict[str, Any]]:
    """Calendars of crops researched into the crop library (S4) for this place's own regions."""
    try:
        from acre.croplib import library

        return library.calendars_for(list(region_keys))
    except Exception:  # noqa: BLE001 - the library is optional context
        return {}


@lru_cache(maxsize=256)
def _build(region_keys: tuple[str, ...], in_nc: bool, sage_cell: str, lat_r: float, lon_r: float,
           stamp: tuple[Any, ...]) -> RegionalIndex:  # fmt: skip
    """``lat_r``/``lon_r`` are the SAGE cell centre, never the farm's point."""
    del stamp  # cache key only: a profile written by research invalidates the entry
    gaps: list[str] = []
    try:
        cals, sage_gaps = sage.calendars_at(lat_r, lon_r)
    except sage.SageUnavailable:
        cals, sage_gaps = [], ["The bundled SAGE crop calendars could not be read."]
    gaps += sage_gaps
    calendars: dict[str, dict[str, Any]] = {c.crop_id: c.as_dict() for c in cals}
    sage_names = {c.crop_id: c.name for c in cals}
    library_cals = _library_calendars(region_keys)

    if in_nc:
        from acre.report.meta import get_index

        nc = get_index().catalog
        for cid, cal in library_cals.items():  # researched crops (S4); never over SAGE or the catalog
            calendars.setdefault(cid, cal)
        return RegionalIndex(nc, region_key=NC_KEY, region_keys=list(region_keys), in_nc=True,
                             calendars=calendars, profile=None, profile_key=None, gaps=[])  # fmt: skip

    profile: dict[str, Any] | None = None
    profile_key: str | None = None
    rules: list[CropRule] = []
    blobs: list[bytes] = [sage_cell.encode()]
    for key in region_keys:
        if key == NC_KEY:
            continue  # NC guidance applies only in NC
        found = find_profile(key)
        if found is None:
            continue
        d, raw = found
        profile, bad = clean_profile(raw)
        gaps += bad
        if profile is None:
            continue
        profile_key = key
        loaded, issues = v3.load_rules(d / RULES_FILE, set(crop_ids.BY_ID))
        # a row for another region never rides along with this profile
        rules = [r for r in loaded if r.region_key in region_keys and r.region_key != NC_KEY]
        if any(i.severity == "error" for i in issues):
            gaps.append(f"{sum(i.severity == 'error' for i in issues)} row(s) of the {key} "
                        "profile were dropped by validation.")  # fmt: skip
        blobs.append(json.dumps(profile, sort_keys=True).encode())
        blobs.extend(r.model_dump_json().encode() for r in rules)
        gaps += [g for g in profile.get("gaps") or [] if isinstance(g, str)]
        calendars.update(_profile_calendars(profile))
        break

    for cid, cal in library_cals.items():  # researched crops (S4) fill gaps only
        calendars.setdefault(cid, cal)
    crops: dict[str, Crop] = {}
    for cid, cal in calendars.items():
        crops[cid] = _crop_row(cid, cal.get("origin") or sage.ORIGIN, cal.get("source"),
                               name=sage_names.get(cid))  # fmt: skip
    for c in (profile or {}).get("crops") or []:  # profile crops with no calendar still count
        cid = crop_ids.canonical(c.get("crop_id")) if isinstance(c, dict) else None
        if cid and cid not in crops:
            crops[cid] = _crop_row(cid, c.get("origin") or profile.get("origin", "ai_suggested"),  # type: ignore[union-attr]
                                   None)
            gaps.append(f"{crops[cid].common_name}: the regional profile gives no calendar.")
    for c in (profile or {}).get("cover_crops") or []:
        cid = crop_ids.canonical(c.get("crop_id")) if isinstance(c, dict) else None
        if cid and cid not in crops:
            src = (c.get("sources") or [None])[0]
            crops[cid] = _crop_row(cid, c.get("origin") or profile.get("origin", "ai_suggested"),
                                   src if isinstance(src, dict) else None, role="cover_crop")  # fmt: skip
    for r in rules:
        for cid in (r.crop_id, r.previous_crop_id, r.next_crop_id):
            if cid and cid not in crops:
                crops[cid] = _crop_row(cid, r.origin, {"title": r.source_title,
                                                       "url": r.source_url})  # fmt: skip
    if not calendars:
        gaps.append("SAGE has no crop calendar for this 0.5° cell.")

    digest = hashlib.sha256(b"\n".join(blobs)).hexdigest()
    base = profile_key or (region_keys[0] if region_keys else "unknown")
    version = f"v3:{base}:{sage_cell}"
    from acre.report.meta import get_index

    # fertilizer products are grades and analyses, not regional guidance: they travel; NC's
    # nitrogen-rate rows do not (they are rules, and only this region's rules are loaded)
    products = list(get_index().catalog.fertilizers)
    catalog = Catalog(version=version, directory=Path("."), crops=list(crops.values()),
                      rules=rules, fertilizers=products, issues=[],
                      manifest=_manifest(version, digest))  # fmt: skip
    return RegionalIndex(catalog, region_key=region_keys[0] if region_keys else None,
                         region_keys=list(region_keys), in_nc=False, calendars=calendars,
                         profile=profile, profile_key=profile_key, gaps=list(dict.fromkeys(gaps)))  # fmt: skip


# --------------------------------------------------------------------------- public calls


_CELL_RE = re.compile(r"^cell_([+-]?\d+(?:\.\d+)?)_([+-]?\d+(?:\.\d+)?)$")


def _point(loc: Any) -> tuple[float, float] | None:
    if loc is None:
        return None
    if isinstance(loc, dict):
        lat = loc.get("latitude", loc.get("lat"))
        lon = loc.get("longitude", loc.get("lon"))
        if lat is None and isinstance(loc.get("cell_id"), str):
            m = _CELL_RE.match(loc["cell_id"])
            if m:
                lat, lon = float(m[1]), float(m[2])
    else:
        lat, lon = getattr(loc, "latitude", None), getattr(loc, "longitude", None)
    try:
        la, lo = float(lat), float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not (-90 <= la <= 90 and -180 <= lo <= 180):
        return None
    return la, lo


def _library_version() -> str:
    try:
        from acre.croplib import library

        return library.version()
    except Exception:  # noqa: BLE001
        return "none"


def regional_catalog(lat: float, lon: float, *, allow_network: bool = False) -> RegionalIndex:
    """The full regional catalog at a point (NC included, with SAGE calendars as context)."""
    from acre.geo.locate import describe

    d = describe(lat, lon, allow_network=allow_network)
    keys = [NC_KEY, "US", *[k for k in d.region_keys if k.startswith("koppen:")]] if d.in_nc else [
        k for k in d.region_keys if k != NC_KEY
    ]
    row, col = sage.cell_of(lat, lon)
    lat_r, lon_r = 89.75 - 0.5 * row, -179.75 + 0.5 * col
    stamps: list[Any] = [_library_version()]
    for k in keys:
        for pd in profile_dirs(k):
            stamps.append(_stamp(pd))
    return _build(tuple(keys), d.in_nc, sage.cell_label(lat, lon), lat_r, lon_r, tuple(stamps))


def catalog_for_location(loc: Any, *, allow_network: bool = False
                         ) -> tuple[CatalogIndex, dict[str, Any] | None]:  # fmt: skip
    """``(index, catalog_state)`` for a location (dict with latitude/longitude or cell_id).

    NC returns the process-wide verified v2 index unchanged (``state`` says ``complete``).
    """
    pt = _point(loc)
    if pt is None:
        version = "none"
        empty = CatalogIndex(Catalog(version=version, directory=Path("."), crops=[], rules=[],
                                     fertilizers=[], issues=[],
                                     manifest=_manifest(version, hashlib.sha256(b"").hexdigest())))  # fmt: skip
        return empty, {"status": "unknown", "origin": None, "region_key": None,
                       "reason": "invalid_location",
                       "reason_text": "The location could not be read, so no regional catalog is "
                       "used."}  # fmt: skip
    idx = regional_catalog(*pt, allow_network=allow_network)
    if idx.in_nc:
        from acre.report.meta import get_index

        return get_index(), idx.state()
    return idx, idx.state()


def clear_cache() -> None:
    _build.cache_clear()
