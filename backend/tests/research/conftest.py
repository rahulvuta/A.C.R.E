"""Research tests never reach the network: page fetches and the Claude call are replaced."""

import httpx
import pytest


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    def refuse(self, *a, **k):
        raise AssertionError("unexpected network call from a research test")

    monkeypatch.setattr(httpx.Client, "send", refuse)
