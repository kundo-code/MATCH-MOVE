"""Green Center as the standardised target (sections 11, 12, 13, 33)."""

import math

import pytest

from matchmove.confidence import Confidence, Source
from matchmove.geo import LatLon, Vec3, geodetic_to_enu, enu_to_geodetic, polygon_centroid
from matchmove.spec import (
    Feature,
    FeatureType,
    HoleSpec,
    TARGET_LABEL,
    TargetLabelError,
)


def square_green(offset=(0.0, 0.0)):
    ox, oy = offset
    return Feature(
        id="green", type=FeatureType.GREEN,
        points=[Vec3(ox - 10, oy - 10), Vec3(ox + 10, oy - 10),
                Vec3(ox + 10, oy + 10), Vec3(ox - 10, oy + 10)],
        source=Source.COURSE_MAP, confidence=Confidence.VISUALLY_MATCHED,
    )


def test_green_center_is_the_geometric_centre_of_the_putting_surface():
    spec = HoleSpec("Test", 1, 4, features=[square_green((5.0, -3.0))])
    c = spec.green_center()
    assert c.x == pytest.approx(5.0)
    assert c.y == pytest.approx(-3.0)


def test_target_is_always_the_green_center():
    spec = HoleSpec("Test", 1, 4, features=[square_green()])
    assert spec.target() == spec.green_center()


def test_no_green_geometry_means_no_target_rather_than_a_guess():
    spec = HoleSpec("Test", 1, 4, features=[])
    assert spec.green_center() is None
    assert spec.target() is None


@pytest.mark.parametrize("label", ["PIN", "pin", "HOLE CUP", "Hole-Cup", "핀", "홀컵", "CUP"])
def test_target_may_never_be_labelled_as_the_daily_pin(label):
    with pytest.raises(TargetLabelError):
        HoleSpec.assert_target_label(label)


def test_green_center_label_is_accepted():
    assert HoleSpec.assert_target_label(TARGET_LABEL) == TARGET_LABEL
    assert HoleSpec.assert_target_label("CENTER") == "CENTER"


def test_area_weighted_centroid_handles_an_irregular_green():
    pts = [Vec3(0, 0), Vec3(30, 0), Vec3(30, 10), Vec3(10, 10), Vec3(10, 30), Vec3(0, 30)]
    c = polygon_centroid(pts)
    assert 0 < c.x < 30 and 0 < c.y < 30
    # An L-shaped green: the centroid sits toward the corner, not at the bbox middle.
    assert c.x < 15 and c.y < 15


def test_enu_round_trip_is_sub_millimetre():
    datum = LatLon(37.4512, 127.1289, 78.0)
    p = LatLon(37.4530, 127.1312, 82.0)
    back = enu_to_geodetic(geodetic_to_enu(p, datum), datum)
    assert back.lat == pytest.approx(p.lat, abs=1e-9)
    assert back.lon == pytest.approx(p.lon, abs=1e-9)
    assert back.alt == pytest.approx(p.alt, abs=1e-3)


def test_confirmed_tee_distance_is_returned_and_unconfirmed_is_not():
    from matchmove.spec import TeeColor, TeeDistance

    spec = HoleSpec("Test", 1, 4, features=[square_green()],
                    tees=[TeeDistance(TeeColor.WHITE, 352.0, source=Source.YARDAGE_BOOK,
                                      confidence=Confidence.CONFIRMED)],
                    primary_tee=TeeColor.WHITE)
    assert spec.tee_distance() == 352.0

    spec.tees = [TeeDistance(TeeColor.WHITE, 352.0, source=Source.DRONE,
                             confidence=Confidence.CONFIRMED)]
    assert spec.tee_distance() is None
