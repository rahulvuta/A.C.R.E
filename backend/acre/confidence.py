"""Transparent data-support percentages, not calibrated prediction probabilities."""

SUPPORTED = {"grower", "verified_source", "source_checked", "dataset_estimate",
             "nasa_measured", "nasa_modeled"}


def rating(supported: int, total: int, basis: str) -> dict:
    percent = round(100 * supported / total) if total else 0
    percent = max(0, min(100, percent))
    return {"percent": percent,
            "level": "High" if percent >= 80 else "Medium" if percent >= 50 else "Low",
            "basis": basis,
            "note": "Data support only; not a calibrated probability of accuracy or success."}


def economics_confidence(price: dict | None, yld: dict | None, costs: dict) -> dict:
    items = costs.get("items") or []
    flags = [bool(price and price.get("origin") in SUPPORTED),
             bool(yld and yld.get("origin") in SUPPORTED),
             bool(items and all(i.get("origin") in SUPPORTED for i in items))]
    return rating(sum(flags), 3,
                  "Share of price, yield and cost inputs supplied by the grower or traceable "
                  "sources. Mock, assumed and missing inputs do not count as supported.")
