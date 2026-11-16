"""Card 18: on-screen text is translated once, numbers cannot change, nothing reaches the network."""

import json

import pytest
from fastapi.testclient import TestClient

from acre.api.app import create_app
from acre.research import client as research_client
from acre.translate import service


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("ACRE_CACHE_DIR", str(tmp_path))
    service._spent.clear()

    # No key in the environment, so anything not answered by the test's own engine is "unavailable", never a live call.
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    yield
    research_client.set_caller(None)


def _engine(table, calls):
    def call(body):
        asked = json.loads(body["messages"][1]["content"])
        calls.append(asked)
        return {"translations": [table.get(s, s) for s in asked["strings"]]}

    return call


def test_translates_once_and_answers_from_the_saved_store_after_that():
    calls: list = []
    research_client.set_caller(_engine({"Plant maize": "Panda mahindi",
                                        "About {0} mm of rain a year": "Karibu mm {0} za mvua kwa mwaka"}, calls))
    api = TestClient(create_app())
    body = {"language": "Swahili", "texts": ["Plant maize", "About {0} mm of rain a year"]}
    first = api.post("/v1/translate", json=body).json()
    assert first["status"] == "complete"
    assert first["translations"] == ["Panda mahindi", "Karibu mm {0} za mvua kwa mwaka"]
    assert first["origin"] == "ai_suggested"
    assert calls[0]["language"] == "Swahili"
    again = api.post("/v1/translate", json=body).json()
    assert again["translations"] == first["translations"]
    assert len(calls) == 1  # the second answer came from the saved store


def test_a_translation_that_touches_a_number_placeholder_is_refused():
    research_client.set_caller(_engine({"{0} of {1} years": "miaka 2 kati ya {1}",  # dropped {0}
                                        "Next: {0}": "Ifuatayo: {0} {0}",  # repeated it
                                        "Back": "Rudi"}, []))
    out = service.translate("Swahili", ["{0} of {1} years", "Next: {0}", "Back"])
    assert out["translations"] == [None, None, "Rudi"]
    assert out["status"] == "partial"
    assert service.acceptable("{0} of {1} years", "{1} kati ya miaka {0}")
    assert not service.acceptable("Back", "")


def test_without_a_key_it_says_so_and_still_serves_what_was_saved(monkeypatch):
    research_client.set_caller(_engine({"Back": "Rudi"}, []))
    service.translate("Swahili", ["Back"])
    research_client.set_caller(None)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    out = service.translate("Swahili", ["Back", "Next"])
    assert out["status"] == "unavailable" and out["code"] == "translate_not_configured"
    assert out["translations"] == ["Rudi", None]


def test_languages_do_not_share_saved_sentences_and_the_daily_ceiling_holds(monkeypatch):
    calls: list = []
    research_client.set_caller(_engine({"Back": "Rudi"}, calls))
    service.translate("Swahili", ["Back"])
    research_client.set_caller(_engine({"Back": "Atrás"}, calls))
    assert service.translate("Spanish", ["Back"])["translations"] == ["Atrás"]
    assert service.translate("swahili ", ["Back"])["translations"] == ["Rudi"]
    monkeypatch.setenv("ACRE_TRANSLATE_DAILY_CHARS", "5")
    service._spent.clear()
    out = service.translate("Hindi", ["A sentence longer than five characters"])
    assert out["code"] == "translate_daily_limit" and out["translations"] == [None]


def test_bad_requests_are_typed_400s():
    api = TestClient(create_app())
    for body in ({"language": "", "texts": ["x"]}, {"language": "Swahili", "texts": []},
                 {"language": "Swahili", "texts": ["x" * 2000]}, {"language": "12345", "texts": ["x"]},
                 {"language": "Swahili", "texts": ["ok", 3]}):
        r = api.post("/v1/translate", json=body)
        assert r.status_code == 400 and r.json()["status"] == "invalid_input"


def test_a_bad_answer_is_asked_again_in_halves():
    """One awkward sentence must not keep the whole batch in English."""
    calls: list[list[str]] = []

    def engine(body: dict) -> object:
        asked = json.loads(body["messages"][1]["content"])["strings"]
        calls.append(asked)
        if "Broken" in asked and len(asked) > 1:
            return "not json at all"
        if asked == ["Broken"]:
            return {"translations": []}
        return {"translations": [f"sw:{s}" for s in asked]}

    research_client.set_caller(engine)
    out = service.translate("Swahili", ["Back", "Next", "Broken", "Save"])
    assert out["translations"] == ["sw:Back", "sw:Next", None, "sw:Save"]
    assert out["status"] == "partial" and out["code"] == "translation_rejected"
    assert len(calls) > 1
