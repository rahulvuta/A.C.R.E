"""Geo tests never touch the network: Nominatim is replaced by a fake transport or by fixtures."""

from __future__ import annotations

import pytest

from acre.geo import nominatim


@pytest.fixture(autouse=True)
def _isolated_geocoder(tmp_path, monkeypatch):
    """A fresh client per test with an empty cache dir; the network must not be used."""
    monkeypatch.delenv("ACRE_OFFLINE", raising=False)
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path / "cache"))

    def no_network(request):
        raise AssertionError(f"unexpected network call: {request.url.host}")

    import httpx

    client = nominatim.Nominatim(
        cache_dir=tmp_path / "geo",
        client=httpx.Client(transport=httpx.MockTransport(no_network)),
        min_interval=0.0,
    )
    nominatim.set_client(client)
    from acre.weather import ondemand

    ondemand.reset_jobs()  # weather jobs from other test modules must not leak into capabilities
    yield client
    nominatim.set_client(None)
    ondemand.set_fetch(None)
    ondemand.reset_jobs()
