"""Synthetic grower readings: precedence, isolation, units and sourced crop assessment."""

from datetime import date

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from acre.api.app import create_app
from acre.compare.context import get_context
from acre.field import conditions_research as research
from acre.field.conditions import effective_conditions, weather_overrides
from acre.field.equipment import Reading
from acre.field.soilgrids import SoilGridsResult, SoilProperty, SoilValue
from acre.research import client, verify

AT = date(2025, 4, 2)
LOCATION = {"latitude": 34.98, "longitude": -80.55}


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setenv("ACRE_OFFLINE", "1")
    research._CACHE.clear()
    yield
    research._CACHE.clear()
    client.set_caller(None)


def reading(kind, value, when="2025-04-02", **kw):
    return Reading(date=when, kind=kind, value=value, **kw)


def test_measurement_wins_and_clearing_it_restores_sourced_local_baseline():
    soil = SoilGridsResult(status="complete", properties=[SoilProperty(
        name="ph_water", label="pH", unit="pH", values=[
            SoilValue(depth="0-5 cm", value=6.4, unit="pH")])])
    old, latest = reading("soil_ph", 6.0, "2024-01-01"), reading("soil_ph", 4.2)
    result = effective_conditions([latest, old], soil=soil, at=AT)
    ph = next(v for v in result["values"] if v["kind"] == "soil_ph")
    assert ph["value"] == 4.2 and ph["origin"] == "grower"
    assert ph["baseline"]["value"] == 6.4
    restored = effective_conditions([], soil=soil, at=AT)["values"][0]
    assert restored["value"] == 6.4 and restored["origin"] == "dataset_estimate"
    assert effective_conditions([], at=AT)["values"][0]["value"] is None


def test_weather_override_changes_private_copy_only_with_matching_units_and_date():
    ctx = get_context()
    before = ctx.series.frame.copy()
    rs = [reading("rainfall_mm", 0), reading("soil_moisture_pct", 18, moisture_basis="saturation", depth_cm=3),
          reading("soil_temp_c", 24), reading("soil_moisture_vwc", 0.23)]
    changed, used = weather_overrides(ctx, rs)
    assert changed.series.frame.loc["2025-04-02", "precip_mm"] == 0
    assert changed.series.frame.loc["2025-04-02", "gwettop"] == 0.18
    assert {r["variable"] for r in used} == {"precip_mm", "gwettop"}
    assert changed.series.frame.loc["2025-04-02", "tmean_c"] == before.loc["2025-04-02", "tmean_c"]
    assert ctx.series.frame.equals(before)
    untouched, used = weather_overrides(ctx, [reading("soil_moisture_pct", 18, moisture_basis="volumetric"),
        reading("rainfall_mm", 0, "2036-04-02"),
        reading("soil_moisture_pct", 18, moisture_basis="saturation", depth_cm=20)])
    assert untouched is ctx and used == []


@pytest.mark.parametrize("kind,value,extra", [
    ("soil_ph", 14.1, {}), ("soil_ph", float("nan"), {}),
    ("organic_matter_pct", -1, {}), ("salinity_ds_m", -0.1, {}),
    ("custom", 1, {}),
])
def test_invalid_conditions_cannot_override_baselines(kind, value, extra):
    with pytest.raises(ValidationError):
        reading(kind, value, **extra)


def test_zero_is_a_measurement_and_future_readings_are_not_current_conditions():
    rs = [reading("rainfall_mm", 0), reading("soil_ph", 8, "2036-04-02"),
          reading("custom", 0, name="Synthetic nutrient", unit="mg/kg")]
    result = effective_conditions(rs, at=AT)
    by_kind = {v["kind"]: v for v in result["values"]}
    assert by_kind["rainfall_mm"]["value"] == 0
    assert by_kind["custom"]["value"] == 0
    assert by_kind["soil_ph"]["value"] is None


def test_ai_uses_checked_references_and_rates_values_locally(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-test-key")
    ref = {"crop_id": "soybean", "key": "soil_ph", "unit": "pH", "normal_min": 6.0,
           "normal_max": 6.5, "below_effect": "Acidity can restrict root development.",
           "above_effect": "Nutrient availability may be reduced.", "context": "Synthetic mineral-soil fixture.",
           "source_title": "Synthetic extension fixture", "source_url": "https://example.edu/soil",
           "evidence_quote": "Synthetic crop soil pH range is 6.0 to 6.5."}
    seen = []
    client.set_caller(lambda params: (seen.append(params) or {"references": [ref], "gaps": []}))
    monkeypatch.setattr(verify, "fetch_page", lambda url: verify.Page(True, verify.normalise(ref["evidence_quote"])))
    below = effective_conditions([reading("soil_ph", 4.123, note="PRIVATE FARM NOTE")], at=AT)
    out = research.assess(below, ["soybean"], "US-NC", allow_research=True)
    assert out["impacts"][0]["rating"] == "abnormal"
    assert out["impacts"][0]["origin"] == "source_checked"
    assert "root development" in out["impacts"][0]["effect"]
    assert "4.123" not in str(seen) and "PRIVATE FARM NOTE" not in str(seen)
    normal = effective_conditions([reading("soil_ph", 6.2)], at=AT)
    assert research.assess(normal, ["soybean"], "US-NC")["impacts"][0]["rating"] == "normal"
    assert len(seen) == 1
    from acre.api.security import ANALYSIS, is_new_research_job, route_class

    assert route_class("POST", "/v1/field/conditions/assess") == ANALYSIS
    assert is_new_research_job({"job_id": out["_research_job_id"], "job_status": "ready", "check": {}})
    assert "_research_job_id" not in research.assess(normal, ["soybean"], "US-NC", allow_research=True)


def test_ai_cannot_rate_from_unchecked_or_wrong_unit_evidence():
    variables = [{"key": "soil_ph", "unit": "pH"}]
    ref = {"key": "soil_ph", "crop_id": "soybean", "unit": "pH", "normal_min": 6,
           "normal_max": 7, "source_url": "https://example.edu/soil",
           "evidence_quote": "A soil test is helpful."}
    assert research.checked_references({"references": [ref]}, variables, ["soybean"],
        lambda url: pytest.fail("unsupported numbers must be rejected before fetching")) == []
    assert research.checked_references({"references": [{**ref, "unit": "%"}]}, variables, ["soybean"]) == []


def test_provider_failure_reports_only_safe_error_metadata():
    def failed(_params):
        raise client.ResearchError("provider_error", "HTTP 402 PRIVATE-PROVIDER-DETAIL")

    client.set_caller(failed)
    result = research.assess(effective_conditions([reading("soil_ph", 4.2)], at=AT),
                             ["soybean"], "US-NC", allow_research=True)
    assert result["reason_code"] == "provider_error"
    assert result["provider_http_status"] == 402
    assert "PRIVATE-PROVIDER-DETAIL" not in str(result)
    assert result["impacts"][0]["rating"] == "unknown"


def test_conditions_endpoint_accepts_extra_values_without_a_weather_record(monkeypatch):
    monkeypatch.setattr("acre.field.conditions_routes.get_soilgrids", lambda *args: SoilGridsResult(status="unavailable"))
    with TestClient(create_app()) as api:
        result = api.post("/v1/field/conditions", json={"location": LOCATION,
            "as_of": "2025-04-02", "crops": ["soybean"],
            "readings": [reading("soil_ph", 4.2).model_dump(mode="json")]})
        assert result.status_code == 200
        body = result.json()
        assert body["values"][0]["value"] == 4.2
        assert body["values"][0]["origin"] == "grower"
        assert body["assessment"]["status"] == "unavailable"
