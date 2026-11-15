from acre.api.recommend_routes import CandidateIn
from acre.api.simulate_routes import ScenarioIn
from acre.contracts import MAX_ROTATION_LEGS


def _plan():
    return {"plan_id": "p", "previous_crop_id": "corn", "prev_harvest": "09-30", "winter": {"kind": "none"},
            "next_crop_id": "soybean", "next_plant": "05-10"}  # fmt: skip


def test_rotations_longer_than_four_legs_are_accepted_up_to_the_limit():
    ScenarioIn(scenario_id="s", rotation=[_plan()] * 6)
    CandidateIn(candidate_id="c", plans=[_plan()] * MAX_ROTATION_LEGS)


def test_a_rotation_over_the_limit_is_rejected():
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ScenarioIn(scenario_id="s", rotation=[_plan()] * (MAX_ROTATION_LEGS + 1))
