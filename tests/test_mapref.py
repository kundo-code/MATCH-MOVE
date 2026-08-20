"""Georeferencing a course-map capture (section 01B)."""

import math

import pytest

from matchmove.geo import LatLon, Vec3, geodetic_to_enu
from matchmove.mapref import MapLandmark, MapReference, fit_map_reference
from matchmove.solve import SolveError
from matchmove.spec import FeatureType


def synthetic_capture(rotation_deg=0.0, m_per_px=0.35):
    """Landmarks from a pretend capture rotated ``rotation_deg`` clockwise."""
    truth = {
        "green_center": Vec3(0, 0, 0),
        "tee": Vec3(-6, -320, 0),
        "bunker": Vec3(28, -148, 0),
        "cartpath": Vec3(-44, -96, 0),
    }
    r = math.radians(rotation_deg)
    cr, sr = math.cos(r), math.sin(r)
    cx, cy = 900.0, 620.0
    out = []
    for name, w in truth.items():
        # world -> pixels: rotate, scale down, flip Y, offset
        px = (w.x * cr + w.y * sr) / m_per_px + cx
        py = -(-w.x * sr + w.y * cr) / m_per_px + cy
        out.append(MapLandmark(name, (px, py), w))
    return out


def test_similarity_fit_recovers_scale_and_position():
    lms = synthetic_capture()
    ref = fit_map_reference(lms[:2], model="similarity")
    ok, msg = ref.check()
    assert ok, msg
    assert ref.metres_per_pixel == pytest.approx(0.35, rel=1e-6)
    for lm in lms:
        p = ref.to_world(*lm.px)
        assert p.x == pytest.approx(lm.world.x, abs=1e-6)
        assert p.y == pytest.approx(lm.world.y, abs=1e-6)


def test_similarity_fit_handles_a_rotated_capture():
    lms = synthetic_capture(rotation_deg=37.0)
    ref = fit_map_reference(lms[:2], model="similarity")
    assert ref.check()[0]
    # The capture is rotated 37 deg clockwise, so its 'up' points to 323 deg.
    assert ref.rotation_deg == pytest.approx(323.0, abs=1e-4)
    for lm in lms[2:]:
        p = ref.to_world(*lm.px)
        assert math.hypot(p.x - lm.world.x, p.y - lm.world.y) < 1e-5


def test_affine_fit_uses_every_landmark():
    ref = fit_map_reference(synthetic_capture(rotation_deg=12.0))
    assert ref.model == "affine"
    assert ref.rms_m < 1e-6


def test_a_bad_landmark_is_reported_rather_than_absorbed():
    lms = synthetic_capture()
    lms[2] = MapLandmark("bunker", (lms[2].px[0] + 120.0, lms[2].px[1]), lms[2].world)
    ref = fit_map_reference(lms)
    ok, msg = ref.check(tolerance_m=3.0)
    assert not ok
    assert ref.max_m > 3.0
    assert "do not trace geometry" in msg
    # Every landmark's residual is listed, since least squares smears the error.
    for lm in lms:
        assert lm.name in msg


def test_one_landmark_is_refused():
    with pytest.raises(SolveError):
        fit_map_reference(synthetic_capture()[:1])


def test_tracing_an_outline_produces_world_metres():
    ref = fit_map_reference(synthetic_capture())
    # A square traced on the capture, 40 px on a side at 0.35 m/px = 14 m.
    outline = [(900, 620), (940, 620), (940, 660), (900, 660)]
    pts = ref.trace(outline)
    side = math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
    assert side == pytest.approx(14.0, rel=1e-6)


def test_a_traced_feature_carries_map_provenance():
    ref = fit_map_reference(synthetic_capture())
    green = ref.feature("green", FeatureType.GREEN,
                        [(880, 600), (920, 600), (920, 640), (880, 640)])
    assert green.type is FeatureType.GREEN
    assert green.displayable                       # grade B geometry may be drawn
    assert green.source.value == "course_map"
    assert len(green.points) == 4


def test_landmarks_can_be_given_as_lat_lon():
    datum = LatLon(37.4512, 127.1289, 78.0)
    tee = LatLon(37.4485, 127.1281, 84.0)
    lm = MapLandmark.from_latlon("tee", (410.0, 1180.0), tee, datum)
    expected = geodetic_to_enu(tee, datum)
    assert lm.world.x == pytest.approx(expected.x)
    assert lm.world.y == pytest.approx(expected.y)
