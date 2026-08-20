"""Graphics stay locked to the terrain (sections 07, 08, 09).

These are the tests that would catch a marker that floats, drifts or slides:
project a fixed world point through the whole flight and check it keeps
landing on the same piece of ground.
"""

import math

import pytest

from matchmove.camera import CameraPose, CameraTrack, Intrinsics, Keyframe
from matchmove.geo import Vec3
from matchmove.occlusion import Occluder, OcclusionModel
from matchmove.terrain import FlatTerrain, SampledTerrain, resample_polyline, smooth_polyline

INTR = Intrinsics.from_fov(1920, 1080, 78.0)


def flight():
    t = CameraTrack(INTR, 30.0, locked=False)
    keys = []
    for i in range(11):
        f = i * 30
        u = i / 10
        keys.append(Keyframe(f, CameraPose(
            Vec3(-4 + 4 * u, -400 + 380 * u, 120 - 70 * u), 3 - 3 * u, -20 - 14 * u, 0.0)))
    t.set_keyframes(keys)
    t.locked = True
    return t


def test_a_marker_never_slides_off_its_world_position():
    """Unproject the marker's pixel back to the ground on every frame."""
    track = flight()
    target = Vec3(0.0, 0.0, 0.0)
    worst = 0.0
    for f in range(0, 301, 5):
        pr = track.project(target, f)
        if not pr.visible:
            continue
        back = track.ground_point(pr.x, pr.y, f, z=0.0)
        worst = max(worst, math.hypot(back.x - target.x, back.y - target.y))
    assert worst < 1e-6, f"marker slid by {worst:.6f} m"


def test_marker_screen_position_moves_smoothly_with_no_jumps():
    """Screen speed may rise as the drone closes in, but never discontinuously.

    A tracking glitch shows up as one frame's step being wildly out of line
    with its neighbours, so the test bounds the *change* in step size rather
    than the step size itself (which legitimately grows on a push-in).
    """
    track = flight()
    target = Vec3(0.0, 0.0, 0.0)
    prev = None
    steps = []
    for f in range(0, 301):
        pr = track.project(target, f)
        if not pr.visible:
            prev = None
            continue
        if prev is not None:
            steps.append(math.hypot(pr.x - prev[0], pr.y - prev[1]))
        prev = (pr.x, pr.y)
    assert len(steps) > 100
    for a, b in zip(steps, steps[1:]):
        assert abs(b - a) <= 0.12 * max(a, b, 1.0), f"screen motion jumped {a:.2f}->{b:.2f}px"


def test_a_marker_scales_with_camera_distance():
    track = flight()
    target = Vec3(0.0, 0.0, 0.0)
    early = track.screen_scale(target, 0)
    late = track.screen_scale(target, 300)
    assert late > early * 2


def test_ground_graphics_conform_to_the_terrain():
    terrain = SampledTerrain([Vec3(-50, -50, 0), Vec3(50, -50, 4),
                              Vec3(0, 60, 9), Vec3(0, 0, 3)])
    line = [Vec3(-40, -40, 0), Vec3(0, 0, 0), Vec3(0, 50, 0)]
    conformed = terrain.conform(resample_polyline(line, 5.0))
    assert len(conformed) > len(line)
    for p in conformed:
        assert p.z == pytest.approx(terrain.height(p.x, p.y))
    # The route rises with the ground rather than staying at z = 0.
    assert max(p.z for p in conformed) > 2.0


def test_flat_terrain_reports_that_it_has_no_elevation_data():
    t = FlatTerrain()
    assert not t.has_elevation_data
    assert t.height(123.0, -45.0) == 0.0


def test_resampling_does_not_move_the_path():
    line = [Vec3(0, 0, 0), Vec3(0, 100, 0)]
    dense = resample_polyline(line, 5.0)
    assert dense[0].as_tuple() == line[0].as_tuple()
    assert dense[-1].as_tuple() == line[-1].as_tuple()
    assert all(abs(p.x) < 1e-9 for p in dense)


def test_smoothing_keeps_the_endpoints():
    line = [Vec3(0, 0, 0), Vec3(20, 40, 0), Vec3(0, 90, 0)]
    out = smooth_polyline(line, 2)
    assert out[0].as_tuple() == line[0].as_tuple()
    assert out[-1].as_tuple() == line[-1].as_tuple()


def test_graphics_are_hidden_behind_a_treeline_and_reappear():
    trees = Occluder("treeline", [Vec3(-40, -60, 0), Vec3(40, -60, 0)], 15.0,
                     closed=False)
    model = OcclusionModel([trees])
    target = Vec3(0, 0, 0)
    low = Vec3(0, -140, 18)     # sight line passes through the canopy
    high = Vec3(0, -140, 90)    # sight line clears it
    assert model.occluded_by(low, target) == "treeline"
    assert model.is_visible(high, target)


def test_a_route_is_cut_where_it_passes_behind_an_object():
    """A line crossing behind a building breaks into two drawn runs (section 09)."""
    track = CameraTrack(INTR, 30.0, locked=False)
    track.set_keyframes([Keyframe(0, CameraPose(Vec3(0, -400, 40), 0.0, -6.0, 0.0))])
    track.locked = True
    model = OcclusionModel([
        Occluder("clubhouse", [Vec3(-10, -160, 0), Vec3(10, -160, 0),
                               Vec3(10, -140, 0), Vec3(-10, -140, 0)], 30.0)
    ])
    route = [Vec3(-100 + 5 * i, -150, 0) for i in range(41)]
    runs = model.split_visible_runs(track, route, 0)
    assert len(runs) == 2, "route should reappear on the far side of the building"
    hidden = set(range(len(route))) - {i for run in runs for i in run}
    assert hidden, "the middle of the route must be hidden"
    assert max(runs[0]) < min(hidden) <= max(hidden) < min(runs[1])


def test_terrain_ridge_blocks_the_line_of_sight():
    terrain = SampledTerrain([Vec3(-80, -60, 26), Vec3(80, -60, 26), Vec3(0, -60, 26),
                              Vec3(0, -200, 0), Vec3(0, 0, 0)])
    model = OcclusionModel([], terrain)
    assert model.occluded_by(Vec3(0, -200, 10), Vec3(0, 0, 0)) == "terrain"
    assert model.is_visible(Vec3(0, -200, 130), Vec3(0, 0, 0))
