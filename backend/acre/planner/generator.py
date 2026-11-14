"""Rotation generator (card P1): ``generate_candidates(location, field_context, goals)``.

It enumerates multi-season crop sequences for one field. Each season is an ordinary :class:`Plan`
leg (previous crop → off-season → next crop), so the next leg starts with the crop the last one
planted. The off-season can be bare, a cover crop, or a winter grain followed by a double crop.

Where every date comes from (``origin`` on each one):
* **North Carolina**: the demo presets' dates (``assumed``: they are typical Piedmont dates, not this
  farm's), cover windows from the verified catalog (finder logic), and SAGE for anything else.
* **Elsewhere**: SAGE's typical planting and harvest days for the location's 0.5° cell
  (``dataset_estimate``), or a regional profile's calendar (its own origin). Cover-crop seeding a
  week after harvest and termination two weeks before planting are ``assumed`` unless the profile
  gives windows. Double crops come only from a profile (or the NC preset).

Hard constraints prune; a pruned candidate is never returned, and the ``generation_log`` says what
was pruned and why. Every leg goes through the checker: a flagged ``avoid`` verdict or a
chronology conflict drops the candidate; ``manual_check`` and ``caution`` stay, listed. At most 50
candidates come back, in a deterministic order (sequences matching a known rotation first, then
more liked crops, fewer disliked ones, no cash crop repeated back-to-back, then by crop ids). That
is an ordering, not a score: no number is computed for a candidate.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache
from itertools import product
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from acre.catalogs import crop_ids
from acre.catalogs.regional import RegionalIndex, regional_catalog
from acre.contracts import Plan, Status, WinterManagement
from acre.planner.checker import CheckResult, check_plan, default_planting_year
from acre.planner.finder import _gaps, _seed_window
from acre.planner.goals import FieldContext, Goals

MAX_CANDIDATES = 50
MIN_CALENDAR_CROPS = 2
COVER_SEED_AFTER_HARVEST_DAYS = 7  # assumed
COVER_GAP_DAYS = 14  # assumed (the finder's fallback gap)
DOUBLE_CROP_AFTER_GRAIN_DAYS = 7  # assumed
WINTER_GRAINS = frozenset({"winter_wheat", "winter_barley", "winter_oats", "winter_rye",
                           "winter_rapeseed"})  # fmt: skip
SAMPLES_PATH = Path(__file__).resolve().parents[2] / "data" / "samples" / "union_plans.json"
PRESET_SOURCE = {"title": "A.C.R.E NC demo presets (typical Piedmont dates, assumed)",
                 "url": None}  # fmt: skip
ASSUMED_SOURCE = {"title": "A.C.R.E default spacing (assumed, not sourced)", "url": None}


# --------------------------------------------------------------------------- results


class SeasonLeg(BaseModel):
    season: int  # 1-based
    year: int  # the year of this leg's planting (``next_plant``)
    plan: Plan
    origins: dict[str, str]  # plan date field -> origin
    sources: dict[str, dict[str, Any]] = Field(default_factory=dict)
    flagged: list[str] = Field(default_factory=list)
    manual_check: list[str] = Field(default_factory=list)
    unknown: list[str] = Field(default_factory=list)


class Candidate(BaseModel):
    candidate_id: str
    label: str
    crops: list[str]  # crop ids in field order, covers included
    seasons: list[SeasonLeg]
    origins: list[str]  # every origin any date or rule of this candidate rests on
    checks_summary: dict[str, Any]
    matches_rotation: str | None = None  # a preset or profile rotation this sequence is

    @property
    def plans(self) -> list[Plan]:
        return [s.plan for s in self.seasons]


class LogEntry(BaseModel):
    kind: str  # constraint | rule | cap | input | note
    name: str  # the constraint, rule id or note key
    pruned: int  # candidates (or options) removed
    reason_text: str
    examples: list[str] = Field(default_factory=list)


class GenerationResult(BaseModel):
    status: Status
    reason: str | None = None
    reason_text: str | None = None
    region_key: str | None
    catalog: dict[str, Any]
    start_year: int
    candidates: list[Candidate] = Field(default_factory=list)
    generation_log: list[LogEntry] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    total_generated: int = 0


# --------------------------------------------------------------------------- dates


@dataclass(frozen=True)
class CropDates:
    plant: str | None
    harvest: str | None
    origin: str
    source: dict[str, Any] | None


def _md(d: date) -> str:
    return f"{d.month:02d}-{d.day:02d}"


def _shift(mmdd: str, days: int) -> str:
    """``MM-DD`` moved by ``days`` on a common (non-leap) year; 02-29 itself is read on a leap
    year. Plan dates carry no year, so across a 29 February the spacing can be one day off; the
    checker re-dates every plan in its real year."""
    year = 2000 if mmdd == "02-29" else 2001
    return _md(date(year, int(mmdd[:2]), int(mmdd[3:])) + timedelta(days=days))


def _doy(mmdd: str) -> int:
    m, d = int(mmdd[:2]), int(mmdd[3:])
    return (date(2001, m, min(d, 28 if m == 2 else d)) - date(2001, 1, 1)).days


def _after(anchor: str, mmdd: str) -> int:
    """Days from ``anchor`` forward to ``mmdd`` (0-364), so dates compare within one cycle."""
    return (_doy(mmdd) - _doy(anchor)) % 365


@lru_cache(maxsize=1)
def _presets() -> list[dict[str, Any]]:
    doc = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))
    return [{"plan": s["plan"], "rotation_id": s.get("rotation_id")} for s in doc["samples"]]


@lru_cache(maxsize=1)
def _preset_rotations() -> list[tuple[str, tuple[str, ...]]]:
    doc = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))
    return [(r["rotation_id"], tuple(r["legs"])) for r in doc["rotations"]]


def _date_table(idx: RegionalIndex, use_presets: bool) -> dict[str, CropDates]:
    """Typical plant and harvest day per canonical crop id."""
    table: dict[str, CropDates] = {}
    if use_presets:
        plant: dict[str, str] = {}
        harvest: dict[str, str] = {}
        for p in _presets():
            plan = p["plan"]
            harvest.setdefault(crop_ids.canonical(plan["previous_crop_id"]), plan["prev_harvest"])
            if plan["winter"]["kind"] != "winter_grain":  # double-crop planting is not typical
                plant.setdefault(crop_ids.canonical(plan["next_crop_id"]), plan["next_plant"])
        for cid in sorted(set(plant) | set(harvest)):
            table[cid] = CropDates(plant.get(cid), harvest.get(cid), "assumed", PRESET_SOURCE)
    for cid, cal in sorted(idx.calendars.items()):
        c = crop_ids.canonical(cid) or cid
        if c in table or cal.get("extrapolated"):
            continue
        p, h = cal.get("plant") or {}, cal.get("harvest") or {}
        table[c] = CropDates(p.get("typical") or p.get("start"), h.get("typical") or h.get("start"),
                             cal.get("origin") or "dataset_estimate", cal.get("source"))  # fmt: skip
    return table


# --------------------------------------------------------------------------- off-season options


@dataclass(frozen=True)
class Option:
    winter: WinterManagement
    next_plant: str
    origins: dict[str, str]
    sources: dict[str, dict[str, Any]]
    label: str


def _preset_option(prev: str, nxt: str, kind: str, crop: str | None) -> dict[str, Any] | None:
    for p in _presets():
        plan = p["plan"]
        w = plan["winter"]
        if (crop_ids.canonical(plan["previous_crop_id"]) == prev
                and crop_ids.canonical(plan["next_crop_id"]) == nxt and w["kind"] == kind
                and crop_ids.canonical(w.get("crop_id")) == crop):  # fmt: skip
            return plan
    return None


def _seed_in_window(harvest: str, plant: str, start: str, end: str) -> str | None:
    """A cover seeding date inside the window ``start``-``end`` that follows ``harvest`` (by the
    usual week, or the window's opening day) and comes before ``plant``; ``None`` if none does."""
    length = (_doy(end) - _doy(start)) % 365
    s_off, e_off, p_off = _after(harvest, start), _after(harvest, end), _after(harvest, plant)
    since_start = (365 - s_off) % 365  # days since the window opened (0: it opens on harvest day)
    if since_start <= length:  # the window is open at harvest: seed a week later, if still open
        wait = COVER_SEED_AFTER_HARVEST_DAYS
        return _shift(harvest, wait) if wait <= e_off and wait < p_off else None
    return start if s_off < p_off else None  # it opens later: seed on its first day


def _cover_options(idx: RegionalIndex, prev: str, nxt: str, harvest: str, plant: str,
                   nc: bool, log: _Log, region: str | None = None) -> list[Option]:  # fmt: skip
    out: list[Option] = []
    covers = sorted({crop_ids.canonical(c.crop_id) or c.crop_id for c in idx.cover_crops()})
    profile_covers = {crop_ids.canonical(c.get("crop_id")): c for c in idx.cover_crop_options()
                      if isinstance(c, dict)}  # fmt: skip
    for cover in covers:
        cat_id = idx.catalog_id(cover) or cover
        name = (idx.crop(cover).common_name if idx.crop(cover) else None) or cover
        preset = _preset_option(prev, nxt, "cover", cover) if nc else None
        if preset is not None:
            w = preset["winter"]
            out.append(Option(WinterManagement(kind="cover", crop_id=cat_id, seed=w["seed"],
                                               terminate=w["terminate"]), plant,
                              {"winter.seed": "assumed", "winter.terminate": "assumed"},
                              {"winter.seed": PRESET_SOURCE, "winter.terminate": PRESET_SOURCE},
                              f"{name} cover"))  # fmt: skip
            continue
        seed_origin = term_origin = "assumed"
        seed_src: dict[str, Any] = ASSUMED_SOURCE
        term_src: dict[str, Any] = ASSUMED_SOURCE
        seed = _shift(harvest, COVER_SEED_AFTER_HARVEST_DAYS)
        gap = COVER_GAP_DAYS
        if nc:
            win = _seed_window(idx, cat_id, region)
            if win is not None and win.window_start_mm_dd and win.window_end_mm_dd:
                picked = _seed_in_window(harvest, plant, win.window_start_mm_dd,
                                         win.window_end_mm_dd)  # fmt: skip
                if picked is not None:  # only a date inside the window takes its provenance
                    seed = picked
                    seed_origin, seed_src = "verified_source", {"title": win.source_title,
                                                                "url": win.source_url,
                                                                "rule_id": win.rule_id}  # fmt: skip
            gaps = _gaps(idx, cat_id, idx.catalog_id(nxt) or nxt, region)
            gap = gaps[0]
            if gap != COVER_GAP_DAYS or any(
                r.rule_type == "termination_timing" for r in idx.rules_for_crop(cat_id)
            ):
                term_origin = "verified_source"
                term_src = {"title": "termination-timing rules of the verified catalog",
                            "url": None}  # fmt: skip
        else:
            pc = profile_covers.get(cover) or {}
            sw = pc.get("seed") if isinstance(pc.get("seed"), dict) else None
            if sw and sw.get("start") and _after(harvest, sw["start"]) < _after(harvest, plant):
                seed = sw["start"]  # only a sourced date that fits takes the profile's origin
                seed_origin = pc.get("origin") or "ai_suggested"
                seed_src = (pc.get("sources") or [ASSUMED_SOURCE])[0]
            if isinstance(pc.get("gap_days"), int) and pc["gap_days"] > 0:
                gap, term_origin = pc["gap_days"], pc.get("origin") or "ai_suggested"
                term_src = (pc.get("sources") or [ASSUMED_SOURCE])[0]
        terminate = _shift(plant, -gap)
        if not 0 < _after(harvest, seed) < _after(harvest, terminate) < _after(harvest, plant):
            log.add("note", f"cover:{cover}", 1, f"{name} does not fit between the {prev} harvest "
                    f"({harvest}) and {nxt} planting ({plant}).", f"{prev}>{cover}>{nxt}")  # fmt: skip
            continue
        out.append(Option(WinterManagement(kind="cover", crop_id=cat_id, seed=seed,
                                           terminate=terminate), plant,
                          {"winter.seed": seed_origin, "winter.terminate": term_origin},
                          {"winter.seed": seed_src, "winter.terminate": term_src},
                          f"{name} cover"))  # fmt: skip
    return out


def _double_crop_options(idx: RegionalIndex, table: dict[str, CropDates], prev: str, nxt: str,
                         nc: bool) -> list[Option]:  # fmt: skip
    out: list[Option] = []
    if nc:
        preset = _preset_option(prev, nxt, "winter_grain", "winter_wheat")
        if preset is not None:
            w = preset["winter"]
            out.append(Option(WinterManagement(kind="winter_grain", crop_id="winter_wheat",
                                               plant=w["plant"], harvest=w["harvest"]),
                              preset["next_plant"],
                              {"winter.plant": "assumed", "winter.harvest": "assumed",
                               "next_plant": "assumed"},
                              {k: PRESET_SOURCE for k in ("winter.plant", "winter.harvest",
                                                          "next_plant")},
                              "winter wheat, then double-crop"))  # fmt: skip
        return out
    for dc in idx.double_crops():
        if not isinstance(dc, dict):
            continue
        grain = crop_ids.canonical(dc.get("winter_crop"))
        follow = crop_ids.canonical(dc.get("next_crop"))
        g = table.get(grain or "")
        if follow != nxt or g is None or not g.plant or not g.harvest:
            continue
        origin = dc.get("origin") or "ai_suggested"
        src = (dc.get("sources") or [ASSUMED_SOURCE])[0]
        out.append(Option(WinterManagement(kind="winter_grain", crop_id=idx.catalog_id(grain)
                                           or grain, plant=g.plant, harvest=g.harvest),
                          _shift(g.harvest, DOUBLE_CROP_AFTER_GRAIN_DAYS),
                          {"winter.plant": g.origin, "winter.harvest": g.origin,
                           "next_plant": "assumed", "double_crop": origin},
                          {"winter.plant": g.source or {}, "winter.harvest": g.source or {},
                           "next_plant": ASSUMED_SOURCE, "double_crop": src},
                          f"{grain}, then double-crop"))  # fmt: skip
    return out


# --------------------------------------------------------------------------- logging


class _Log:
    def __init__(self) -> None:
        self.entries: dict[tuple[str, str], LogEntry] = {}

    def add(self, kind: str, name: str, n: int, text: str, example: str | None = None) -> None:
        e = self.entries.get((kind, name))
        if e is None:
            e = self.entries[(kind, name)] = LogEntry(kind=kind, name=name, pruned=0,
                                                      reason_text=text)  # fmt: skip
        e.pruned += n
        if example and len(e.examples) < 3 and example not in e.examples:
            e.examples.append(example)

    def out(self) -> list[LogEntry]:
        return [self.entries[k] for k in sorted(self.entries)]


# --------------------------------------------------------------------------- main


def _crop_name(idx: RegionalIndex, cid: str) -> str:
    c = idx.crop(cid)
    info = crop_ids.info(cid)
    return (c.common_name if c and c.common_name else None) or (info.name if info else cid)


def _candidate_id(plans: list[Plan]) -> str:
    blob = json.dumps([p.model_dump(mode="json", exclude={"plan_id", "label"}) for p in plans],
                      sort_keys=True)  # fmt: skip
    return "c_" + hashlib.sha256(blob.encode()).hexdigest()[:10]


def _point(location: Any) -> tuple[float, float]:
    if isinstance(location, dict):
        return float(location["latitude"]), float(location["longitude"])
    return float(location.latitude), float(location.longitude)


def generate_candidates(location: Any, field_context: FieldContext | None = None,
                        goals: Goals | None = None, *, start_year: int | None = None
                        ) -> GenerationResult:  # fmt: skip
    """Candidate rotations for one field. Deterministic for the same inputs and catalog."""
    fc = field_context or FieldContext()
    g = goals or Goals()
    con, pref = g.constraints, g.preferences
    lat, lon = _point(location)
    idx = regional_catalog(lat, lon)
    nc = idx.in_nc
    year0 = start_year or default_planting_year()
    log = _Log()
    state = idx.state()
    base = {"region_key": idx.profile_key or idx.region_key, "catalog": state, "start_year": year0,
            "gaps": list(idx.gaps)}  # fmt: skip

    table = _date_table(idx, use_presets=nc)
    region = None
    if nc:  # NC sub-region rules need the field's region (Piedmont, Coastal Plain, ...)
        from acre.geo.locate import describe

        nc_region = describe(lat, lon, allow_network=False).nc_region
        region = f"NC {nc_region}" if nc_region else None
    covers_ids = {crop_ids.canonical(c.crop_id) for c in idx.cover_crops()}
    cash = sorted(c for c, d in table.items() if d.plant and d.harvest and c not in WINTER_GRAINS
                  and c not in covers_ids and not c.endswith("_second"))  # fmt: skip
    if nc:  # NC: only crops the verified catalog knows as cash crops
        cash = [c for c in cash if idx.crop(c) is not None and idx.crop(c).crop_role == "cash_crop"]
    sourced = [c for c in cash if (cal := idx.calendar(c)) is not None
               and not cal.get("extrapolated") and cal.get("source")]  # fmt: skip
    if len(sourced) < MIN_CALENDAR_CROPS:
        return GenerationResult(
            status=Status.INSUFFICIENT_DATA, reason="too_few_crop_calendars",
            reason_text=f"Fewer than {MIN_CALENDAR_CROPS} crops have a sourced planting and harvest "
            "calendar here, so no rotation can be generated without guessing.",
            **{**base, "gaps": [*base["gaps"], "Sourced crop calendars for at least two cash "
               "crops are needed (a regional profile or SAGE)."]},
        )  # fmt: skip

    # --- the crop pool, with the crop constraints
    pool = list(sourced)  # only crops with a sourced calendar are ever generated
    unsourced = [c for c in cash if c not in sourced]
    if unsourced:
        log.add("note", "unsourced_calendars", len(unsourced), "Crops whose calendar has no "
                "source (or is only extrapolated) were not used.", ", ".join(unsourced))  # fmt: skip
    if con.allowed_crops is not None:
        dropped = [c for c in pool if c not in con.allowed_crops]
        pool = [c for c in pool if c in con.allowed_crops]
        if dropped:
            log.add("constraint", "allowed_crops", len(dropped),
                    "Crops not in the allowed list were not used.", ", ".join(dropped))  # fmt: skip
    for c in con.excluded_crops:
        if c in pool:
            pool.remove(c)
            log.add("constraint", "excluded_crops", 1, "Excluded crops were not used.", c)
    missing = [c for c in con.must_include if c not in pool and c not in covers_ids
               and c not in WINTER_GRAINS]  # fmt: skip
    if missing:
        log.add("constraint", "must_include", 0, "A required crop has no calendar here, so no "
                "sequence can include it.", ", ".join(missing))  # fmt: skip
    for e in con.equipment:
        log.add("constraint", f"equipment:{e}", 0, f"No generated option relies on {e[3:]}; "
                "nothing was pruned.")  # fmt: skip
    if con.irrigation != "unknown":
        log.add("constraint", "irrigation", 0, "This catalog has no sourced irrigation need per "
                "crop, so irrigation access does not prune anything.")  # fmt: skip
    if nc:
        log.add("note", "nc_dates", 0, "North Carolina dates are the demo presets' typical "
                "Piedmont dates (assumed); edit them to this field's dates.")  # fmt: skip

    history = [crop_ids.canonical(c) or c for c in fc.crop_history]
    first_prev = [history[-1]] if history else list(pool)
    if history and history[-1] not in table:
        return GenerationResult(status=Status.INSUFFICIENT_DATA, reason="history_crop_no_calendar",
                                reason_text=f"The last crop on the field ({history[-1]}) has no "
                                "harvest calendar here.", **base)  # fmt: skip

    # --- legs per (prev, next), with date constraints applied per leg
    leg_cache: dict[tuple[str, str], list[Option]] = {}

    def legs(prev: str, nxt: str) -> list[Option]:
        if (prev, nxt) in leg_cache:
            return leg_cache[(prev, nxt)]
        harvest, plant = table[prev].harvest, table[nxt].plant
        assert harvest and plant
        opts = [Option(WinterManagement(kind="none"), plant, {}, {}, "no planted cover")]
        opts += _cover_options(idx, prev, nxt, harvest, plant, nc, log, region)
        opts += _double_crop_options(idx, table, prev, nxt, nc)
        kept: list[Option] = []
        for o in opts:
            wc = crop_ids.canonical(o.winter.crop_id)
            tag = f"{prev}>{wc or 'none'}>{nxt}"
            if wc and wc in con.excluded_crops:
                log.add("constraint", "excluded_crops", 1, "Excluded crops were not used.", tag)
                continue
            if wc and con.allowed_crops is not None and wc not in con.allowed_crops:
                log.add("constraint", "allowed_crops", 1, "Crops not in the allowed list (covers "
                        "and winter grains included) were not used.", tag)  # fmt: skip
                continue
            kept.append(o)
        leg_cache[(prev, nxt)] = kept
        return kept

    def date_problem(plans: list[Plan], cals: list[Any]) -> tuple[str, str] | None:
        """``(constraint, text)`` when a dated planting or harvest breaks a date constraint.

        Both limits are read in the calendar year of the date they limit: ``latest_planting``
        06-15 means no planting after 15 June of the year it happens; ``earliest_harvest`` 09-01
        means no harvest before 1 September of its year.
        """
        plantings = [d for c in cals for d in (c.plant, c.grain.plant if c.grain else None) if d]
        harvests = [d for c in cals for d in (c.prev_harvest, c.grain.harvest if c.grain else None)
                    if d]  # fmt: skip
        last = table.get(crop_ids.canonical(plans[-1].next_crop_id) or "")
        if last is not None and last.harvest:
            h = _on_or_after(cals[-1].plant + timedelta(days=MIN_CROP_DAYS), last.harvest)
            harvests.append(h)
        if con.latest_planting:
            for d in plantings:
                if d > _in_year(d.year, con.latest_planting):
                    return "latest_planting", (f"A planting on {d.isoformat()} is after the "
                                               f"latest-planting date ({con.latest_planting}).")  # fmt: skip
        if con.earliest_harvest:
            for d in harvests:
                if d < _in_year(d.year, con.earliest_harvest):
                    return "earliest_harvest", (f"A harvest on {d.isoformat()} is before the "
                                                f"earliest-harvest date ({con.earliest_harvest}).")  # fmt: skip
        return None

    # --- rule checks per leg (cached)
    check_cache: dict[str, CheckResult] = {}

    def check(plan: Plan, year: int) -> CheckResult:
        key = plan.model_dump_json() + str(year)
        if key not in check_cache:
            check_cache[key] = check_plan(plan, idx, year=year)
        return check_cache[key]

    known_rotations: list[tuple[str, tuple[str, ...]]] = []
    if nc:
        for rid, legs_ids in _preset_rotations():
            seq = []
            for lid in legs_ids:
                p = next(x["plan"] for x in _presets() if x["plan"]["plan_id"] == lid)
                seq.append(Plan.model_validate(p))
            known_rotations.append((rid, tuple(_leg_key(p) for p in seq)))
    for r in idx.rotations():
        if isinstance(r, dict) and isinstance(r.get("sequence"), list):
            ids = tuple(crop_ids.canonical(c) or c for c in r["sequence"])
            known_rotations.append((str(r.get("label") or "profile rotation"), ids))

    candidates: list[Candidate] = []
    n_seasons = con.seasons
    total = 0
    for path in product(first_prev, *([pool] * n_seasons)):
        crops_path = list(path)
        if any(c not in table for c in crops_path):
            continue
        for opts in product(*(legs(crops_path[i], crops_path[i + 1]) for i in range(n_seasons))):
            total += 1
            plans: list[Plan] = []
            for i, o in enumerate(opts):
                prev_c, next_c = crops_path[i], crops_path[i + 1]
                prev_harvest = table[prev_c].harvest
                plans.append(Plan(
                    plan_id=f"s{i + 1}", label=f"Season {i + 1}: {_crop_name(idx, prev_c)}, "
                    f"{o.label}, then {_crop_name(idx, next_c)}",
                    previous_crop_id=idx.catalog_id(prev_c) or prev_c, prev_harvest=prev_harvest,
                    winter=o.winter, next_crop_id=idx.catalog_id(next_c) or next_c,
                    next_plant=o.next_plant, region=region,
                    production_system="conventional" if o.winter.kind == "winter_grain" and nc
                    else None,
                ))  # fmt: skip
            all_crops = [crop_ids.canonical(crops_path[0]) or crops_path[0]]
            for p in plans:
                if p.winter.crop_id:
                    all_crops.append(crop_ids.canonical(p.winter.crop_id) or p.winter.crop_id)
                all_crops.append(crop_ids.canonical(p.next_crop_id) or p.next_crop_id)
            tag = " > ".join(all_crops)
            lacking = [c for c in con.must_include if c not in all_crops]
            if lacking:
                log.add("constraint", "must_include", 1, "Sequences without every required crop "
                        "were pruned.", tag)  # fmt: skip
                continue
            chained = chain_years(plans, year0)
            if chained is None:
                log.add("rule", "season_chain", 1, "The seasons' dates cannot follow each other "
                        "(a harvest before its planting, or a crop over a year in the field).",
                        tag)  # fmt: skip
                continue
            years, cals = chained
            problem = date_problem(plans, cals)
            if problem is not None:
                log.add("constraint", problem[0], 1, problem[1], tag)
                continue
            seasons: list[SeasonLeg] = []
            dropped = False
            for i, (p, o) in enumerate(zip(plans, opts, strict=True)):
                res = check(p, years[i])
                if res.status != Status.COMPLETE:
                    why = "; ".join(res.unsupported or [x.message for x in res.issues]) or str(
                        res.status)  # fmt: skip
                    log.add("rule", f"check:{res.status}", 1, f"The checker could not evaluate "
                            f"this season: {why}", tag)  # fmt: skip
                    dropped = True
                    break
                avoid = [r.rule_id for r in res.rules if r.flagged and r.verdict == "avoid"]
                if avoid:
                    for rid in avoid:
                        log.add("rule", rid, 1, f"Rule {rid} says avoid for this season; the "
                                "sequence was dropped.", tag)  # fmt: skip
                    dropped = True
                    break
                if res.chronology_conflicts:
                    log.add("rule", "chronology", 1, "Dates out of order (e.g. seeding before "
                            "harvest) dropped the sequence.", tag)  # fmt: skip
                    dropped = True
                    break
                prev_c = crops_path[i]
                origins = {"prev_harvest": table[prev_c].origin, "next_plant":
                           table[crops_path[i + 1]].origin, **o.origins}  # fmt: skip
                sources = {"prev_harvest": table[prev_c].source or {},
                           "next_plant": table[crops_path[i + 1]].source or {}, **o.sources}  # fmt: skip
                seasons.append(SeasonLeg(
                    season=i + 1, year=years[i], plan=p, origins=origins, sources=sources,
                    flagged=[r.rule_id for r in res.rules if r.flagged],
                    manual_check=[r.rule_id for r in res.rules if r.status == "manual_check"],
                    unknown=[r.rule_id for r in res.rules if r.status == "unknown"],
                ))  # fmt: skip
            if dropped:
                continue
            leg_keys = tuple(_leg_key(s.plan) for s in seasons)
            match = next((rid for rid, keys in known_rotations
                          if keys == leg_keys or keys == tuple(all_crops)), None)  # fmt: skip
            rule_origins = {r.origin for s in seasons for r in check(s.plan, s.year).rules}
            date_origins = {v for s in seasons for v in s.origins.values()}
            cid = _candidate_id(plans)
            for i, s in enumerate(seasons):
                s.plan = s.plan.model_copy(update={"plan_id": f"{cid}_s{i + 1}"})
            candidates.append(Candidate(
                candidate_id=cid,
                label=" → ".join(_crop_name(idx, c) for c in all_crops),
                crops=all_crops, seasons=seasons,
                origins=sorted(date_origins | rule_origins),
                checks_summary={
                    "flagged": sorted({x for s in seasons for x in s.flagged}),
                    "manual_check": sorted({x for s in seasons for x in s.manual_check}),
                    "unknown": len({x for s in seasons for x in s.unknown}),
                    "rules_checked": sum(len(check(s.plan, s.year).rules) for s in seasons),
                },
                matches_rotation=match,
            ))  # fmt: skip

    def order(c: Candidate) -> tuple:
        liked = len(set(c.crops) & set(pref.liked_crops))
        disliked = len(set(c.crops) & set(pref.disliked_crops))
        cash_seq = [crop_ids.canonical(c.seasons[0].plan.previous_crop_id)] + [
            crop_ids.canonical(x.plan.next_crop_id) for x in c.seasons]
        repeats = any(a == b for a, b in zip(cash_seq, cash_seq[1:], strict=False))
        return (c.matches_rotation is None, -liked, disliked, repeats, tuple(c.crops),
                tuple(s.plan.winter.kind for s in c.seasons), c.candidate_id)  # fmt: skip

    candidates.sort(key=order)
    kept_n = len(candidates)
    if kept_n > MAX_CANDIDATES:
        log.add("cap", "max_candidates", kept_n - MAX_CANDIDATES, f"Only the first "
                f"{MAX_CANDIDATES} candidates (in the order above) are returned.")  # fmt: skip
        candidates = candidates[:MAX_CANDIDATES]
    status = Status.COMPLETE if candidates else Status.PARTIAL
    return GenerationResult(
        status=status,
        reason=None if candidates else "all_pruned",
        reason_text=None if candidates else "Every sequence broke a constraint or a rule; see "
        "generation_log.",
        candidates=candidates, generation_log=log.out(), total_generated=total, **base,
    )  # fmt: skip


MIN_CROP_DAYS = 45  # assumed: no crop in these calendars is harvested sooner after planting


def _in_year(year: int, mmdd: str) -> date:
    m, d = int(mmdd[:2]), int(mmdd[3:])
    if (m, d) == (2, 29) and not (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)):
        d = 28
    return date(year, m, d)


def _on_or_after(start: date, mmdd: str) -> date:
    d = _in_year(start.year, mmdd)
    return d if d >= start else _in_year(start.year + 1, mmdd)


def chain_years(plans: list[Plan], start_year: int) -> tuple[list[int], list[Any]] | None:
    """The planting year of each season, chained on real dates, and each season's calendar.

    Season 1 plants in ``start_year``. Each later season takes the first year in which its harvest
    (of the crop the season before planted) comes at least ``MIN_CROP_DAYS`` after that planting;
    a crop more than a year in the field, or a plan with impossible dates, gives ``None``.
    """
    from acre.contracts import InvalidPlanError
    from acre.seasons.align import build_calendar

    years: list[int] = []
    cals: list[Any] = []
    for i, p in enumerate(plans):
        tries = [start_year] if i == 0 else [years[-1], years[-1] + 1, years[-1] + 2]
        chosen = None
        for y in tries:
            try:
                cal = build_calendar(p, y)
            except InvalidPlanError:
                continue
            if i == 0 or cal.prev_harvest >= cals[-1].plant + timedelta(days=MIN_CROP_DAYS):
                chosen = (y, cal)
                break
        if chosen is None:
            return None
        if i > 0 and (chosen[1].prev_harvest - cals[-1].plant).days > 366:
            return None
        years.append(chosen[0])
        cals.append(chosen[1])
    return years, cals


def _leg_key(p: Plan) -> str:
    w = p.winter
    return json.dumps([crop_ids.canonical(p.previous_crop_id), p.prev_harvest, w.kind,
                       crop_ids.canonical(w.crop_id), w.seed, w.terminate, w.plant, w.harvest,
                       crop_ids.canonical(p.next_crop_id), p.next_plant])  # fmt: skip
