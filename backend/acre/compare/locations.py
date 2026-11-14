"""Pick the weather snapshot a request is answered from (owner: Agent A).

A request names a place by ``location_id`` (an id from ``data/snapshots/index.json``) or by a
latitude/longitude. The result is one of:

* ``ok``           the place's snapshot is used; its own frozen thresholds follow from it;
* ``unsupported``  the point is outside North Carolina (``unsupported_location``, as before);
* ``no_snapshot``  the point is in North Carolina but its POWER grid cell has no committed
                   snapshot (``no_weather_snapshot``, status ``unavailable``);
* ``invalid``      an unknown ``location_id``, a non-finite point, or an id and a point that
                   disagree (HTTP 400 ``invalid_input``).

A request with no place uses the Union County default, exactly as before. Locations are never
mixed: one request, one snapshot, one ``ThresholdSet``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

from acre.compare.context import Context, context_for, get_context
from acre.compare.models import WeatherLocation
from acre.contracts import Status
from acre.weather.locations import LocationEntry, cell_id_for, get_index

NO_SNAPSHOT = "no_weather_snapshot"
UNSUPPORTED = "unsupported_location"
NOT_PREPARED = "weather_not_prepared"
OFFLINE_NO_SNAPSHOT = "offline_no_snapshot"

Kind = Literal["ok", "unsupported", "no_snapshot", "invalid"]


@dataclass(frozen=True)
class Choice:
    kind: Kind
    ctx: Context | None = None
    entry: LocationEntry | None = None
    requested: dict[str, Any] | None = None  # {location_id, latitude, longitude} as given
    code: str | None = None
    reason: str | None = None  # "<code>: <detail>" for statuses; plain message for invalid
    issues: list[dict[str, str]] = field(default_factory=list)
    cell_id: str | None = None

    @property
    def ok(self) -> bool:
        return self.kind == "ok"


def _issue(field_: str, code: str, message: str) -> dict[str, str]:
    return {"field": field_, "code": code, "message": message}


def hemisphere_of(latitude: float) -> str:
    """``south`` below the equator, else ``north`` (a point on the equator counts as north)."""
    return "south" if latitude < 0 else "north"


def _cell_entry(cell_id: str, directory: Any, snapshot_hash: str, region: str) -> LocationEntry:
    """An index-like row for a cell served outside the NC place table (A1 cache or a committed
    cell used for a point outside NC). Its name is the cell, never a county."""
    import json as _json

    from acre.weather.snapshot import MANIFEST_NAME
    from acre.weather.sources import derive_grid_cell

    manifest = _json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
    cov = manifest["coverage"]
    lat, lon = (float(x) for x in cell_id.removeprefix("cell_").split("_"))
    return LocationEntry(
        id=cell_id, name=f"POWER grid cell {cell_id}", latitude=lat, longitude=lon,
        region=region, cell_id=cell_id, grid_cell=derive_grid_cell(lat, lon),
        snapshot_dir=str(directory), snapshot_hash=snapshot_hash,
        first_date=cov["first_date"], last_date=cov["last_date"], shares_snapshot_with=None,
    )  # fmt: skip


def _global_choice(cell_id: str, lat: float, lon: float, in_nc: bool,
                   requested: dict[str, Any]) -> Choice | None:  # fmt: skip
    """A cell outside the NC place table: the committed snapshot of its cell (a point outside NC
    in a committed cell) or the on-demand cache. ``None`` when nothing is stored."""
    from acre.compare.context import context_for_cell
    from acre.compare.regional import catalog_for
    from acre.weather import ondemand

    cell = ondemand.Cell.parse(cell_id)
    stored = ondemand.stored(cell)
    if stored is None:
        return None
    region = "outside_nc"
    if in_nc:
        from acre.field.location import approximate_region

        region = approximate_region(lat, lon) or "unknown"
    entry = _cell_entry(cell_id, stored.directory, stored.snapshot_hash, region)
    index, state = catalog_for(lat, lon, in_nc=in_nc)
    ctx = context_for_cell(entry, scope="nc" if in_nc else "global",
                           hemisphere=hemisphere_of(lat), index=index,
                           catalog_state=state)  # fmt: skip
    return Choice("ok", ctx=ctx, entry=entry, requested=requested, cell_id=cell_id)


def choose(
    location_id: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    cell_id: str | None = None,
) -> Choice:
    """Resolve a place. Never raises; the result says what to return.

    Order: a ``location_id`` from the index; a point in North Carolina whose cell has a committed
    snapshot (unchanged NC behaviour); otherwise the cell's stored weather (A1: committed cell or
    cache) with the scope of the point (NC rules only in NC). Nothing stored is ``no_snapshot``:
    ``no_weather_snapshot`` in NC (as before), ``weather_not_prepared`` (or
    ``offline_no_snapshot``) elsewhere. ``cell_id`` stands in for a point at the cell centre.
    """
    requested = {"location_id": location_id, "latitude": latitude, "longitude": longitude}
    if cell_id is not None:
        requested["cell_id"] = cell_id
        if latitude is not None or longitude is not None:
            return Choice("invalid", requested=requested, issues=[_issue(
                "location", "location_conflict", "give a point or a cell_id, not both")])  # fmt: skip
        from acre.weather.ondemand import Cell, CellIdError

        try:
            cell = Cell.parse(cell_id)
        except CellIdError as exc:
            return Choice("invalid", requested=requested,
                          issues=[_issue("location.cell_id", "invalid_cell", str(exc))])  # fmt: skip
        latitude, longitude = cell.center_latitude, cell.center_longitude
    index = get_index()
    have_point = latitude is not None and longitude is not None
    if (latitude is None) != (longitude is None):
        return Choice(
            "invalid", requested=requested,
            issues=[_issue("location", "incomplete_point", "give both latitude and longitude")],
        )  # fmt: skip
    if have_point:
        assert latitude is not None and longitude is not None
        if not (math.isfinite(latitude) and math.isfinite(longitude)
                and -90 <= latitude <= 90 and -180 <= longitude <= 180):  # fmt: skip
            return Choice("invalid", requested=requested, issues=[_issue(
                "location", "invalid_point",
                "latitude must be within [-90, 90] and longitude within [-180, 180]")])  # fmt: skip
    from acre.field.location import in_nc_bounds

    entry_by_id = None
    if location_id:
        entry_by_id = index.by_id(location_id)
        if entry_by_id is None:
            known = ", ".join(e.id for e in index.entries)
            return Choice("invalid", requested=requested, issues=[_issue(
                "location_id", "unknown_location",
                f"unknown location '{location_id}'; known locations: {known}")])  # fmt: skip
    if not have_point:
        if entry_by_id is not None:
            return Choice("ok", ctx=context_for(entry_by_id), entry=entry_by_id,
                          requested=requested, cell_id=entry_by_id.cell_id)  # fmt: skip
        return Choice("ok", ctx=get_context(), entry=None, requested=requested)
    assert latitude is not None and longitude is not None
    cid = cell_id_for(latitude, longitude)
    in_nc = in_nc_bounds(latitude, longitude)
    if entry_by_id is not None and (cid != entry_by_id.cell_id or not in_nc):
        if not in_nc:
            return Choice(
                "unsupported", requested=requested, code=UNSUPPORTED, cell_id=cid,
                reason=f"{UNSUPPORTED}: the point is outside North Carolina, so it cannot use "
                f"{entry_by_id.name}'s place; send the point without location_id",
            )  # fmt: skip
        return Choice("invalid", requested=requested, issues=[_issue(
            "location", "location_conflict",
            f"the point is not in {entry_by_id.name}'s grid cell; give location_id or a "
            "point, not both")])  # fmt: skip
    if entry_by_id is not None:
        return Choice("ok", ctx=context_for(entry_by_id), entry=entry_by_id,
                      requested=requested, cell_id=entry_by_id.cell_id)  # fmt: skip
    entry = index.by_cell(cid)
    if in_nc and entry is not None:
        return Choice("ok", ctx=context_for(entry), entry=entry, requested=requested, cell_id=cid)
    found = _global_choice(cid, latitude, longitude, in_nc, requested)
    if found is not None:
        return found
    if in_nc:
        return Choice(
            "no_snapshot", requested=requested, code=NO_SNAPSHOT, cell_id=cid,
            reason=f"{NO_SNAPSHOT}: no committed weather snapshot for grid cell {cid}",
        )  # fmt: skip
    from acre.weather.power_client import is_offline

    code = OFFLINE_NO_SNAPSHOT if is_offline() else NOT_PREPARED
    return Choice(
        "no_snapshot", requested=requested, code=code, cell_id=cid,
        reason=f"{code}: no stored weather for grid cell {cid}; prepare it with "
        "POST /v1/weather/prepare",
    )  # fmt: skip


def thresholds_sentence(entry: LocationEntry | None, ctx: Context) -> str:
    place = entry or ctx.place
    name = place.name if place else "this location"
    cov = ctx.manifest["coverage"]
    if not ctx.is_nc:
        return (
            f"Dry-spring cutoffs come from {name}'s own {cov['first_date'][:4]}-"
            f"{cov['last_date'][:4]} weather baseline (snapshot {ctx.snapshot_hash[:12]}); heavy "
            "rain is this cell's own 95th percentile of wet days over 1981-2010 (ETCCDI R95p). "
            "Thresholds are never shared across locations."
        )
    return (
        f"Dry-spring cutoffs come from {name}'s own {cov['first_date'][:4]}-"
        f"{cov['last_date'][:4]} weather baseline (snapshot {ctx.snapshot_hash[:12]}); heavy rain "
        "is the fixed 76.2 mm daily value. Thresholds are never shared across locations."
    )


def weather_location(choice: Choice, reason_text: str | None = None) -> WeatherLocation:
    """The block a response carries for this choice."""
    req = choice.requested or {}
    requested_point = (
        {"latitude": req["latitude"], "longitude": req["longitude"]}
        if req.get("latitude") is not None and req.get("longitude") is not None
        else None
    )
    if choice.ok:
        assert choice.ctx is not None
        e = choice.entry or choice.ctx.place
        assert e is not None
        return WeatherLocation(
            status=Status.COMPLETE,
            id=e.id,
            name=e.name,
            region=e.region,
            region_basis=(
                "county table: the place's region as listed in the snapshot index"
                if e.id != e.cell_id
                else "grid cell outside the county table: approximate NC region from the point, "
                "or outside_nc"
            ),
            point={"latitude": e.latitude, "longitude": e.longitude},
            requested_point=requested_point,
            grid_cell={k: e.grid_cell[k] for k in ("center_latitude", "center_longitude")},
            cell_id=e.cell_id,
            snapshot_hash=choice.ctx.snapshot_hash,
            first_date=e.first_date,
            last_date=e.last_date,
            shares_snapshot_with=e.shares_snapshot_with,
            thresholds_from=thresholds_sentence(e, choice.ctx),
        )
    status = Status.UNSUPPORTED if choice.kind == "unsupported" else Status.UNAVAILABLE
    return WeatherLocation(
        status=status,
        code=choice.code,
        reason=choice.reason,
        reason_text=reason_text,
        requested_point=requested_point,
        cell_id=choice.cell_id,
        thresholds_from=(
            "No plan was evaluated for this place. The thresholds shown only keep the response "
            "shape; they are Union County's and apply to nothing here."
        ),
    )


REGION_NAMES = {"piedmont": "the Piedmont", "coastal_plain": "the Coastal Plain"}


def add_region_notes(results: list[Any], entry: LocationEntry, samples: dict[str, Any]) -> None:
    """Label plans whose assumptions are for a different region than the place.

    The sample plans' dates are Piedmont-based assumptions. They are kept, but at a place in
    another region the plan says so (``dates_assumed_for_region`` and ``region_note``). A plan whose
    own ``region`` maps to another region than the place is told that its guidance follows the
    plan's region. Nothing here changes a plan or its rule applicability (that is
    ``acre/field/regions.py``, owned by B).
    """
    from acre.field.regions import normalize_field_region

    place_region = REGION_NAMES.get(entry.region, entry.region)
    for r in results:
        notes: list[str] = []
        sample = samples.get(r.plan_id)
        if (
            entry.region != "piedmont"
            and r.dates_assumed
            and sample is not None
            and sample.plan == r.plan
        ):
            r.dates_assumed_for_region = "piedmont"
            notes.append(
                f"These dates were assumed for the Piedmont; {entry.name} is in {place_region}, "
                "so check them against local timing."
            )
        tag = normalize_field_region(r.plan.region) if r.plan is not None else None
        if tag is not None and tag != entry.region:
            notes.append(
                f"This plan's region is {r.plan.region}, so that region's guidance applies; "
                f"{entry.name} is in {place_region}."
            )
        r.region_note = " ".join(notes) or None
