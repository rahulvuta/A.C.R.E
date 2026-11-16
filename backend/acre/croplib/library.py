"""The central crop library (card S4, contract §13): one SQLite file, shared by all users.

``$ACRE_CACHE_DIR/croplib.sqlite`` is a file, not a server. It is seeded on first use (and
re-seeded when its inputs change) from the built-in crop list (catalogs v2/v3 ids and aliases),
the SAGE crop list, and the economics reference data (E0). Crops researched by AI (``research.py``)
are added with ``origin: ai_suggested`` or ``source_checked``, never ``verified_source``.

Nothing about a farm is ever stored here: only crops, regional calendars and source references.
"""

from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from acre.catalogs import crop_ids
from acre.geo.config import BACKEND_ROOT, cache_root

DB_FILE = "croplib.sqlite"
SCHEMA_VERSION = "1"
_LOCK = threading.RLock()
_SEEDED: dict[str, str] = {}  # db path -> seed stamp
_VERSIONS: dict[str, tuple[float, str]] = {}
VERSION_TTL_SECONDS = 2.0
#: Reference origins the economics estimate may turn into money (``ai_suggested`` never is).
MONEY_ORIGINS = ("verified_source", "dataset_estimate", "source_checked")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS crops (
    crop_id TEXT PRIMARY KEY, name TEXT NOT NULL, scientific_name TEXT, family TEXT,
    roles TEXT NOT NULL, aliases TEXT NOT NULL, season_length_days INTEGER, origin TEXT NOT NULL,
    sources TEXT NOT NULL, researched INTEGER NOT NULL DEFAULT 0, in_sage INTEGER NOT NULL DEFAULT 0,
    in_catalog INTEGER NOT NULL DEFAULT 0, cached_at TEXT NOT NULL, notes TEXT);
CREATE TABLE IF NOT EXISTS calendars (
    crop_id TEXT NOT NULL, region_key TEXT NOT NULL, plant TEXT, harvest TEXT, origin TEXT NOT NULL,
    source TEXT, review TEXT, sage_check TEXT, cached_at TEXT NOT NULL,
    PRIMARY KEY (crop_id, region_key));
CREATE TABLE IF NOT EXISTS economics_refs (
    crop_id TEXT NOT NULL, region_key TEXT NOT NULL, kind TEXT NOT NULL, value REAL, unit TEXT,
    currency TEXT, year TEXT, origin TEXT NOT NULL, source TEXT, from_research INTEGER NOT NULL,
    item TEXT);
CREATE TABLE IF NOT EXISTS economics_research (
    crop_id TEXT NOT NULL, region_key TEXT NOT NULL, researched_at TEXT NOT NULL, status TEXT,
    found_json TEXT, cache_key TEXT, PRIMARY KEY (crop_id, region_key));
CREATE TABLE IF NOT EXISTS calendar_research (
    crop_id TEXT NOT NULL, region_key TEXT NOT NULL, researched_at TEXT NOT NULL, status TEXT,
    found_json TEXT, cache_key TEXT, PRIMARY KEY (crop_id, region_key));
CREATE TABLE IF NOT EXISTS research (
    cache_key TEXT PRIMARY KEY, name TEXT NOT NULL, region_key TEXT NOT NULL, crop_id TEXT,
    raw TEXT, guardrails TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS econ_crop ON economics_refs (crop_id, region_key);
"""


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def db_path() -> Path:
    return cache_root() / DB_FILE


@contextmanager
def connect(seed: bool = True):
    """A connection to the library (seeded first). Writes are serialised by a process lock."""
    path = db_path()
    with _LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(path, timeout=30, check_same_thread=False)
        con.row_factory = sqlite3.Row
        try:
            con.execute("PRAGMA journal_mode=WAL")
            con.executescript(SCHEMA)
            _migrate(con)
            if seed:
                _seed(con, path)
            yield con
            if con.total_changes:
                con.execute("INSERT INTO meta (key, value) VALUES ('revision', '1') "
                            "ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1")
            con.commit()
            if con.total_changes:
                _VERSIONS.pop(str(path), None)
        finally:
            con.close()


def _migrate(con: sqlite3.Connection) -> None:
    """Bring a database file made by an older version up to the current schema. Tables are added
    by ``SCHEMA`` (``IF NOT EXISTS``); a column added later needs an explicit, guarded ALTER."""
    cols = {r["name"] for r in con.execute("PRAGMA table_info(economics_refs)")}
    if "item" not in cols:
        con.execute("ALTER TABLE economics_refs ADD COLUMN item TEXT")


# --------------------------------------------------------------------------- seeding


def _catalog_ids() -> set[str]:
    p = BACKEND_ROOT / "data" / "catalogs" / "v2" / "crops.csv"
    if not p.exists():
        return set()
    with p.open(encoding="utf-8") as f:
        return {crop_ids.canonical(r["crop_id"]) or r["crop_id"] for r in csv.DictReader(f)}


def _sage_ids() -> set[str]:
    try:
        from acre.catalogs import sage

        return set(sage._load().meta["crops"])
    except Exception:  # noqa: BLE001 - SAGE missing leaves in_sage false
        return set()


def _economics_rows() -> list[dict[str, Any]]:
    from acre.economics import data

    t = data.load()
    out = []
    for kind, rows in (("price", t.prices), ("yield", t.yields)):
        for r in rows:
            out.append({"crop_id": r["crop_id"], "region_key": (r["region_key"] or "").upper(),
                        "kind": kind, "value": r.get("typical", r.get("value")),
                        "unit": r["unit"], "currency": r.get("currency"),
                        "year": r.get("years") or r.get("year"), "origin": r["origin"],
                        "source": data.source_of(r)})  # fmt: skip
    for r in t.costs:
        out.append({"crop_id": r["crop_id"], "region_key": (r["region_key"] or "").upper(),
                    "kind": f"cost:{r['item']}", "value": r["value"], "unit": r["unit"],
                    "currency": r["currency"], "year": r.get("year"), "origin": r["origin"],
                    "source": data.source_of(r)})  # fmt: skip
    return out


#: Crops that stay in the ground for years (card 21). A name is all the plan needs from them:
#: nothing is planted each season, and their yield, price and costs are the grower's own. They
#: are listed so a grower can pick one without waiting for a lookup. (id, name, family, aliases)
LASTING_CROPS: tuple[tuple[str, str, str | None, tuple[str, ...]], ...] = (
    ("pasture", "Pasture (grazing land)", "Poaceae", ("grass", "grazing", "rangeland", "meadow")),
    ("hay_grass", "Hay or fodder grass", "Poaceae", ("hay", "fodder", "napier grass")),
    ("alfalfa", "Alfalfa (lucerne)", "Fabaceae", ("lucerne",)),
    ("coffee", "Coffee", "Rubiaceae", ()),
    ("tea", "Tea", "Theaceae", ()),
    ("banana", "Banana or plantain", "Musaceae", ("plantain", "enset")),
    ("cocoa", "Cocoa", "Malvaceae", ("cacao",)),
    ("oil_palm", "Oil palm", "Arecaceae", ("palm oil",)),
    ("coconut", "Coconut", "Arecaceae", ()),
    ("rubber", "Rubber", "Euphorbiaceae", ()),
    ("fruit_trees", "Fruit trees (mango, citrus, apple and others)", None,
     ("orchard", "mango", "citrus", "orange", "apple", "avocado")),
    ("nut_trees", "Nut trees (almond, walnut, cashew and others)", None,
     ("almond", "walnut", "cashew", "pistachio")),
    ("grapes", "Grapes", "Vitaceae", ("vineyard", "vines")),
    ("olive", "Olive", "Oleaceae", ("olives",)),
)  # fmt: skip


def _seed_stamp() -> str:
    from acre.economics import data

    parts = [SCHEMA_VERSION, sorted(c.crop_id for c in crop_ids.CROPS), LASTING_CROPS]
    d = data.data_dir()
    for name in data.FILES:
        p = d / f"{name}.csv"
        parts.append((str(p), p.stat().st_mtime_ns if p.exists() else None))
    return hashlib.sha256(repr(parts).encode()).hexdigest()[:16]


def _seed(con: sqlite3.Connection, path: Path) -> None:
    stamp = _seed_stamp()
    if _SEEDED.get(str(path)) == stamp:
        return
    row = con.execute("SELECT value FROM meta WHERE key='seed'").fetchone()
    if row is None or row["value"] != stamp:
        now = _now()
        cat, sg = _catalog_ids(), _sage_ids()
        for c in crop_ids.CROPS:
            origin = ("verified_source" if c.crop_id in cat else
                      "dataset_estimate" if c.crop_id in sg else "assumed")  # fmt: skip
            src = ([{"title": "A.C.R.E verified NC catalog (v2)", "url": None}] if c.crop_id in cat
                   else [{"title": "Sacks et al. 2010 crop calendar (SAGE)", "url":
                          "https://sage.nelson.wisc.edu/data-and-models/datasets/crop-calendar-dataset/"}]
                   if c.crop_id in sg else [{"title": "A.C.R.E crop list", "url": None}])  # fmt: skip
            con.execute(
                "INSERT INTO crops (crop_id, name, family, roles, aliases, origin, sources, "
                "researched, in_sage, in_catalog, cached_at) VALUES (?,?,?,?,?,?,?,0,?,?,?) "
                "ON CONFLICT(crop_id) DO UPDATE SET name=excluded.name, family=excluded.family, "
                "roles=excluded.roles, aliases=excluded.aliases, origin=excluded.origin, "
                "sources=excluded.sources, in_sage=excluded.in_sage, "
                "in_catalog=excluded.in_catalog WHERE researched=0",
                (c.crop_id, c.name, c.family, json.dumps(list(c.all_roles())),
                 json.dumps(list(c.aliases)), origin, json.dumps(src), int(c.crop_id in sg),
                 int(c.crop_id in cat), now))  # fmt: skip
        for cid, name, family, aliases in LASTING_CROPS:
            # never over a built-in crop or one a grower already looked up
            con.execute(
                "INSERT OR IGNORE INTO crops (crop_id, name, family, roles, aliases, origin, "
                "sources, cached_at) VALUES (?,?,?,?,?,?,?,?)",
                (cid, name, family, json.dumps(["cash_crop"]), json.dumps(list(aliases)),
                 "assumed", json.dumps([{"title": "A.C.R.E crop list", "url": None}]), now))
        con.execute("DELETE FROM economics_refs WHERE from_research=0")
        for e in _economics_rows():
            con.execute(
                "INSERT OR IGNORE INTO crops (crop_id, name, roles, aliases, origin, sources, "
                "cached_at) VALUES (?,?,?,?,?,?,?)",
                (e["crop_id"], e["crop_id"].replace("_", " ").capitalize(),
                 json.dumps(["cash_crop"]), "[]", e["origin"], json.dumps([e["source"]]), now))
            con.execute(
                "INSERT INTO economics_refs (crop_id, region_key, kind, value, unit, currency, "
                "year, origin, source, from_research) VALUES (?,?,?,?,?,?,?,?,?,0)",
                (e["crop_id"], e["region_key"], e["kind"], e["value"], e["unit"], e["currency"],
                 e["year"], e["origin"], json.dumps(e["source"])))  # fmt: skip
        con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('seed', ?)", (stamp,))
        con.commit()
    _SEEDED[str(path)] = stamp


def reset() -> None:
    """Tests: forget what was seeded and loaded in this process."""
    with _LOCK:
        _SEEDED.clear()
        _VERSIONS.clear()
        crop_ids.clear_extra()


# --------------------------------------------------------------------------- reads


def version() -> str:
    """Changes whenever a researched crop or calendar is stored (part of regional cache keys)."""
    path = db_path()
    with _LOCK:
        if not path.exists():
            _VERSIONS.pop(str(path), None)
            return "empty"
        cached = _VERSIONS.get(str(path))
        now = time.monotonic()
        if cached and now - cached[0] < VERSION_TTL_SECONDS:
            return cached[1]
        with connect(seed=False) as con:
            revision = con.execute("SELECT value FROM meta WHERE key='revision'").fetchone()
            r = con.execute("SELECT COUNT(*) n, MAX(cached_at) m FROM calendars").fetchone()
            c = con.execute("SELECT COUNT(*) n FROM crops WHERE researched=1").fetchone()
        value = f"{revision['value'] if revision else '0'}:{r['n']}:{r['m']}:{c['n']}"
        _VERSIONS[str(path)] = (now, value)
        return value


def load_extras(loaded: list[str]) -> bool:
    """Register researched crops with ``crop_ids`` if the library changed; True if it did."""
    if not db_path().exists():
        return False
    v = version()
    if loaded and loaded[0] == v:
        return False
    with connect(seed=False) as con:
        rows = con.execute("SELECT * FROM crops").fetchall()
    for r in rows:
        if r["crop_id"] not in crop_ids.BY_ID:
            crop_ids.register(_crop_id_obj(r))
    loaded[:] = [v]
    return True


def _crop_id_obj(r: sqlite3.Row) -> crop_ids.CropId:
    roles = tuple(json.loads(r["roles"]))
    return crop_ids.CropId(r["crop_id"], r["name"], roles[0] if roles else "cash_crop",
                           r["family"] or "unknown", tuple(json.loads(r["aliases"])), roles)  # fmt: skip


def _region_match(rk: str, keys: list[str]) -> bool:
    return rk.upper() in {k.upper() for k in keys}


def calendars_for(region_keys: list[str]) -> dict[str, dict[str, Any]]:
    """Researched calendars usable at a place: the most specific own region, not flagged."""
    if not db_path().exists() or not region_keys:
        return {}
    keys = [k for k in region_keys if not k.startswith("koppen:")]
    with connect(seed=False) as con:
        rows = con.execute("SELECT * FROM calendars").fetchall()
    out: dict[str, dict[str, Any]] = {}
    for k in keys:  # most specific first
        for r in rows:
            if r["region_key"].upper() != k.upper() or r["crop_id"] in out:
                continue
            if r["review"] == "manual_check" or not r["plant"] or not r["harvest"]:
                continue
            out[r["crop_id"]] = {"plant": json.loads(r["plant"]),
                                 "harvest": json.loads(r["harvest"]), "origin": r["origin"],
                                 "source": json.loads(r["source"]) if r["source"] else None,
                                 "region_key": r["region_key"], "library": True}  # fmt: skip
    return out


def _chain(region_key: str | None) -> list[str]:
    if not region_key:
        return []
    rk = region_key.upper()
    return [rk, rk.split("-", 1)[0]] if "-" in rk else [rk]


def get_crop(crop_id: str, region_key: str | None = None) -> dict[str, Any] | None:
    cid = crop_ids.canonical(crop_id) or (crop_id or "").strip().lower()
    with connect() as con:
        r = con.execute("SELECT * FROM crops WHERE crop_id=?", (cid,)).fetchone()
        if r is None:
            return None
        cals = con.execute("SELECT * FROM calendars WHERE crop_id=? ORDER BY region_key",
                           (cid,)).fetchall()  # fmt: skip
        refs = con.execute("SELECT * FROM economics_refs WHERE crop_id=? ORDER BY region_key, "
                           "kind", (cid,)).fetchall()  # fmt: skip
    chain = _chain(region_key)
    keep = (lambda rk: rk.upper() in chain) if chain else (lambda rk: True)  # noqa: E731
    return {
        "crop_id": r["crop_id"], "name": r["name"], "scientific_name": r["scientific_name"],
        "family": r["family"], "roles": json.loads(r["roles"]),
        "aliases": json.loads(r["aliases"]),
        "season_length_days": r["season_length_days"],
        "calendars": [{"region_key": c["region_key"],
                       "plant": json.loads(c["plant"]) if c["plant"] else None,
                       "harvest": json.loads(c["harvest"]) if c["harvest"] else None,
                       "origin": c["origin"],
                       "source": json.loads(c["source"]) if c["source"] else None,
                       "review": c["review"],
                       "sage_check": json.loads(c["sage_check"]) if c["sage_check"] else None}
                      for c in cals if keep(c["region_key"])],
        "economics_refs": [{"region_key": e["region_key"], "kind": e["kind"], "item": e["item"],
                            "value": e["value"],
                            "unit": e["unit"], "currency": e["currency"], "year": e["year"],
                            "origin": e["origin"],
                            "source": json.loads(e["source"]) if e["source"] else None,
                            "used_for_money": e["origin"] in MONEY_ORIGINS}
                           for e in refs if keep(e["region_key"])],
        "origin": r["origin"], "sources": json.loads(r["sources"]),
        "researched": bool(r["researched"]), "in_sage": bool(r["in_sage"]),
        "notes": r["notes"], "cached_at": r["cached_at"],
    }  # fmt: skip


def search(q: str, region_key: str | None = None, limit: int = 25) -> list[dict[str, Any]]:
    needle = (q or "").strip().lower()
    chain = _chain(region_key)
    with connect() as con:
        rows = con.execute("SELECT * FROM crops ORDER BY crop_id").fetchall()
        cal = {(r["crop_id"], r["region_key"].upper()) for r in
               con.execute("SELECT crop_id, region_key FROM calendars WHERE review IS NULL OR "
                           "review != 'manual_check'")}  # fmt: skip
        econ = {(r["crop_id"], r["region_key"].upper()) for r in
                con.execute("SELECT crop_id, region_key FROM economics_refs WHERE origin IN "
                            "('verified_source', 'dataset_estimate', 'source_checked')")}  # fmt: skip
    hits = []
    for r in rows:
        hay = [r["crop_id"], r["name"].lower(), *(a.lower() for a in json.loads(r["aliases"])),
               (r["scientific_name"] or "").lower()]  # fmt: skip
        if needle and not any(needle in h.replace("_", " ") or needle in h for h in hay):
            continue
        exact = needle in (r["crop_id"], r["name"].lower(), *json.loads(r["aliases"]))
        has_cal = any((r["crop_id"], k) in cal for k in chain) or bool(r["in_sage"])
        has_econ = any((r["crop_id"], k) in econ for k in chain) if chain else any(
            c == r["crop_id"] for c, _ in econ)
        note = ("SAGE gridded calendar where it is grown in your field's cell"
                if r["in_sage"] and not any((r["crop_id"], k) in cal for k in chain) else
                "Researched calendar for this region" if has_cal else
                "No calendar for this region yet")  # fmt: skip
        hits.append((not exact, r["crop_id"], {
            "crop_id": r["crop_id"], "name": r["name"], "family": r["family"],
            "roles": json.loads(r["roles"]), "origin": r["origin"], "has_calendar": has_cal,
            "has_economics": has_econ, "region_note": note, "researched": bool(r["researched"])}))  # fmt: skip
    return [h[2] for h in sorted(hits, key=lambda h: (h[0], h[1]))[:limit]]


# --------------------------------------------------------------------------- writes (research)


def cached_research(cache_key: str) -> str | None:
    with connect() as con:
        r = con.execute("SELECT crop_id FROM research WHERE cache_key=?", (cache_key,)).fetchone()
    return r["crop_id"] if r else None


def store_research(*, cache_key: str, name: str, region_key: str, crop: dict[str, Any],
                   calendars: list[dict[str, Any]], refs: list[dict[str, Any]], raw: Any,
                   guardrails: dict[str, Any]) -> str:  # fmt: skip
    now = _now()
    cid = crop["crop_id"]
    with connect() as con:
        existing = con.execute("SELECT researched FROM crops WHERE crop_id=?", (cid,)).fetchone()
        if existing is not None and not existing["researched"]:
            raise ValueError(f"{cid} is a built-in crop")  # never overwrite a built-in crop
        con.execute(
            "INSERT INTO crops (crop_id, name, scientific_name, family, roles, aliases, "
            "season_length_days, origin, sources, researched, cached_at, notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(crop_id) DO UPDATE SET "
            "name=excluded.name, scientific_name=excluded.scientific_name, family=excluded.family, "
            "roles=excluded.roles, aliases=excluded.aliases, "
            "season_length_days=excluded.season_length_days, origin=excluded.origin, "
            "sources=excluded.sources, cached_at=excluded.cached_at, notes=excluded.notes",
            (cid, crop["name"], crop.get("scientific_name"), crop.get("family"),
             json.dumps(crop["roles"]), json.dumps(crop.get("aliases") or []),
             crop.get("season_length_days"), crop["origin"], json.dumps(crop.get("sources") or []),
             now, crop.get("notes")))  # fmt: skip
        con.execute("DELETE FROM calendars WHERE crop_id=? AND region_key=?", (cid, region_key))
        for c in calendars:
            con.execute(
                "INSERT OR REPLACE INTO calendars (crop_id, region_key, plant, harvest, origin, "
                "source, review, sage_check, cached_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (cid, region_key, json.dumps(c.get("plant")) if c.get("plant") else None,
                 json.dumps(c.get("harvest")) if c.get("harvest") else None, c["origin"],
                 json.dumps(c.get("source")), c.get("review"),
                 json.dumps(c.get("sage_check")) if c.get("sage_check") else None, now))  # fmt: skip
        con.execute("DELETE FROM economics_refs WHERE crop_id=? AND region_key=? AND "
                    "from_research=1", (cid, region_key))  # fmt: skip
        for e in refs:
            con.execute(
                "INSERT INTO economics_refs (crop_id, region_key, kind, value, unit, currency, "
                "year, origin, source, from_research, item) VALUES (?,?,?,?,?,?,?,?,?,1,?)",
                (cid, region_key, e["kind"], e["value"], e["unit"], e.get("currency"),
                 e.get("year"), e["origin"], json.dumps(e.get("source")), e.get("item")))  # fmt: skip
        con.execute("INSERT OR REPLACE INTO research (cache_key, name, region_key, crop_id, raw, "
                    "guardrails, created_at) VALUES (?,?,?,?,?,?,?)",
                    (cache_key, name, region_key, cid, json.dumps(raw), json.dumps(guardrails),
                     now))  # fmt: skip
    crop_ids.register(crop_ids.CropId(cid, crop["name"], crop["roles"][0],
                                      crop.get("family") or "unknown",
                                      tuple(crop.get("aliases") or []), tuple(crop["roles"])))  # fmt: skip
    from acre.catalogs import regional

    regional.clear_cache()
    return cid


# --------------------------------------------------------------------------- researched economics
# and calendars for a crop that is already known (cards: economics research, calendar research)

_STATUS_TABLES = {"economics": "economics_research", "calendars": "calendar_research"}


def _record(con: sqlite3.Connection, kind: str, crop_id: str, region_key: str, status: str,
            found: dict[str, int], cache_key: str) -> None:
    con.execute(f"INSERT OR REPLACE INTO {_STATUS_TABLES[kind]} (crop_id, region_key, "
                "researched_at, status, found_json, cache_key) VALUES (?,?,?,?,?,?)",
                (crop_id, region_key, _now(), status, json.dumps(found), cache_key))  # fmt: skip


def research_status(kind: str, crop_id: str, region_key: str) -> dict[str, Any] | None:
    """When this crop and region were last researched for ``economics`` or ``calendars``."""
    if not db_path().exists():
        return None
    with connect(seed=False) as con:
        r = con.execute(f"SELECT * FROM {_STATUS_TABLES[kind]} WHERE crop_id=? AND region_key=?",
                        (crop_id, region_key.upper())).fetchone()  # fmt: skip
    if r is None:
        return None
    return {"researched_at": r["researched_at"], "status": r["status"],
            "found": json.loads(r["found_json"]) if r["found_json"] else None,
            "cache_key": r["cache_key"]}  # fmt: skip


def store_economics(*, crop_id: str, region_key: str, refs: list[dict[str, Any]], status: str,
                    found: dict[str, int], cache_key: str) -> None:  # fmt: skip
    """Replace this crop+region's researched references (never the seeded ones), one kind at a
    time, and record the research. A kind the new search found nothing for keeps what an earlier
    search found: looking again must never take away a price the grower was already shown."""
    rk = region_key.upper()
    with connect() as con:
        for kind in sorted({e["kind"] for e in refs}):
            con.execute("DELETE FROM economics_refs WHERE crop_id=? AND region_key=? AND "
                        "from_research=1 AND kind=?", (crop_id, rk, kind))  # fmt: skip
        for e in refs:
            con.execute(
                "INSERT INTO economics_refs (crop_id, region_key, kind, value, unit, currency, "
                "year, origin, source, from_research, item) VALUES (?,?,?,?,?,?,?,?,?,1,?)",
                (crop_id, rk, e["kind"], e["value"], e["unit"], e.get("currency"),
                 None if e.get("year") is None else str(e["year"]), e["origin"],
                 json.dumps(e.get("source")), e.get("item")))  # fmt: skip
        _record(con, "economics", crop_id, rk, status, found, cache_key)


def researched_refs(crop_id: str, chain: list[str]) -> list[dict[str, Any]]:
    """Researched economics references of a crop for the regions in ``chain`` (most specific
    first), as dicts with the source decoded. ``[]`` when there is no library file yet."""
    if not chain or not db_path().exists():
        return []
    keys = [k.upper() for k in chain]
    with connect(seed=False) as con:
        rows = con.execute("SELECT * FROM economics_refs WHERE crop_id=? AND from_research=1",
                           (crop_id,)).fetchall()  # fmt: skip
    out = [{"region_key": r["region_key"].upper(), "kind": r["kind"], "item": r["item"],
            "value": r["value"], "unit": r["unit"], "currency": r["currency"],
            "year": r["year"], "origin": r["origin"],
            "source": json.loads(r["source"]) if r["source"] else {}}
           for r in rows if r["region_key"].upper() in keys]  # fmt: skip
    return sorted(out, key=lambda e: keys.index(e["region_key"]))


def store_calendars(*, crop_id: str, region_key: str, calendars: list[dict[str, Any]],
                    status: str, found: dict[str, int], cache_key: str) -> None:  # fmt: skip
    """Store researched calendars for a known crop+region (replacing earlier researched ones when
    there are new ones) and record the research. Seeded crop data is never touched."""
    rk = region_key.upper()
    now = _now()
    with connect() as con:
        if calendars:
            con.execute("DELETE FROM calendars WHERE crop_id=? AND region_key=?", (crop_id, rk))
        for c in calendars:
            con.execute(
                "INSERT OR REPLACE INTO calendars (crop_id, region_key, plant, harvest, origin, "
                "source, review, sage_check, cached_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (crop_id, rk, json.dumps(c.get("plant")) if c.get("plant") else None,
                 json.dumps(c.get("harvest")) if c.get("harvest") else None, c["origin"],
                 json.dumps(c.get("source")), c.get("review"),
                 json.dumps(c.get("sage_check")) if c.get("sage_check") else None, now))  # fmt: skip
        _record(con, "calendars", crop_id, rk, status, found, cache_key)
    from acre.catalogs import regional

    regional.clear_cache()


def researched_calendar(crop_id: str, chain: list[str]) -> dict[str, Any] | None:
    """The most specific researched calendar of a crop for the region chain that is not flagged
    ``manual_check`` and has a planting window (a harvest window may be missing)."""
    if not chain or not db_path().exists():
        return None
    with connect(seed=False) as con:
        rows = con.execute("SELECT * FROM calendars WHERE crop_id=?", (crop_id,)).fetchall()
    for k in chain:
        for r in rows:
            if r["region_key"].upper() != k.upper() or not r["plant"]:
                continue
            if r["review"] == "manual_check":
                continue
            return {"plant": json.loads(r["plant"]),
                    "harvest": json.loads(r["harvest"]) if r["harvest"] else None,
                    "origin": r["origin"], "region_key": r["region_key"].upper(),
                    "source": json.loads(r["source"]) if r["source"] else None}  # fmt: skip
    return None
