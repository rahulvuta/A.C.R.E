"""Per-crop money inputs for a location (card S3, contract §12).

For each value the order is: the farmer's override (``grower``), then a sourced regional reference
for the location's own region (``verified_source`` or ``dataset_estimate``; most specific region
first: admin1, then country), then a researched reference whose quote code found on a page of an
allowed official source (``source_checked``; same region order), then ``null`` with a reason. No
number is ever invented, and no other region's number is borrowed. A researched reference that is
only ``ai_suggested`` is never a value: it is returned as a ``suggestion`` the farmer may adopt, and
then it comes back as an ordinary ``grower`` override.

* Prices come in low, typical and high cases from the source's historical range.
* Units: in the US, acre, bu, lb and USD; elsewhere ha, t and the source's currency (USD when the
  source gives USD). Only exact conversions are made (area, and mass to mass). Bushels are never
  turned into tonnes, because that needs a test weight. When the units don't line up, the margin
  is ``null`` with a reason.
* Equipment pass costs (custom rates) are listed on their own. They are not added to the crop
  margin, because cost-and-return budgets already include machinery.
* Totals for the area are per crop. Different crops, sources or currencies are never summed.
"""

from __future__ import annotations

import logging
import math
import statistics
from typing import Any
from urllib.parse import urlparse

from acre.catalogs import crop_ids
from acre.economics import data
from acre.field.equipment import valid_equipment
from acre.research import client

log = logging.getLogger(__name__)
PRICE_YEARS = 5  # a researched price range uses the most recent years of one unit and source
MAX_SUGGESTIONS = 6
ACRES_PER_HA = 2.4710538146716534
MASS_KG = {"t": 1000.0, "kg": 1.0, "lb": 0.45359237, "cwt": 45.359237}
AREAS = {"acre": 1.0, "ha": ACRES_PER_HA}  # in acres
CASES = ("low", "typical", "high")
LOSS_KEYS = ("dry_spring_pct", "wet_spring_pct", "heavy_rain_pct")
PASS_NOTE = ("Pass costs are custom-hire rates, listed for reference. They are not added to the "
             "crop margin, because cost-and-return budgets already include machinery.")  # fmt: skip


class EconomicsInputError(ValueError):
    def __init__(self, field: str, code: str, message: str):
        super().__init__(message)
        self.field, self.code = field, code


# --------------------------------------------------------------------------- units


def _split(unit: str | None) -> tuple[str, str] | None:
    if not isinstance(unit, str) or "/" not in unit:
        return None
    a, b = unit.split("/", 1)
    return (a.strip(), b.strip()) if a.strip() and b.strip() else None


def _area_factor(src: str, dst: str) -> float | None:
    """Multiply a per-``src``-area value by this to get it per ``dst`` area."""
    if src not in AREAS or dst not in AREAS:
        return None
    return AREAS[dst] / AREAS[src]


def _qty_factor(src: str, dst: str) -> float | None:
    """Multiply an amount in ``src`` by this to get it in ``dst`` (exact conversions only)."""
    if src == dst:
        return 1.0
    if src in MASS_KG and dst in MASS_KG:
        return MASS_KG[src] / MASS_KG[dst]
    return None


def _r(x: float | None, nd: int = 2) -> float | None:
    return None if x is None else round(x, nd)


# --------------------------------------------------------------------------- inputs


def region_chain(location: dict[str, Any] | None) -> tuple[list[str], str | None]:
    """The location's own region keys, most specific first, and its country."""
    if not isinstance(location, dict):
        return [], None
    key = location.get("region_key")
    if isinstance(key, str) and key and not key.startswith("koppen:"):
        country = key.split("-", 1)[0].upper()
        return ([key.upper(), country] if "-" in key else [country]), country
    try:
        lat, lon = float(location.get("latitude")), float(location.get("longitude"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return [], None
    from acre.geo.locate import describe

    d = describe(lat, lon, allow_network=False)
    keys = [k for k in d.region_keys if not k.startswith("koppen:")]
    country = (d.place or {}).get("country")
    return keys, country


def _area(area: dict[str, Any] | None) -> tuple[float, str] | None:
    if area is None:
        return None
    if not isinstance(area, dict):
        raise EconomicsInputError("area", "invalid_area", "area must be {value, unit}")
    v, u = area.get("value"), area.get("unit")
    if (isinstance(v, bool) or not isinstance(v, int | float) or
            not math.isfinite(v) or not v > 0 or not isinstance(u, str) or u not in AREAS):
        raise EconomicsInputError("area", "invalid_area",
                                  "area needs a positive value and unit acre or ha")  # fmt: skip
    return float(v), str(u)


def _value_unit(x: Any, field: str, *, cases: bool = False) -> dict[str, Any]:
    if not isinstance(x, dict) or _split(x.get("unit")) is None:
        raise EconomicsInputError(field, "invalid_override", f"{field} needs value and a unit "
                                  "like 'USD/bu' or 'bu/acre'")  # fmt: skip
    keys = [k for k in CASES if k in x] if cases else []
    vals = {k: x[k] for k in keys} if keys else {"value": x.get("value")}
    for k, v in vals.items():
        if (isinstance(v, bool) or not isinstance(v, int | float) or
                not math.isfinite(v) or v < 0):
            raise EconomicsInputError(f"{field}.{k}", "invalid_override",
                                      f"{field} must be a non-negative number")  # fmt: skip
    if keys and ("typical" not in vals or list(vals.values()) != sorted(vals.values())):
        raise EconomicsInputError(field, "invalid_override",
                                  "price cases need typical and low <= typical <= high")
    return {**{k: float(v) for k, v in vals.items()}, "unit": str(x["unit"])}


def _overrides(raw: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise EconomicsInputError("overrides", "invalid_override", "overrides must be an object")
    out: dict[str, dict[str, Any]] = {}
    for crop, o in raw.items():
        cid = crop_ids.canonical(crop) or str(crop)
        if not isinstance(o, dict):
            raise EconomicsInputError(f"overrides.{crop}", "invalid_override", "must be an object")
        bad = set(o) - {"price", "yield", "costs"}
        if bad:
            raise EconomicsInputError(f"overrides.{crop}", "invalid_override",
                                      f"unknown key(s) {sorted(bad)}; use price, yield, costs")  # fmt: skip
        ov: dict[str, Any] = {}
        if o.get("price") is not None:
            ov["price"] = _value_unit(o["price"], f"overrides.{crop}.price", cases=True)
        if o.get("yield") is not None:
            ov["yield"] = _value_unit(o["yield"], f"overrides.{crop}.yield")
        c = o.get("costs")
        if isinstance(c, dict) and "total" in c:
            ov["costs"] = {"total": _value_unit(c["total"], f"overrides.{crop}.costs.total")}
        elif isinstance(c, list):
            items = []
            for i, it in enumerate(c):
                if not isinstance(it, dict) or not str(it.get("item") or "").strip():
                    raise EconomicsInputError(f"overrides.{crop}.costs[{i}]", "invalid_override",
                                              "each cost needs item, value and unit")  # fmt: skip
                items.append({"item": str(it["item"]).strip(),
                              **_value_unit(it, f"overrides.{crop}.costs[{i}]")})  # fmt: skip
            ov["costs"] = {"items": items}
        elif c is not None:
            raise EconomicsInputError(f"overrides.{crop}.costs", "invalid_override",
                                      "costs is a list of items or {total}")  # fmt: skip
        out[cid] = ov
    return out


def _losses(raw: dict[str, Any] | None) -> dict[str, Any]:
    """The farmer's loss assumptions, echoed as ``assumed`` (S2 is the only place they apply)."""
    if raw is None:
        return {}
    if not isinstance(raw, dict) or set(raw) - set(LOSS_KEYS):
        raise EconomicsInputError("loss_assumptions", "invalid_loss",
                                  f"loss_assumptions keys are {list(LOSS_KEYS)}")  # fmt: skip
    out = {}
    for k in LOSS_KEYS:
        v = raw.get(k)
        if v is None:
            out[k] = None
            continue
        if isinstance(v, bool) or not isinstance(v, int | float) or not 0 <= v <= 100:
            raise EconomicsInputError(f"loss_assumptions.{k}", "invalid_loss",
                                      "a loss is a percentage 0-100")  # fmt: skip
        out[k] = {"value": float(v), "unit": "%", "origin": "assumed",
                  "label": "assumed (your estimate)"}  # fmt: skip
    return out


# --------------------------------------------------------------------------- lookups


def _pick(rows: list[dict[str, Any]], chain: list[str], **match: Any) -> list[dict[str, Any]]:
    """Rows of the most specific region in ``chain`` that has any, newest first."""
    for key in chain:
        hits = [r for r in rows if (r.get("region_key") or "").upper() == key
                and all(r.get(k) == v for k, v in match.items())]  # fmt: skip
        if hits:
            return sorted(hits, key=lambda r: (str(r.get("year") or r.get("years") or ""),
                                               str(r.get("retrieved") or "")), reverse=True)  # fmt: skip
    return []


def _norm_price(p: dict[str, Any], us: bool) -> dict[str, Any]:
    """Price per quantity; outside the US a mass price is shown per tonne."""
    cur, qty = _split(p["unit"])  # type: ignore[misc]
    if not us and qty in MASS_KG and qty != "t":
        f = 1 / _qty_factor(qty, "t")  # type: ignore[operator]
        return {**p, **{k: _r(p[k] * f) for k in CASES if p.get(k) is not None},
                "unit": f"{cur}/t"}  # fmt: skip
    return p


def _norm_yield(y: dict[str, Any], area_unit: str, us: bool) -> dict[str, Any]:
    qty, au = _split(y["unit"])  # type: ignore[misc]
    f = _area_factor(au, area_unit)
    if f is None:
        return {**y, "unit_note": f"area unit '{au}' was not converted"}
    to = "t" if not us and qty in MASS_KG else qty
    q = _qty_factor(qty, to) or 1.0
    return {**y, "value": _r(y["value"] * f * q, 3), "unit": f"{to}/{area_unit}"}


def _per_area(value: float, unit: str, area_unit: str) -> tuple[float, str, str] | None:
    """A cost per area as (value per ``area_unit``, currency, unit); None if not convertible."""
    sp = _split(unit)
    if sp is None:
        return None
    cur, au = sp
    f = _area_factor(au, area_unit)
    return None if f is None else (value * f, cur, f"{cur}/{area_unit}")


# --------------------------------------------------------------------------- researched references


def _year(r: dict[str, Any]) -> int:
    try:
        return int(str(r.get("year") or "")[:4])
    except ValueError:
        return 0


def _url(r: dict[str, Any]) -> str:
    return str((r.get("source") or {}).get("url") or "")


def _ref_usable(kind: str, r: dict[str, Any]) -> bool:
    """Can the estimate turn this reference's unit into a value (price ``CUR/qty``, yield
    ``qty/area``, cost ``CUR/area`` with a known area)?"""
    sp = _split(r.get("unit"))
    if sp is None or not isinstance(r.get("value"), int | float):
        return False
    if kind == "price":
        return sp[1] not in AREAS
    return sp[1] in AREAS and (kind != "yield" or sp[0] not in AREAS)


def _ref_source(r: dict[str, Any]) -> dict[str, Any]:
    src = r.get("source") or {}
    return {"title": src.get("title"), "url": src.get("url"), "locator": src.get("locator"),
            "year": _year(r) or None, "evidence_quote": src.get("evidence_quote"),
            "region_key": r["region_key"]}  # fmt: skip


def _checked(refs: list[dict[str, Any]], chain: list[str], kind: str) -> list[dict[str, Any]]:
    """Usable ``source_checked`` references of ``kind`` for the most specific region that has any."""
    ok = [r for r in refs if r["kind"] == kind and r["origin"] == "source_checked"
          and _ref_usable(kind, r)]  # fmt: skip
    for key in chain:
        hits = [r for r in ok if r["region_key"] == key]
        if hits:
            return hits
    return []


def _ref_price(refs: list[dict[str, Any]], chain: list[str]) -> dict[str, Any] | None:
    """Low, typical and high over the newest years of one unit, currency and source domain (never
    mixed); a single reference gives low = typical = high."""
    hits = _checked(refs, chain, "price")
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for r in hits:
        key = (r["unit"], str(r.get("currency") or ""), urlparse(_url(r)).hostname or "")
        groups.setdefault(key, []).append(r)
    if not groups:
        return None
    key, grp = max(groups.items(), key=lambda kv: (max(_year(r) for r in kv[1]), len(kv[1]),
                                                   kv[0]))  # fmt: skip
    years = sorted({_year(r) for r in grp}, reverse=True)[:PRICE_YEARS]
    sel = sorted((r for r in grp if _year(r) in years), key=lambda r: (-_year(r), _url(r)))
    vals = sorted(float(r["value"]) for r in sel)
    newest = sel[0]
    src = _ref_source(newest)
    if len(years) > 1:
        src = {**{k: v for k, v in src.items() if k != "year"},
               "years": f"{min(years)}-{max(years)}"}
    return {"low": vals[0], "typical": statistics.median(vals), "high": vals[-1], "unit": key[0],
            "currency": key[1] or _split(key[0])[0],  # type: ignore[index]
            "origin": "source_checked", "source": src,
            "sources": [_ref_source(r) | {"value": r["value"]} for r in sel]}  # fmt: skip


def _ref_yield(refs: list[dict[str, Any]], chain: list[str]) -> dict[str, Any] | None:
    hits = _checked(refs, chain, "yield")
    if not hits:
        return None
    r = max(hits, key=lambda r: (_year(r), _url(r), r["value"]))
    return {"value": r["value"], "unit": r["unit"], "origin": "source_checked",
            "source": _ref_source(r)}  # fmt: skip


def _ref_costs(refs: list[dict[str, Any]], chain: list[str]) -> list[dict[str, Any]]:
    """The newest ``total`` if there is one, else the items of the single newest source and year
    (never summed across sources)."""
    hits = _checked(refs, chain, "cost")
    if not hits:
        return []
    totals = [r for r in hits if r.get("item") == "total"]
    if totals:
        picked = [max(totals, key=lambda r: (_year(r), _url(r), r["value"]))]
    else:
        newest = max(hits, key=lambda r: (_year(r), _url(r)))
        picked = sorted((r for r in hits if _url(r) == _url(newest) and _year(r) == _year(newest)),
                        key=lambda r: str(r.get("item")))  # fmt: skip
    return [{"item": r.get("item") or "cost", "value": r["value"], "unit": r["unit"],
             "currency": r.get("currency") or _split(r["unit"])[0],  # type: ignore[index]
             "origin": "source_checked", "source": _ref_source(r)} for r in picked]


def _suggestions(refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """References that are not values: AI-found and unconfirmed, or checked but with a unit the
    estimate cannot use. Newest first; the farmer may adopt one (it returns as an override)."""
    out = []
    for r in sorted(refs, key=lambda r: (-_year(r), _url(r), str(r.get("item")))):
        kind = r["kind"] if r["kind"] in ("price", "yield", "cost") else None
        if kind is None:
            continue
        usable = _ref_usable(kind, r)
        if r["origin"] == "source_checked" and usable:
            continue
        note = ("the unit could not be converted; check it before using this number" if not usable
                else "AI-found: the quote was not confirmed on a page of an approved source")
        src = r.get("source") or {}
        out.append({"field": "costs" if kind == "cost" else kind,
                    **({"item": r.get("item") or "cost"} if kind == "cost" else {}),
                    "value": r["value"], "unit": r["unit"], "currency": r.get("currency"),
                    "year": _year(r) or None, "origin": r["origin"],
                    "region_key": r["region_key"],
                    "source": {"title": src.get("title"), "url": src.get("url"),
                               "locator": src.get("locator"),
                               "evidence_quote": src.get("evidence_quote")}, "note": note})  # fmt: skip
    return out[:MAX_SUGGESTIONS]


def _researched(cid: str, chain: list[str]) -> list[dict[str, Any]]:
    if not chain:
        return []
    try:
        from acre.croplib import library

        return library.researched_refs(cid, chain)
    except Exception as exc:  # noqa: BLE001 - the library never breaks an estimate
        log.warning("researched references unavailable: %s", type(exc).__name__)
        return []


def _research_state(cid: str, chain: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {"researched_at": None, "status": None}
    if chain:
        try:
            from acre.croplib import library

            row = library.research_status("economics", cid, chain[0])
        except Exception:  # noqa: BLE001
            row = None
        if row:
            out = {"researched_at": row["researched_at"], "status": row["status"]}
    return out


def _crop(cid: str, chain: list[str], t: data.Tables, ov: dict[str, Any], area_unit: str,
          us: bool, area: tuple[float, str] | None,
          refs: list[dict[str, Any]] = ()) -> dict[str, Any]:  # type: ignore[assignment]  # fmt: skip
    reasons: list[str] = []
    # price
    price: dict[str, Any] | None = None
    if "price" in ov:
        o = ov["price"]
        vals = {k: o.get(k, o.get("value")) for k in CASES}
        cur = _split(o["unit"])[0]  # type: ignore[index]
        price = {**vals, "unit": o["unit"], "currency": cur, "origin": "grower", "source": None}
    else:
        rows = _pick(t.prices, chain, crop_id=cid)
        if rows:
            r = rows[0]
            price = {"low": r["low"], "typical": r["typical"], "high": r["high"],
                     "unit": r["unit"], "currency": r["currency"] or _split(r["unit"])[0],  # type: ignore[index]
                     "origin": r["origin"], "source": data.source_of(r)}  # fmt: skip
        elif (rp := _ref_price(refs, chain)) is not None:
            price = rp
        else:
            reasons.append("no sourced price for this region")
    if price is not None and _split(price["unit"]) is not None:
        price = _norm_price(price, us)
    # yield
    yld: dict[str, Any] | None = None
    if "yield" in ov:
        yld = {"value": ov["yield"]["value"], "unit": ov["yield"]["unit"], "origin": "grower",
               "source": None}  # fmt: skip
    else:
        rows = _pick(t.yields, chain, crop_id=cid)
        if rows:
            r = rows[0]
            yld = {"value": r["value"], "unit": r["unit"], "origin": r["origin"],
                   "source": data.source_of(r),
                   **({"area_basis": r["area_basis"]} if r.get("area_basis") else {})}  # fmt: skip
        elif (ry := _ref_yield(refs, chain)) is not None:
            yld = ry
        else:
            reasons.append("no sourced yield for this region")
    if yld is not None and _split(yld["unit"]) is not None:
        yld = _norm_yield(yld, area_unit, us)
    # costs
    costs: dict[str, Any] = {"items": [], "total_per_area": None}
    oc = ov.get("costs")
    cost_rows: list[dict[str, Any]]
    if oc and "total" in oc:
        cost_rows = [{"item": "total", **oc["total"], "origin": "grower", "source": None}]
    elif oc:
        cost_rows = [{**i, "origin": "grower", "source": None} for i in oc["items"]]
    else:
        src_rows = _pick(t.costs, chain, crop_id=cid)
        if src_rows:  # one source and year only: never sum across datasets
            first = src_rows[0]
            same = [r for r in src_rows if r["source_url"] == first["source_url"]
                    and r.get("year") == first.get("year")]  # fmt: skip
            cost_rows = [{"item": r["item"], "value": r["value"], "unit": r["unit"],
                          "currency": r["currency"], "origin": r["origin"],
                          **({"area_basis": r["area_basis"]} if r.get("area_basis") else {}),
                          "source": data.source_of(r)} for r in sorted(same, key=lambda r: r["item"])]  # fmt: skip
        elif rc := _ref_costs(refs, chain):
            cost_rows = rc
        else:
            cost_rows = []
            reasons.append("no sourced costs for this region")
    total, cur_set, ok = 0.0, set(), bool(cost_rows)
    for c in cost_rows:
        conv = _per_area(c["value"], c["unit"], area_unit)
        if conv is None:
            ok = False
            costs["items"].append({**c, "value": c["value"], "unit": c["unit"],
                                   "unit_note": "not a per-area cost; not totalled"})  # fmt: skip
            continue
        v, cur, unit = conv
        cur_set.add(c.get("currency") or cur)
        total += v
        costs["items"].append({**{k: v2 for k, v2 in c.items() if k != "currency"},
                               "value": _r(v), "unit": unit})  # fmt: skip
    bases = {c["area_basis"] for c in cost_rows
             if c.get("area_basis") in {"harvested", "planted"}}
    if len(bases) > 1:
        ok = False
        reasons.append("cost items use conflicting planted and harvested area bases")
    if ok and len(cur_set) == 1:
        cur = next(iter(cur_set))
        basis = next(iter(bases)) if bases else (
            "unknown" if any(c.get("area_basis") == "unknown" for c in cost_rows) else None)
        costs["total_per_area"] = {"value": _r(total), "unit": f"{cur}/{area_unit}",
                                   "currency": cur, "origin": "calculation",
                                   **({"area_basis": basis} if basis else {})}  # fmt: skip
    elif cost_rows:
        reasons.append("costs could not be totalled (units or currencies differ)")

    # revenue and margin per area, per price case
    revenue = margin = None
    if price is not None and yld is not None:
        p_cur, p_qty = _split(price["unit"]) or (None, None)
        y_qty, y_area = _split(yld["unit"]) or (None, None)
        q = _qty_factor(y_qty, p_qty) if p_qty and y_qty else None  # type: ignore[arg-type]
        if q is None or y_area != area_unit:
            reasons.append(f"price ({price['unit']}) and yield ({yld['unit']}) units don't match, "
                           "so revenue is not computed")  # fmt: skip
        else:
            revenue = {k: _r(price[k] * yld["value"] * q) if price.get(k) is not None else None
                       for k in CASES}  # fmt: skip
            revenue.update(unit=f"{p_cur}/{area_unit}", currency=p_cur, origin="calculation")
            tot = costs["total_per_area"]
            y_basis = yld.get("area_basis")
            c_basis = (tot or {}).get("area_basis")
            if (y_basis in {"harvested", "planted"} and
                    c_basis in {"harvested", "planted"} and y_basis != c_basis):
                reasons.append(f"yield uses {y_basis} area and costs use {c_basis} area; "
                               "no margin without a sourced area-basis conversion")
            elif tot is not None and tot["currency"] == p_cur:
                margin = {k: _r(revenue[k] - tot["value"]) if revenue[k] is not None else None
                          for k in CASES}  # fmt: skip
                margin.update(unit=f"{p_cur}/{area_unit}", currency=p_cur, origin="calculation")
            elif tot is not None:
                reasons.append("price and cost currencies differ, so no margin")
    have = [price is not None, yld is not None, costs["total_per_area"] is not None]
    status = "complete" if margin is not None else "partial" if any(have) else "unavailable"
    out: dict[str, Any] = {"crop_id": cid, "name": _name(cid), "status": status, "price": price,
                           "yield": yld, "costs": costs, "revenue_per_area": revenue,
                           "margin_per_area": margin}  # fmt: skip
    crop_info = crop_ids.info(cid)
    out["aliases"] = list(crop_info.aliases) if crop_info else []
    out["suggestions"] = _suggestions(refs)
    out["economics_research"] = _research_state(cid, chain)
    if area is not None and (revenue or margin or costs["total_per_area"]):
        n = area[0] * AREAS[area[1]] / AREAS[area_unit]  # the area in ``area_unit``
        out["for_area"] = {"area": {"value": _r(n, 3), "unit": area_unit},
                           "revenue": _scale(revenue, n), "margin": _scale(margin, n),
                           "costs": _scale(costs["total_per_area"], n)}  # fmt: skip
    if status != "complete":
        out["reason_text"] = ("No money result: " if status == "unavailable" else
                              "Partial: ") + "; ".join(reasons) + "."  # fmt: skip
    return out


def _scale(x: dict[str, Any] | None, n: float) -> dict[str, Any] | None:
    if x is None:
        return None
    keys = [k for k in (*CASES, "value") if k in x]
    return {**{k: _r(x[k] * n) if x[k] is not None else None for k in keys},
            "currency": x.get("currency"), "origin": "calculation"}  # fmt: skip


def _name(cid: str) -> str:
    i = crop_ids.info(cid)
    return i.name if i else cid.replace("_", " ")


def _equipment_costs(equipment: list[str], chain: list[str], t: data.Tables, area_unit: str,
                     gaps: list[str]) -> list[dict[str, Any]]:  # fmt: skip
    out = []
    for e in sorted(set(equipment)):
        if e.startswith("other:") or e == "irrigation_none":
            continue
        rows = _pick(t.custom_rates, chain, equipment=e)
        if not rows:
            gaps.append(f"No sourced custom rate for {e} in this region.")
            continue
        newest = {}
        for r in rows:
            newest.setdefault(r["operation"], r)
        for op, r in sorted(newest.items()):
            conv = _per_area(r["value"], r["unit"], area_unit)
            value, unit = (_r(conv[0]), conv[2]) if conv else (r["value"], r["unit"])
            out.append({"equipment": e, "pass": op, "value": value, "unit": unit,
                        "currency": r["currency"], "origin": r["origin"],
                        "source": data.source_of(r)})  # fmt: skip
    return out


def estimate_economics(location: dict[str, Any] | None, crops: list[str],
                       area: dict[str, Any] | None = None, equipment: list[str] = (),  # type: ignore[assignment]
                       overrides: dict[str, Any] | None = None, *,
                       loss_assumptions: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    """Contract §12 body without ``meta``. Raises :class:`EconomicsInputError` on bad input."""
    if not isinstance(crops, list | tuple) or not crops or len(crops) > 20:
        raise EconomicsInputError("crops", "invalid_crops", "send 1-20 crop ids")
    cids = []
    for c in crops:
        if not isinstance(c, str) or not c.strip():
            raise EconomicsInputError("crops", "invalid_crops", "crop ids are strings")
        cids.append(crop_ids.canonical(c) or c.strip().lower())
    cids = list(dict.fromkeys(cids))
    equipment = list(equipment or [])
    bad = [e for e in equipment if not isinstance(e, str) or not valid_equipment(e)]
    if bad:
        raise EconomicsInputError("equipment", "invalid_equipment", f"unknown equipment {bad}")
    ar = _area(area)
    ov = _overrides(overrides)
    losses = _losses(loss_assumptions)
    chain, country = region_chain(location)
    us = country == "US" or (bool(chain) and chain[-1] == "US")
    area_unit = "acre" if us else "ha"
    t = data.load()
    gaps: list[str] = []
    if not any(t.present.values()):
        gaps.append("The economics reference data (E0) is not installed on this server; only "
                    "your own numbers are used.")  # fmt: skip
    if not chain:
        gaps.append("No region is known for this location, so no regional reference applies.")
    crop_out = [_crop(c, chain, t, ov.get(c, {}), area_unit, us, ar, _researched(c, chain))
                for c in cids]
    currencies = {x["margin_per_area"]["currency"] for x in crop_out if x["margin_per_area"]}
    currencies |= {x["price"]["currency"] for x in crop_out if x["price"]}
    statuses = {x["status"] for x in crop_out}
    status = ("complete" if statuses == {"complete"} else
              "unavailable" if statuses == {"unavailable"} else "partial")  # fmt: skip
    return {
        "status": status,
        "currency": "USD" if us else (next(iter(currencies)) if len(currencies) == 1 else None),
        "area_unit": area_unit,
        "area": {"value": ar[0], "unit": ar[1], "origin": "grower"} if ar else None,
        "region_keys": chain,
        "crops": crop_out,
        "research": {"available": client.configured(), "region_key": chain[0] if chain else None},
        "equipment_costs": _equipment_costs(equipment, chain, t, area_unit, gaps),
        "equipment_note": PASS_NOTE,
        "loss_assumptions": losses,
        "gaps": gaps,
        "note": "Money uses your numbers first, then sourced regional references and researched "
                "ones whose quote was found on an approved source's page; a value with none of "
                "these is left blank. Not a forecast.",
    }  # fmt: skip
