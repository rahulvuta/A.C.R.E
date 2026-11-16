import pytest

from acre.geo.parse import CoordinateError, parse_coordinates

UNION_ISH = (35.1, -80.5)


@pytest.mark.parametrize(
    "text",
    [
        "35.1, -80.5",
        "35.1 -80.5",
        "35.1;-80.5",
        "35°06'N 80°30'W",
        "35°06′00″N 80°30′00″W",
        "35 06 N 80 30 W",
        "35.1 N 80.5 W",
        "N35°06' W80°30'",
        "W80°30' N35°06'",
        "80°30'W 35°06'N",
        "35.1N, 80.5W",
    ],
)
def test_decimal_and_dms_forms_give_the_same_point(text):
    p = parse_coordinates(text)
    assert (p.latitude, p.longitude) == pytest.approx(UNION_ISH)


def test_southern_and_eastern_hemispheres():
    s = parse_coordinates("33.89S, 60.57W")
    assert (s.latitude, s.longitude) == pytest.approx((-33.89, -60.57))
    e = parse_coordinates("S33°53'24\" E151°12'")
    assert e.latitude < 0 < e.longitude
    assert parse_coordinates("-33.89,-60.57").latitude == -33.89


@pytest.mark.parametrize(
    "text", ["Pergamino", "", "   ", "35", "35 45", "Union County NC", "1 2 3 4 5"]
)
def test_text_that_is_not_coordinates_is_none(text):
    assert parse_coordinates(text) is None


@pytest.mark.parametrize(
    "text",
    ["95, 10", "10, 200", "35°70'N 80°30'W", "35°06'S 80°30'N", "-35 S, 80 W", "35N 80N"],
)
def test_coordinate_looking_text_that_is_invalid_raises(text):
    with pytest.raises(CoordinateError):
        parse_coordinates(text)


def test_short_decimals_and_contradictory_signs():
    p = parse_coordinates(".5, -80.123456")
    assert (p.latitude, p.longitude) == pytest.approx((0.5, -80.123456))
    assert parse_coordinates("5., -80.").latitude == 5.0
    for bad in ("-35N,80E", "35N,-80W", "-35S 80W"):
        with pytest.raises(CoordinateError):
            parse_coordinates(bad)


def test_coordinate_like_text_is_recognised_so_it_is_never_sent_to_a_geocoder():
    from acre.geo.parse import looks_like_coordinates

    for t in ("35.1 80.5 1", "35N 80", ".5, -80.123456 ,", "35°06'N 80°30'"):
        assert looks_like_coordinates(t)
    for t in ("Pergamino", "Route 66", "Union County NC", "", "N"):
        assert not looks_like_coordinates(t)
