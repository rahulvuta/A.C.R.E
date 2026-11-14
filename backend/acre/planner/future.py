"""Future multi-season farm plan (card P3): a chosen rotation laid out on real future dates.

Input: the legs of a rotation (one :class:`Plan` per season, previous crop → off-season → next crop;
a generated candidate's seasons, a preset rotation, or the farmer's own plans), a start season and a
number of seasons. Legs repeat in order when more seasons are asked for than there are legs.

For each season it gives the dated windows (from the plan's MM-DD values on that season's calendar),
the cover schedule, management milestones and checks (the action calendar), decision deadlines (the
backup plan's switch logic and ``next_check_date``), source-backed explanations, warnings, and the
backup strategy. Every date carries an ``origin``: ``grower`` (entered or edited by the farmer),
``assumed`` (demo presets, default spacing), ``dataset_estimate`` (SAGE) or ``verified_source``.

These are planned dates, not a forecast: nothing here says what the weather will be.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from pydantic import BaseModel

from acre.catalogs import crop_ids
from acre.catalogs.index import CatalogIndex
from acre.contracts import FieldIssue, Plan, Status
from acre.planner.backup import build_backup_plan
from acre.planner.calendar import ActionCalendar, build_action_calendar, diff_calendars

DATE_FIELDS = ("prev_harvest", "next_plant", "winter.seed", "winter.terminate", "winter.plant",
               "winter.harvest")  # fmt: skip
EDITABLE = (*DATE_FIELDS, "winter.crop_id")
MAX_SEASONS = 4
NOT_A_FORECAST = ("Planned dates on future calendars, from the plan and its sources. They are not "
                  "a forecast: the weather in these seasons is unknown.")  # fmt: skip


class FuturePlanError(ValueError):
    def __init__(self, issues: list[FieldIssue]):
        super().__init__("; ".join(i.message for i in issues))
        self.issues = issues


class Edit(BaseModel):
    field: str
    season: int | None = None  # 1-based; None = every season whose plan has this field set
    value: Any = None
    shift_days: int | None = None


# --------------------------------------------------------------------------- helpers


def _get(plan: Plan, path: str) -> Any:
    cur: Any = plan
    for part in path.split("."):
        cur = getattr(cur, part)
    return cur


def _set(plan: Plan, path: str, value: Any) -> Plan:
    if path.startswith("winter."):
        w = plan.winter.model_copy(update={path.split(".", 1)[1]: value})
        return Plan.model_validate({**plan.model_dump(), "winter": w.model_dump()})
    return Plan.model_validate({**plan.model_dump(), path: value})


def _md(d: date) -> str:
    return f"{d.month:02d}-{d.day:02d}"


def _shift(mmdd: str, days: int) -> str:
    from acre.planner.generator import _shift as shift

    return shift(mmdd, days)  # 02-29 is a valid input; see generator._shift


def _iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def _same(a: str, b: str) -> bool:
    return (crop_ids.canonical(a) or a) == (crop_ids.canonical(b) or b)


def check_chain(legs: list[Plan], seasons: int) -> list[FieldIssue]:
    """Each season must start with the crop the previous season planted (also when legs repeat)."""
    out: list[FieldIssue] = []
    if not legs:
        return [FieldIssue(field="plan", code="required", message="a plan is required")]
    if not 1 <= seasons <= MAX_SEASONS:
        out.append(FieldIssue(field="seasons", code="invalid_seasons",
                              message=f"seasons must be 1-{MAX_SEASONS}"))  # fmt: skip
        return out
    for i in range(seasons - 1):
        a, b = legs[i % len(legs)], legs[(i + 1) % len(legs)]
        if not _same(a.next_crop_id, b.previous_crop_id):
            out.append(FieldIssue(
                field=f"plans[{(i + 1) % len(legs)}].previous_crop_id", code="season_chain",
                message=f"season {i + 2} starts with {b.previous_crop_id}, but season {i + 1} "
                f"plants {a.next_crop_id}; send the rotation's plan for every season"))  # fmt: skip
            break
    return out


# --------------------------------------------------------------------------- one season


def _origin(origins: dict[str, str], field: str, basis: str) -> str:
    return origins.get(field) or basis


def _rule_origin(index: CatalogIndex, rule_id: str) -> str:
    r = index.rule(rule_id)
    return r.origin if r is not None else "verified_source"


def _windows(leg: Plan, cal: Any, origins: dict[str, str], sources: dict[str, Any], basis: str,
             next_harvest: tuple[date, str] | None, typical: dict[str, Any] | None
             ) -> list[dict[str, Any]]:  # fmt: skip
    def w(kind: str, start: date, end: date | None, field: str | None, label: str,
          origin: str | None = None, source: Any = None) -> dict[str, Any]:  # fmt: skip
        o = origin or _origin(origins, field or "", basis)
        return {"kind": kind, "start": _iso(start), "end": _iso(end or start), "label": label,
                "origin": o, "source": source if source is not None else
                (sources.get(field or "") or None), "field": field}  # fmt: skip

    out = [w("harvest", cal.prev_harvest, None, "prev_harvest", f"Harvest {leg.previous_crop_id}")]
    if cal.cover is not None:
        out.append(w("cover_seed", cal.cover.seed, None, "winter.seed",
                     f"Seed {cal.cover.crop_id}"))  # fmt: skip
        out.append(w("cover_terminate", cal.cover.terminate, None, "winter.terminate",
                     f"Terminate {cal.cover.crop_id}"))  # fmt: skip
    if cal.grain is not None:
        out.append(w("grain_plant", cal.grain.plant, None, "winter.plant",
                     f"Plant {cal.grain.crop_id}"))  # fmt: skip
        out.append(w("grain_harvest", cal.grain.harvest, None, "winter.harvest",
                     f"Harvest {cal.grain.crop_id}"))  # fmt: skip
    out.append(w("plant", cal.plant, None, "next_plant", f"Plant {leg.next_crop_id}"))
    out.append(w("pre_plant_check", cal.spring_start, cal.spring_end, None,
                 "The 30 days before planting (dryness check window)", origin="calculation",
                 source={"title": "30 days before the planting date", "url": None}))  # fmt: skip
    if next_harvest is not None:
        end, origin = next_harvest
        out.append(w("growing_season", cal.plant, end, None, f"{leg.next_crop_id} in the field "
                     "(planting to harvest)", origin=origin))  # fmt: skip
    if typical is not None and isinstance(typical.get("plant"), dict):
        p = typical["plant"]
        s = date(cal.plant.year, int(p["start"][:2]), int(p["start"][3:]))
        e = date(cal.plant.year, int(p["end"][:2]), int(p["end"][3:]))
        if e < s:
            e = date(cal.plant.year + 1, e.month, e.day)
        if s > cal.plant + timedelta(days=183):  # the window that holds this planting
            s, e = date(s.year - 1, s.month, s.day), date(e.year - 1, e.month, e.day)
        out.append(w("typical_planting_window", s, e, None,
                     f"Typical {leg.next_crop_id} planting window for this area",
                     origin=typical.get("origin") or "dataset_estimate",
                     source=typical.get("source")))  # fmt: skip
    return out


def _milestones(cal: ActionCalendar, index: CatalogIndex, origins: dict[str, str], basis: str
                ) -> list[dict[str, Any]]:  # fmt: skip
    field_of = {"harvest": "prev_harvest", "plant": "next_plant"}
    plan_dates: dict[date, str] = {}  # date -> plan field it was copied from
    for a in cal.actions:
        if a.kind in ("harvest", "seed", "terminate", "plant"):
            fld = field_of.get(a.kind) or ("winter.seed" if a.kind == "seed" else "winter.terminate")
            if a.label.startswith("Plant ") and a.kind == "seed":
                fld = "winter.plant"
            if a.label.startswith("Harvest ") and a.kind == "terminate":
                fld = "winter.harvest"
            plan_dates.setdefault(a.date, fld)
    out = []
    for a in cal.actions:
        rule_origin = None
        if a.kind == "check":
            rid = a.evidence[0].rule_id if a.evidence else None
            rule_origin = _rule_origin(index, rid) if rid else None
            # the check's date comes from a plan date (or is computed); the rule has its own origin
            fld_ = plan_dates.get(a.date)
            origin = _origin(origins, fld_, basis) if fld_ else "calculation"
        elif a.kind == "window":
            origin = "calculation"
        else:
            fld = field_of.get(a.kind) or ("winter.seed" if a.kind == "seed" else "winter.terminate")
            if a.label.startswith("Plant ") and a.kind == "seed":
                fld = "winter.plant"
            if a.label.startswith("Harvest ") and a.kind == "terminate":
                fld = "winter.harvest"
            origin = _origin(origins, fld, basis)
        out.append({"date": a.date.isoformat(), "end_date": _iso(a.end_date), "label": a.label,
                    "kind": a.kind, "action_id": a.action_id, "status": str(a.status),
                    "flagged": a.flagged, "origin": origin, "rule_origin": rule_origin,
                    "rule_ids": [e.rule_id for e in a.evidence]})  # fmt: skip
    return out


def _decisions(backup: Any) -> list[dict[str, Any]]:
    if backup.status != Status.COMPLETE or backup.decision_deadline is None:
        return []
    sc = backup.switch_condition
    return [{
        "date": backup.decision_deadline.isoformat(),
        "decision": f"Keep this season's plan or switch to {backup.fallback_plan_id}",
        "switch_condition": sc.text if sc else None,
        "switch_kind": sc.kind if sc else None,
        "rule_ids": list(sc.rule_ids) if sc else [],
        "inputs_needed": list(sc.inputs_needed) if sc else [],
        "next_check_date": _iso(backup.next_check_date),
        "timing": backup.timing,
        "fallback_plan_id": backup.fallback_plan_id,
        "origin": "calculation",
        "assumptions": list(backup.assumptions),
    }]  # fmt: skip


def _season(i: int, year: int, leg: Plan, index: CatalogIndex, origins: dict[str, str],
            sources: dict[str, Any], basis: str, next_harvest: tuple[date, str] | None,
            typical: dict[str, Any] | None, as_of: date | None, inputs: dict | None
            ) -> tuple[dict[str, Any], ActionCalendar, Any]:  # fmt: skip
    cal = build_action_calendar(leg, index, year=year, inputs=inputs)
    if cal.status != Status.COMPLETE or cal.check_result is None:
        return ({"season": str(year), "index": i + 1, "status": str(cal.status),
                 "plan": leg.model_dump(mode="json"), "notes": cal.notes, "windows": [],
                 "milestones": [], "decision_deadlines": [], "warnings": [],
                 "explanations": [], "backup": None, "cover_schedule": None,
                 "historical_vulnerabilities": []}, cal, None)  # fmt: skip
    sc = cal.check_result.calendar
    backup = build_backup_plan(leg, None, index, year=year, as_of=as_of, inputs=inputs)
    rules = cal.check_result.rules
    flagged = [r for r in rules if r.flagged]
    explain = [r for r in rules if r.flagged or r.status == "manual_check"]
    cover = None
    if sc.cover is not None:
        cover = {"crop_id": sc.cover.crop_id, "seed": sc.cover.seed.isoformat(),
                 "terminate": sc.cover.terminate.isoformat(), "living_cover_days": sc.cover.days,
                 "termination_gap_days": sc.termination_gap_days,
                 "establishment": "uncertain",
                 "origin": {"seed": _origin(origins, "winter.seed", basis),
                            "terminate": _origin(origins, "winter.terminate", basis)}}  # fmt: skip
    season = {
        "season": str(year),
        "index": i + 1,
        "status": "complete",
        "plan": leg.model_dump(mode="json"),
        "windows": _windows(leg, sc, origins, sources, basis, next_harvest, typical),
        "cover_schedule": cover,
        "milestones": _milestones(cal, index, origins, basis),
        "decision_deadlines": _decisions(backup),
        "explanations": [{"rule_id": r.rule_id, "text": r.text, "status": str(r.status),
                          "verdict": r.verdict, "origin": r.origin,
                          "source": r.source.model_dump(mode="json")} for r in explain],  # fmt: skip
        "warnings": [{"rule_id": r.rule_id, "text": r.text, "verdict": r.verdict,
                      "origin": r.origin} for r in flagged],  # fmt: skip
        "historical_vulnerabilities": [],
        "backup": backup.model_dump(mode="json", exclude={"comparison"}),
        "notes": list(cal.notes),
    }
    return season, cal, backup


# --------------------------------------------------------------------------- the plan


def _actual(plan: Plan, year: int, field: str) -> date | None:
    """The real date of a plan field when the plan is laid out on planting year ``year``."""
    from acre.seasons.align import build_calendar

    try:
        cal = build_calendar(plan, year)
    except Exception:  # noqa: BLE001 - an impossible plan has no real dates
        return None
    return {"prev_harvest": cal.prev_harvest, "next_plant": cal.plant,
            "winter.seed": cal.cover.seed if cal.cover else None,
            "winter.terminate": cal.cover.terminate if cal.cover else None,
            "winter.plant": cal.grain.plant if cal.grain else None,
            "winter.harvest": cal.grain.harvest if cal.grain else None}.get(field)  # fmt: skip


def apply_edits(legs: list[Plan], origins: list[dict[str, str]], edits: list[Edit],
                years: list[int] | None = None
                ) -> tuple[list[Plan], list[dict[str, str]], list[FieldIssue], dict[str, int]]:  # fmt: skip
    """Edited legs and origins (an edited date is ``grower``), issues, and priority edits."""
    legs = list(legs)
    origins = [dict(o) for o in origins]
    issues: list[FieldIssue] = []
    priorities: dict[str, int] = {}
    for n, e in enumerate(edits):
        where = f"edits[{n}]"
        if e.field.startswith("priorities."):
            from acre.planner.goals import PRIORITY_IDS

            pid = e.field.split(".", 1)[1]
            if pid not in PRIORITY_IDS or not isinstance(e.value, int) or isinstance(e.value, bool) \
                    or not 0 <= e.value <= 3:  # fmt: skip
                issues.append(FieldIssue(field=where, code="invalid_priority",
                                         message="a priority edit needs a known id and a 0-3 "
                                         "weight"))  # fmt: skip
            else:
                priorities[pid] = e.value
            continue
        if e.field not in EDITABLE:
            issues.append(FieldIssue(field=f"{where}.field", code="not_editable",
                                     message=f"editable fields are {list(EDITABLE)} and "
                                     "priorities.<id>"))  # fmt: skip
            continue
        targets = [e.season - 1] if e.season else [
            i for i, p in enumerate(legs) if _get(p, e.field) is not None]
        if e.season is not None and not 0 <= e.season - 1 < len(legs):
            issues.append(FieldIssue(field=f"{where}.season", code="invalid_season",
                                     message=f"season must be 1-{len(legs)}"))  # fmt: skip
            continue
        for t in targets:
            cur = _get(legs[t], e.field)
            if e.field in DATE_FIELDS:
                if e.shift_days is not None:
                    if cur is None:
                        issues.append(FieldIssue(field=where, code="nothing_to_move",
                                                 message=f"season {t + 1} has no {e.field}"))  # fmt: skip
                        continue
                    real = _actual(legs[t], years[t], e.field) if years else None
                    # moved in its real year, so 28 Feb + 1 is 29 Feb in a leap year
                    new = _md(real + timedelta(days=e.shift_days)) if real else _shift(
                        cur, e.shift_days)
                else:
                    new = e.value
            else:
                new = e.value
                if not crop_ids.is_known(new):
                    issues.append(FieldIssue(field=f"{where}.value", code="unknown_crop",
                                             message=f"'{new}' is not a known crop id"))  # fmt: skip
                    continue
            try:
                legs[t] = _set(legs[t], e.field, new)
            except ValueError as exc:
                issues.append(FieldIssue(field=f"{where}.value", code="invalid_value",
                                         message=str(exc).splitlines()[0]))  # fmt: skip
                continue
            origins[t][e.field] = "grower"
    return legs, origins, issues, priorities


def build_future_plan(legs: list[Plan], index: CatalogIndex, *, start_season: int, seasons: int,
                      origins: list[dict[str, str]] | None = None,
                      sources: list[dict[str, Any]] | None = None, basis: str = "grower",
                      calendars: Any = None, as_of: date | None = None,
                      inputs: dict | None = None, follow: Plan | None = None) -> dict[str, Any]:  # fmt: skip
    """The future plan body (without ``meta``). Raises :class:`FuturePlanError` on bad input."""
    issues = check_chain(legs, seasons)
    if issues:
        raise FuturePlanError(issues)
    origins = origins or [{} for _ in legs]
    sources = sources or [{} for _ in legs]
    out_seasons: list[dict[str, Any]] = []
    cals: list[ActionCalendar] = []
    backups: list[Any] = []
    plans = [legs[i % len(legs)] for i in range(seasons)]
    from acre.planner.generator import chain_years

    chained = chain_years(plans, start_season)
    # the season after the last one, if the rotation continues: it holds the last crop's harvest
    follow = follow or legs[seasons % len(legs)]
    tail = (chain_years([*plans, follow], start_season)
            if chained is not None and _same(plans[-1].next_crop_id, follow.previous_crop_id)
            else None)  # fmt: skip
    if chained is None:
        raise FuturePlanError([FieldIssue(
            field="plans", code="season_chain_dates",
            message="the seasons' dates cannot follow each other: a harvest would come before "
            "the planting it follows, or a crop would stay in the field over a year")])  # fmt: skip
    years = chained[0]
    # where each season's crop comes out: the next season's harvest, or the area's typical harvest
    harvests: list[tuple[date, str] | None] = []
    from acre.seasons.align import build_calendar

    for i in range(seasons):
        nxt = None
        if i + 1 < seasons:
            try:
                c = build_calendar(plans[i + 1], years[i + 1])
                nxt = (c.prev_harvest, _origin(origins[(i + 1) % len(legs)], "prev_harvest",
                                                basis))  # fmt: skip
            except Exception:  # noqa: BLE001 - reported on that season
                nxt = None
        elif tail is not None:  # the rotation continues: its next harvest closes this season
            k = next((j for j, leg in enumerate(legs) if leg is follow), None)
            nxt = (tail[1][-1].prev_harvest,
                   _origin(origins[k], "prev_harvest", basis) if k is not None else basis)
        elif calendars is not None:  # the last season: the area's typical harvest, if known
            typ = calendars.calendar(plans[i].next_crop_id)
            h = (typ or {}).get("harvest") or {}
            md = h.get("typical") or h.get("start")
            if md:
                from acre.planner.generator import MIN_CROP_DAYS, _on_or_after

                plant = chained[1][i].plant
                nxt = (_on_or_after(plant + timedelta(days=MIN_CROP_DAYS), md),
                       typ.get("origin") or "dataset_estimate")  # type: ignore[union-attr]
        harvests.append(nxt)
    status = "complete"
    for i, (leg, year) in enumerate(zip(plans, years, strict=True)):
        typical = calendars.calendar(leg.next_crop_id) if calendars is not None else None
        s, cal, backup = _season(i, year, leg, index, origins[i % len(legs)],
                                 sources[i % len(legs)], basis, harvests[i], typical, as_of, inputs)  # fmt: skip
        if s["status"] == "complete" and harvests[i] is None:
            s["notes"].append("The harvest date of this season's crop is not known: send the "
                              "next season's plan or a location for its typical harvest.")
            s["harvest_known"] = False
            s["status"] = "partial"
        if s["status"] != "complete":
            status = "partial"
        out_seasons.append(s)
        cals.append(cal)
        backups.append(backup)
    return {"status": status, "start_season": str(start_season), "seasons": out_seasons,
            "note": NOT_A_FORECAST, "_cals": cals, "_backups": backups, "_plans": plans}  # fmt: skip


def expand(legs: list[Plan], origins: list[dict[str, str]], sources: list[dict[str, Any]],
           seasons: int) -> tuple[list[Plan], list[dict[str, str]], list[dict[str, Any]], Plan]:
    """One leg per season (a repeated leg becomes its own copy, so an edit to season 1 never moves
    season 3), plus the leg that would follow the last season."""
    n = len(legs)
    out = [legs[i % n] for i in range(seasons)]
    return (out, [dict(origins[i % n]) for i in range(seasons)],
            [dict(sources[i % n]) for i in range(seasons)], legs[seasons % n])


def diff_future(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Per-season calendar diffs (the action-calendar diff) plus decision-deadline moves."""
    changes: list[dict[str, Any]] = []
    for i, (bc, ac) in enumerate(zip(before["_cals"], after["_cals"], strict=True)):
        bp, ap = before["_plans"][i], after["_plans"][i]
        if bc.status != Status.COMPLETE or ac.status != Status.COMPLETE:
            if bp != ap:
                changes.append({"season": before["seasons"][i]["season"], "status": "partial",
                                "plan_edits": [], "changes": []})  # fmt: skip
            continue
        d = diff_calendars(bc, ac, bp, ap)
        bd = before["seasons"][i]["decision_deadlines"]
        ad = after["seasons"][i]["decision_deadlines"]
        dl = None
        if bd != ad:
            dl = {"before": bd[0]["date"] if bd else None, "after": ad[0]["date"] if ad else None,
                  "next_check_before": bd[0]["next_check_date"] if bd else None,
                  "next_check_after": ad[0]["next_check_date"] if ad else None}  # fmt: skip
        bw = {w["kind"]: (w["start"], w["end"]) for w in before["seasons"][i]["windows"]}
        aw = {w["kind"]: (w["start"], w["end"]) for w in after["seasons"][i]["windows"]}
        windows = [{"kind": k, "before": bw.get(k), "after": aw.get(k)}
                   for k in sorted(set(bw) | set(aw)) if bw.get(k) != aw.get(k)]  # fmt: skip
        if not d["unchanged"] or dl or windows:
            changes.append({"season": before["seasons"][i]["season"], **d,
                            "decision_deadline": dl, "window_changes": windows})  # fmt: skip
    return {"changes": changes, "unchanged": not changes}


def public(body: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in body.items() if not k.startswith("_")}
