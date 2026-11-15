"""Per-season values of one plan leg, computed once per (cell snapshot, thresholds, plan).

Each past season (planting years 1981-2025) of a leg is evaluated with the same winter and spring
metrics P2 reads (``metrics.winter.compute_winter``, ``metrics.spring.compute_spring``) against
ONE frozen ThresholdSet shared by every leg of every scenario. The simulator then only resamples
indices into these arrays, so 200 runs cost no more weather work than one.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np

from acre.compare import engine
from acre.compare.context import Context
from acre.contracts import Plan, Status, ThresholdSet
from acre.weather.series import DailySeries


@dataclass(frozen=True)
class LegSeasons:
    plan: Plan
    years: tuple[int, ...]
    rain_bare_mm: np.ndarray  # float, NaN where the season is not evaluable
    heavy_bare_days: np.ndarray  # float (counts), NaN where not evaluable
    dry: np.ndarray  # float 1.0 / 0.0, NaN where the window is not classified
    gwetroot: np.ndarray  # modeled root-zone wetness, 30 days before planting; NaN when missing
    living_cover_days: int
    operations: int

    def evaluable(self) -> set[int]:
        ok = ~(np.isnan(self.rain_bare_mm) | np.isnan(self.heavy_bare_days) | np.isnan(self.dry))
        return {y for y, good in zip(self.years, ok, strict=True) if good}


def plan_key(p: Plan) -> str:
    return hashlib.sha256(json.dumps(p.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()


def operations(plan: Plan) -> int:
    """The P2 ``management_operations`` count for one season."""
    return 4 if plan.winter.kind in ("cover", "winter_grain") else 2


_CACHE: OrderedDict[tuple[str, ...], LegSeasons] = OrderedDict()
_CACHE_MAX = 512
_LOCK = threading.Lock()


def _compute(plan: Plan, ctx: Context, ts: ThresholdSet,
             adjusted: DailySeries | None = None) -> LegSeasons:
    ref = engine.reference_for(ctx, plan.next_plant)
    series = ctx.series
    if adjusted is not None:  # judged against the unadjusted record's cutoffs and thresholds
        series = adjusted
        ref = ref.model_copy(update={"series_fingerprint": adjusted.fingerprint})
    years = tuple(engine.YEARS)
    rain, heavy, dry, wet = [], [], [], []
    cover = None
    for y in years:
        cal = engine.build_calendar(plan, y)
        w = engine.compute_winter(plan, cal, series, ts, ctx.snapshot_hash)
        s = engine.compute_spring(plan, cal, series, ts, ctx.snapshot_hash, ref)
        ok_w = w.status == Status.COMPLETE and w.rain_outside_cover_mm is not None
        rain.append(w.rain_outside_cover_mm if ok_w else np.nan)
        hv = w.heavy_rain_days_outside_cover
        heavy.append(float(hv) if ok_w and hv is not None else np.nan)
        dry.append(np.nan if s.is_dry is None else float(s.is_dry))
        gw = s.wetness.gwetroot if s.wetness is not None else None
        wet.append(np.nan if gw is None else float(gw))
        if cover is None and w.living_cover_days is not None:
            cover = w.living_cover_days
    if cover is None:  # every season incomplete: the planned interval still has a length
        cover = engine._calendar_summary(plan).living_cover_days_planned
    return LegSeasons(plan, years, np.array(rain, float), np.array(heavy, float),
                      np.array(dry, float), np.array(wet, float), int(cover or 0),
                      operations(plan))  # fmt: skip


def leg_seasons(plan: Plan, ctx: Context, ts: ThresholdSet,
                adjusted: DailySeries | None = None) -> LegSeasons:
    cat = ctx.index.catalog
    key = (ctx.snapshot_hash, ctx.scope, str(ctx.cell_id), ts.threshold_set_id,
           f"{cat.version}:{cat.manifest.content_hash}", plan_key(plan),
           adjusted.fingerprint if adjusted is not None else "")  # fmt: skip
    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit
        # Concurrent views of a field share this calculation, including its first run.
        leg = _compute(plan, ctx, ts, adjusted)
        _CACHE[key] = leg
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
        return leg


def clear_cache() -> None:
    with _LOCK:
        _CACHE.clear()
