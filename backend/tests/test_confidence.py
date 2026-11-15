from acre.confidence import economics_confidence, rating


def test_mock_values_have_no_source_support():
    assert economics_confidence({"origin": "assumed"}, {"origin": "assumed"},
                                {"items": [{"origin": "assumed"}]})["percent"] == 0


def test_mixed_inputs_and_missing_costs():
    result = economics_confidence({"origin": "verified_source"}, {"origin": "grower"}, {})
    assert result["percent"] == 67
    assert result["level"] == "Medium"


def test_history_fraction_and_empty_history():
    assert rating(36, 40, "history")["percent"] == 90
    assert rating(0, 0, "history")["level"] == "Low"
