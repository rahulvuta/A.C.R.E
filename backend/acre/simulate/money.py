"""Money inputs for the simulator (S2; contract §11, §12; simulator.md rule 2-3).

Each crop's price, yield and costs are, in order: the farmer's own value (``grower``), then a
sourced regional reference from Agent B's economics library (``acre.economics.estimate_economics``,
S3) when it is installed, else blank. Blank crops get no money result; nothing is invented.

Weather turns into money only through the farmer's own loss assumption ("in a dry spring I lose
about N% of yield"), applied only in simulated years where that event happened and flagged
``includes_assumption``. There is no yield model.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from acre.economics.estimate import _qty_factor

HA_PER_AC = 0.40468564224
log = logging.getLogger(__name__)

AREA_UNITS = {"acre": "acre", "ac": "acre", "acres": "acre", "ha": "ha", "hectare": "ha"}
LOSS_KEYS = ("dry_spring_pct", "heavy_rain_pct")


@dataclass
class CropMoney:
    crop_id: str
    status: str = "unavailable"
    currency: str | None = None
    price: float | None = None
    price_low: float | None = None
    price_high: float | None = None
    yield_per_area: float | None = None
    cost_per_area: float | None = None
    area_unit: str | None = None  # "acre" | "ha": the denominator of yield and costs
    origins: dict[str, str | None] = field(default_factory=dict)
    gaps: list[dict[str, str]] = field(default_factory=list)

    @property
    def revenue_ok(self) -> bool:
        return self.price is not None and self.yield_per_area is not None

    def public(self) -> dict[str, Any]:
        return {"crop_id": self.crop_id, "status": self.status, "currency": self.currency,
                "price": {"low": self.price_low, "typical": self.price, "high": self.price_high,
                          "origin": self.origins.get("price")},
                "yield_per_area": {"value": self.yield_per_area, "area_unit": self.area_unit,
                                   "origin": self.origins.get("yield")},
                "costs_per_area": {"value": self.cost_per_area, "area_unit": self.area_unit,
                                   "origin": self.origins.get("costs")}}  # fmt: skip


def _split(unit: Any) -> tuple[str, str] | None:
    """``"USD/bu"`` -> ``("USD", "bu")``."""
    if not isinstance(unit, str) or unit.count("/") != 1:
        return None
    a, b = (x.strip() for x in unit.split("/"))
    return (a, b) if a and b else None


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return float(v) if v == v and v >= 0 else None


def _from_record(crop_id: str, price: dict | None, yld: dict | None, costs: dict | None,
                 origins: dict[str, str | None]) -> CropMoney:  # fmt: skip
    """One crop from §12-shaped pieces. Units must line up: price ``CUR/x``, yield ``x/area``,
    costs ``CUR/area`` with the same area unit."""
    m = CropMoney(crop_id, origins=origins)
    p_val = _num((price or {}).get("typical", (price or {}).get("value")))
    p_unit = _split((price or {}).get("unit"))
    y_val = _num((yld or {}).get("value"))
    y_unit = _split((yld or {}).get("unit"))
    c_raw = _cost_total(costs)
    c_val = _num((c_raw or {}).get("value"))
    c_unit = _split((c_raw or {}).get("unit"))
    yield_basis = (yld or {}).get("area_basis")
    cost_basis = (c_raw or {}).get("area_basis")
    if (yield_basis in {"harvested", "planted"} and cost_basis in {"harvested", "planted"}
            and yield_basis != cost_basis):
        m.gaps.append({"crop_id": crop_id, "field": "costs", "reason": "area_basis_mismatch",
                       "text": f"{crop_id}: yield is per {yield_basis} area and costs per "
                               f"{cost_basis} area; enter your own matching inputs."})
        c_val = None
    for name, val in (("price", p_val), ("yield", y_val), ("costs", c_val)):
        if val is None:
            m.gaps.append({"crop_id": crop_id, "field": name, "reason": "no_value",
                           "text": f"No {name} for {crop_id} yet. Add your own to get a money result."})  # fmt: skip
    area = AREA_UNITS.get(y_unit[1].lower()) if y_unit else None
    c_area = AREA_UNITS.get(c_unit[1].lower()) if c_unit else None
    quantity_factor = _qty_factor(y_unit[0], p_unit[1]) if y_unit and p_unit else None
    if y_val is not None and p_val is not None and (quantity_factor is None or area is None):
        m.gaps.append({"crop_id": crop_id, "field": "units", "reason": "unit_mismatch",
                       "text": f"{crop_id}: price and yield units do not match (e.g. USD/bu with "
                               "bu/acre)."})  # fmt: skip
        y_val = None
    elif y_val is not None and quantity_factor is not None:
        y_val *= quantity_factor
    if c_val is not None and c_area is None:
        m.gaps.append({"crop_id": crop_id, "field": "costs", "reason": "unit_mismatch",
                       "text": f"{crop_id}: costs need a per-area unit (USD/acre or USD/ha)."})
        c_val = None
    cur = p_unit[0] if p_unit else (c_unit[0] if c_unit else None)
    if c_unit and p_unit and c_unit[0] != p_unit[0]:
        m.gaps.append({"crop_id": crop_id, "field": "costs", "reason": "currency_mismatch",
                       "text": f"{crop_id}: price and costs are in different currencies."})
        c_val = None
    m.currency = cur
    m.price, m.yield_per_area = p_val, y_val
    m.price_low = _num((price or {}).get("low")) if p_val is not None else None
    m.price_high = _num((price or {}).get("high")) if p_val is not None else None
    # one area unit per crop: costs are converted when they use the other unit
    m.area_unit = area or c_area
    if c_val is not None and m.area_unit and c_area != m.area_unit:
        c_val = c_val / HA_PER_AC if c_area == "acre" else c_val * HA_PER_AC  # per acre -> per ha
    m.cost_per_area = c_val
    if m.revenue_ok and c_val is not None:
        m.status = "complete"
    elif m.revenue_ok or c_val is not None:
        m.status = "partial"
    return m


def _cost_total(costs: Any) -> dict[str, Any] | None:
    """A per-area cost total from any accepted shape: ``{value, unit}`` (simulate), ``{total:
    {value, unit}}`` (§12 override), ``{items, total_per_area}`` (§12 answer) or a list of items
    in one unit."""
    if isinstance(costs, list):
        units = {it.get("unit") for it in costs if isinstance(it, dict)}
        vals = [_num(it.get("value")) for it in costs if isinstance(it, dict)]
        if len(units) != 1 or not vals or any(v is None for v in vals):
            return None
        return {"value": sum(v for v in vals if v is not None), "unit": units.pop()}
    if not isinstance(costs, dict):
        return None
    if "total_per_area" in costs:
        return costs["total_per_area"]
    if isinstance(costs.get("total"), dict):
        return costs["total"]
    return costs


def _cost_origin(costs: Any) -> str | None:
    items = costs.get("items") if isinstance(costs, dict) else costs
    if isinstance(items, list):
        origins = {it.get("origin") for it in items if isinstance(it, dict)}
        return origins.pop() if len(origins) == 1 else ("calculation" if origins else None)
    return None


class MoneyInputError(ValueError):
    def __init__(self, field: str, code: str, message: str) -> None:
        super().__init__(message)
        self.field, self.code = field, code


def _to_library_overrides(overrides: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for crop, ov in overrides.items():
        o = dict(ov)
        c = o.get("costs")
        if isinstance(c, dict) and "value" in c and "total" not in c:
            o["costs"] = {"total": c}
        out[crop] = o
    return out


def _library(location: dict[str, Any], crops: list[str], area_ha: float | None,
             equipment: list[str], overrides: dict[str, Any]) -> dict[str, Any] | None:  # fmt: skip
    """B's S3 library (``estimate_economics``): it resolves the farmer's own value first, then
    sourced references. ``None`` when it is not installed or fails unexpectedly."""
    try:
        from acre.economics.estimate import EconomicsInputError, estimate_economics
    except ImportError:
        return None
    try:
        return estimate_economics(location=location or None, crops=crops,
                                  area={"value": area_ha, "unit": "ha"} if area_ha else None,
                                  equipment=equipment, overrides=_to_library_overrides(overrides))  # fmt: skip
    except EconomicsInputError as exc:
        raise MoneyInputError(getattr(exc, "field", "economics"), getattr(exc, "code", "invalid"),
                              str(exc)) from exc  # fmt: skip
    except Exception as exc:  # noqa: BLE001
        log.warning("economics library failed: %s", type(exc).__name__)
        return None


def _canonical(crop_id: str) -> str:
    from acre.catalogs import crop_ids

    return crop_ids.canonical(crop_id) or crop_id


def crop_money(location: dict[str, Any], crops: list[str], area_ha: float | None,
               equipment: list[str], overrides: dict[str, Any]) -> tuple[dict[str, CropMoney], str]:  # fmt: skip
    """``{crop_id: CropMoney}`` and the source in use: ``"economics_library"`` (B's S3 records:
    the farmer's values, then sourced references) or ``"grower_only"`` (only the farmer's)."""
    lib = _library(location, crops, area_ha, equipment, overrides)
    out: dict[str, CropMoney] = {}
    if lib is not None:
        rows = {r.get("crop_id"): r for r in lib.get("crops", []) if isinstance(r, dict)}
        for c in crops:
            row = rows.get(c) or rows.get(_canonical(c)) or {}
            price, yld, costs = row.get("price"), row.get("yield"), row.get("costs")
            m = _from_record(c, price, yld, costs, {
                "price": (price or {}).get("origin"), "yield": (yld or {}).get("origin"),
                "costs": _cost_origin(costs)})  # fmt: skip
            if (price or {}).get("low") == (price or {}).get("high"):
                m.price_low = m.price_high = None  # a single value has no range
            out[c] = m
        return out, "economics_library"
    for c in crops:
        ov = overrides.get(c) if isinstance(overrides.get(c), dict) else {}
        out[c] = _from_record(c, ov.get("price"), ov.get("yield"), ov.get("costs"), {
            "price": "grower" if ov.get("price") else None,
            "yield": "grower" if ov.get("yield") else None,
            "costs": "grower" if ov.get("costs") else None})  # fmt: skip
    return out, "grower_only"


def area_in(unit: str, area_ha: float) -> float:
    return area_ha if unit == "ha" else area_ha / HA_PER_AC
