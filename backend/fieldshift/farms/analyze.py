"""Farm and field batch analysis (A3): ``POST /v1/farms/analyze`` (contract §5).

Each field is measured server-side (geodesic area, centroid), grouped by its POWER grid cell, and
gets its own comparison result at its own location. Fields in one cell share one weather series,
and the response says so. Only area is totalled; there is never a metric total across fields.

Privacy: geometry and coordinates are never logged and never echoed. A field comes back as its
``field_id``, name, area and a centroid rounded to 2 decimals (about 1 km).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fieldshift.compare import engine, text
from fieldshift.compare import locations as places
from fieldshift.compare.models import PlanComparison
from fieldshift.contracts import InvalidPlanError, Plan, Status
from fieldshift.farms.geometry import FieldShape, GeometryError, parse_field
from fieldshift.report.http import issue
from fieldshift.weather import ondemand
from fieldshift.weather.power_client import is_offline

SHARED_NOTE = ("These fields share one NASA weather series; differences between them come from "
               "their plans, not their weather.")  # fmt: skip
ONE_FIELD_NOTE = "One NASA POWER weather series covers this whole cell."
CELL_BY_CENTROID = ("A field is assigned to the weather cell that contains its centroid, even when "
                    "its boundary reaches into a neighbouring cell.")  # fmt: skip


@dataclass
class FieldInput:
    index: int
    field_id: str
    name: str | None
    geometry: Any
    plan: Plan
    goals: dict[str, Any] | None = None


@dataclass
class Measured:
    f: FieldInput
    shape: FieldShape
    cell: ondemand.Cell


def validate(fields: list[FieldInput]) -> tuple[list[Measured], list[dict[str, str]]]:
    """Measure every field; collect typed issues naming the field (``farm.fields[i].…``)."""
    out: list[Measured] = []
    issues: list[dict[str, str]] = []
    seen: dict[str, int] = {}
    for f in fields:
        label = f.name or f.field_id
        if f.field_id in seen:
            issues.append(issue(f"farm.fields[{f.index}].field_id", "duplicate_field_id",
                                f"Field id '{f.field_id}' is used twice."))  # fmt: skip
        seen.setdefault(f.field_id, f.index)
        try:
            shape = parse_field(f.geometry)
        except GeometryError as exc:
            msg = (f"Field '{label}' crosses itself; redraw its boundary."
                   if exc.code == "self_intersection" else f"Field '{label}': {exc}.")  # fmt: skip
            issues.append(issue(f"farm.fields[{f.index}].geometry", exc.code, msg))
            continue
        try:
            engine.build_calendar(f.plan, engine.REFERENCE_YEAR)
        except InvalidPlanError as exc:
            issues += [issue(f"farm.fields[{f.index}].plan.{i.field}", i.code,
                             f"Field '{label}': {i.message}") for i in exc.issues]  # fmt: skip
            continue
        out.append(Measured(f, shape, ondemand.Cell.from_point(shape.centroid_lat,
                                                               shape.centroid_lon)))  # fmt: skip
    return out, issues


def _capabilities(lat: float, lon: float) -> dict[str, Any] | None:
    """B1's ``capabilities_for`` features block (``None`` if B1 is unavailable). Never raises."""
    try:
        from fieldshift.geo.capabilities import capabilities_for
    except ImportError:
        return None
    try:
        res = capabilities_for(lat, lon, allow_network=not is_offline())
    except Exception:  # noqa: BLE001 - capabilities are context; never sink an analysis
        return {"status": "unavailable", "reason": "capabilities_failed"}
    return res.get("features") if isinstance(res, dict) else None


def _r2(x: float) -> float:
    return round(x + 0.0, 2) + 0.0


def analyze_farm(
    fields: list[Measured], *, prepare_weather: bool = True, wait_s: float = 0.0,
    include_capabilities: bool = True, recommend: bool = False,
) -> dict[str, Any]:  # fmt: skip
    """The response body without ``meta``. ``fields`` are already validated and measured.
    One stored snapshot per cell is pinned for the whole batch."""
    with ondemand.pinned():
        return _analyze_farm(fields, prepare_weather=prepare_weather, wait_s=wait_s,
                             include_capabilities=include_capabilities, recommend=recommend)


def _analyze_farm(
    fields: list[Measured], *, prepare_weather: bool, wait_s: float,
    include_capabilities: bool, recommend: bool,
) -> dict[str, Any]:  # fmt: skip
    # 1. Weather: one prepare per cell, never per field.
    cells: dict[str, list[Measured]] = {}
    for m in fields:
        cells.setdefault(m.cell.cell_id, []).append(m)
    cell_state: dict[str, ondemand.WeatherState] = {}
    for cid, members in cells.items():
        cell = members[0].cell
        st = ondemand.current(cell)
        if st.job_status != "ready" and prepare_weather and not is_offline():
            st = ondemand.prepare(cell, wait_s=wait_s)
        if st.job_status == "failed" and ondemand.stored(cell) is not None:
            st = ondemand.prepare(cell)  # a failed refresh: the earlier snapshot still serves
        ondemand.repin(cell, st.stored if st.job_status == "ready" else None)
        cell_state[cid] = st

    # 2. One comparison per field at its own location (thresholds frozen per cell and scope).
    out_fields: list[dict[str, Any]] = []
    statuses: list[str] = []
    for m in fields:
        lat, lon = m.shape.centroid_lat, m.shape.centroid_lon
        st = cell_state[m.cell.cell_id]
        # one state per cell for the whole response: a field is analysed only when its cell was
        # ready when the batch started, so a field never says ready while its group is pending
        choice = (places.choose(None, lat, lon) if st.job_status == "ready"
                  else places.Choice("no_snapshot", code=st.reason, reason=st.reason,
                                     cell_id=m.cell.cell_id))  # fmt: skip
        result: PlanComparison | None = None
        job_status = st.job_status if not choice.ok else "ready"
        reason = reason_text = None
        if choice.ok:
            assert choice.ctx is not None
            res, _ts, _shared = engine.compare_plans([m.f.plan], choice.ctx)
            text.finalize(res, {m.f.plan.plan_id: m.f.plan}, choice.ctx.index)
            result = res[0]
            statuses.append(str(result.status))
        else:
            reason = choice.reason if job_status != "pending" else None
            reason_text = text.reason_text(choice.reason) if reason else None
            if job_status == "failed" and st.reason:
                reason, reason_text = st.reason, ondemand.REASONS.get(st.reason)
            statuses.append("pending" if job_status == "pending" else "unavailable")
        entry: dict[str, Any] = {
            "field_id": m.f.field_id,
            "name": m.f.name,
            "area_ha": _r2(m.shape.area_ha),
            "area_ac": _r2(m.shape.area_ac),
            "centroid": {"latitude": _r2(lat), "longitude": _r2(lon)},
            "cell_id": m.cell.cell_id,
            "job_status": job_status,
            "status": str(result.status) if result is not None else (
                "unknown" if job_status == "pending" else "unavailable"),
            "reason": reason,
            "reason_text": reason_text,
            "poll": f"/v1/weather/{m.cell.cell_id}" if job_status == "pending" else None,
            "capabilities": _capabilities(lat, lon) if include_capabilities else None,
            "result": result.model_dump(mode="json") if result is not None else None,
            "snapshot_hash": choice.ctx.snapshot_hash if choice.ok and choice.ctx else None,
            "scope": ("nc" if choice.ctx.is_nc else "global") if choice.ok and choice.ctx
            else None,
        }
        if recommend and m.f.goals is not None and choice.ok and choice.ctx is not None:
            entry["recommendation"] = _recommend(m, choice.ctx)
        out_fields.append(entry)

    # 3. Cells: which fields share one weather series. Area is the only total.
    weather_cells = []
    for cid, members in cells.items():
        st = cell_state[cid]
        weather_cells.append({
            "cell_id": cid,
            "field_ids": [m.f.field_id for m in members],
            "job_status": st.job_status,
            "snapshot_hash": st.snapshot_hash,
            "cell": st.cell.public(),
            "note": SHARED_NOTE if len(members) > 1 else ONE_FIELD_NOTE,
        })  # fmt: skip
    total_ha = sum(m.shape.area_ha for m in fields)
    if all(s == "complete" for s in statuses):
        status = Status.COMPLETE
    elif all(s in ("unavailable", "unsupported") for s in statuses):
        status = Status.UNAVAILABLE
    else:
        status = Status.PARTIAL
    return {
        "status": str(status),
        "fields": out_fields,
        "weather_cells": weather_cells,
        "totals": {"area_ha": _r2(total_ha), "area_ac": _r2(total_ha / 0.40468564224)},
        "notes": [CELL_BY_CENTROID,
                  "Only area is totalled. Results are per field and are never added across "
                  "fields."],  # fmt: skip
    }


def _recommend(m: Measured, ctx: Any) -> dict[str, Any]:
    """P2 per field, when the field carries goals (candidates from P1 or the preset stub)."""
    from fieldshift.compare.recommend import generate, recommend

    goals = m.f.goals or {}
    point = {"latitude": m.shape.centroid_lat, "longitude": m.shape.centroid_lon}  # in-process only
    gen = generate(ctx, point, {"field_id": m.f.field_id, "area_ha": _r2(m.shape.area_ha)}, goals)
    if not gen["candidates"]:
        return {"status": "insufficient_data", "gaps": gen.get("gaps", []), "shortlist": [],
                "generation_log": gen.get("generation_log", [])}  # fmt: skip
    out = recommend(gen["candidates"], ctx, goals.get("priorities") or {}, requested=point)
    return {**out, "generation_log": gen.get("generation_log", []), "gaps": gen.get("gaps", [])}
