"""Weather on demand (A1): ``POST /v1/weather/prepare`` and ``GET /v1/weather/{cell_id}``.

A point is turned into its POWER grid cell at once; only the cell id is used after that, and no
coordinate is logged or echoed (the response gives the cell centre, a grid value).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from acre.compare.models import Meta
from acre.contracts import Status
from acre.report.http import issue
from acre.report.meta import response_meta
from acre.weather import ondemand

router = APIRouter(prefix="/v1/weather", tags=["weather"])


class WeatherLocationIn(BaseModel):
    """A point (``latitude``/``longitude``) or a POWER ``cell_id``; exactly one of the two."""

    model_config = ConfigDict(extra="forbid")
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    cell_id: str | None = None


class PrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location: WeatherLocationIn
    # the only way to re-fetch a cached cell; a refresh writes a new snapshot, never over the old
    refresh: bool = False
    # block up to this many seconds for a fetch to finish (0 = return `pending` at once)
    wait_s: float = Field(default=0.0, ge=0, le=120)


class CellOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    center: dict[str, float]
    size_deg: list[float]
    note: str


class CoverageOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_date: str
    last_date: str
    complete_years: int
    complete_pre_plant_windows: int | None
    complete_off_seasons: int | None
    missing_days: dict[str, int]
    status: Status
    basis: str


class WeatherCellResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    meta: Meta
    cell_id: str
    job_status: Literal["pending", "ready", "failed"]
    status: Status
    reason: str | None
    reason_text: str | None
    source: Literal["committed", "cache", "fetched"] | None
    snapshot_hash: str | None
    retrieved_at: str | None
    cell: CellOut
    coverage: CoverageOut | None
    poll: str | None
    notes: list[str]


def _bad(field: str, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"status": "invalid_input", "issues": [issue(field, code, message)],
                 **{**response_meta(), "snapshot_hash": None}},
    )  # fmt: skip


def _body(state: ondemand.WeatherState) -> dict[str, Any]:
    return {"meta": {**response_meta(), "snapshot_hash": state.snapshot_hash}, **state.public()}


def _cell_from(loc: WeatherLocationIn) -> ondemand.Cell | JSONResponse:
    has_point = loc.latitude is not None or loc.longitude is not None
    if has_point and loc.cell_id is not None:
        return _bad("location", "location_conflict", "give a point or a cell_id, not both")
    try:
        if loc.cell_id is not None:
            return ondemand.Cell.parse(loc.cell_id)
        if loc.latitude is None or loc.longitude is None:
            return _bad("location", "incomplete_point", "give both latitude and longitude, or a "
                        "cell_id")  # fmt: skip
        return ondemand.Cell.from_point(loc.latitude, loc.longitude)
    except ondemand.CellIdError as exc:
        return _bad("location.cell_id" if loc.cell_id is not None else "location",
                    "invalid_cell", str(exc))  # fmt: skip


@router.post("/prepare", response_model=WeatherCellResponse)
def prepare_weather(req: PrepareRequest) -> Any:
    """Committed snapshot, then the cache, then a POWER fetch of the cell (a background job)."""
    cell = _cell_from(req.location)
    if isinstance(cell, JSONResponse):
        return cell
    return _body(ondemand.prepare(cell, refresh=req.refresh, wait_s=req.wait_s))


@router.get("/{cell_id}", response_model=WeatherCellResponse)
def get_weather(cell_id: str) -> Any:
    """The state of one cell. Never starts a fetch."""
    try:
        cell = ondemand.Cell.parse(cell_id)
    except ondemand.CellIdError as exc:
        return _bad("cell_id", "invalid_cell", str(exc))
    return _body(ondemand.current(cell))
