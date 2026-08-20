"""Camera model and match move (sections 06, 07, 31)."""

import math
import random

import pytest

from matchmove.camera import (
    CameraPose,
    CameraTrack,
    Intrinsics,
    Keyframe,
    mat3_vec,
    rotation_from_ypr,
    ypr_from_rotation,
)
from matchmove.geo import Vec3
from matchmove.solve import (
    Correspondence,
    SolveError,
    drift_report,
    solve_frame,
    solve_track,
)

INTR = Intrinsics.from_fov(1920, 1080, 78.0)


def track_with(pose, fps=30.0):
    t = CameraTrack(INTR, fps, locked=False)
    t.set_keyframes([Keyframe(0, pose)])
    t.locked = True
    return t


def project_truth(pose, intr, p):
    cam = mat3_vec(pose.rotation(), p - pose.position)
    cx, cy = intr.principal
    return (intr.focal_px * cam.x / cam.z + cx, intr.focal_px * cam.y / cam.z + cy)


@pytest.mark.parametrize("ypr", [(0, -30, 0), (137, -22.5, 3), (359, -5, -12), (90, -80, 0)])
def test_orientation_round_trips(ypr):
    out = ypr_from_rotation(rotation_from_ypr(*ypr))
    assert out[0] == pytest.approx(ypr[0] % 360, abs=1e-6)
    assert out[1] == pytest.approx(ypr[1], abs=1e-6)
    assert out[2] == pytest.approx(ypr[2], abs=1e-6)


def test_image_axes_point_the_right_way():
    """+X right, +Y down: a point below the axis must land below centre."""
    tr = track_with(CameraPose(Vec3(0, -120, 80), 0, -30, 0))
    cx, cy = INTR.principal
    origin = tr.project(Vec3(0, 0, 0), 0)
    beyond = tr.project(Vec3(0, 60, 0), 0)
    east = tr.project(Vec3(40, 0, 0), 0)
    assert origin.x == pytest.approx(cx)
    assert origin.y > cy               # below the optical axis
    assert beyond.y < origin.y         # further away = higher in frame
    assert east.x > cx                 # east = right of frame


def test_projection_unprojection_round_trip():
    tr = track_with(CameraPose(Vec3(11, -130, 74), 6.0, -28.0, 1.2))
    p = Vec3(-18.0, 22.0, 0.0)
    pr = tr.project(p, 0)
    back = tr.ground_point(pr.x, pr.y, 0, z=0.0)
    assert back.x == pytest.approx(p.x, abs=1e-6)
    assert back.y == pytest.approx(p.y, abs=1e-6)


def test_points_behind_the_camera_are_not_drawn():
    tr = track_with(CameraPose(Vec3(0, -120, 80), 0, -30, 0))
    behind = tr.project(Vec3(0, -400, 0), 0)
    assert not behind.in_front
    assert not behind.visible


def test_depth_scaling_shrinks_with_distance():
    tr = track_with(CameraPose(Vec3(0, -200, 90), 0, -25, 0))
    near = tr.screen_scale(Vec3(0, -100, 0), 0)
    far = tr.screen_scale(Vec3(0, 0, 0), 0)
    assert near > far > 0


def test_solver_recovers_a_known_camera_from_noisy_anchors():
    rng = random.Random(3)
    truth = CameraPose(Vec3(15, -140, 95), 8.0, -27.0, 1.5)
    anchors = [Vec3(-30, 10, 0), Vec3(28, 6, 0), Vec3(-14, -70, 0),
               Vec3(35, -95, 0), Vec3(0, -40, 0), Vec3(-45, -120, 0)]
    cors = []
    for i, a in enumerate(anchors):
        x, y = project_truth(truth, INTR, a)
        cors.append(Correspondence(f"a{i}", a, x + rng.gauss(0, 0.4), y + rng.gauss(0, 0.4)))
    fs = solve_frame(0, cors, INTR)
    assert fs.rms_px < 1.0
    assert (fs.pose.position - truth.position).length() < 0.5
    assert fs.pose.yaw == pytest.approx(truth.yaw, abs=0.1)
    assert fs.pose.pitch == pytest.approx(truth.pitch, abs=0.1)


def test_solver_recovers_an_unknown_focal_length():
    truth = CameraPose(Vec3(0, -160, 100), 3.0, -30.0, 0.0)
    real = Intrinsics.from_fov(1920, 1080, 71.0)
    anchors = [Vec3(-40, 20, 0), Vec3(40, 15, 0), Vec3(-25, -80, 0),
               Vec3(30, -100, 0), Vec3(0, -50, 0), Vec3(-60, -140, 0)]
    cors = [Correspondence(f"a{i}", a, *project_truth(truth, real, a))
            for i, a in enumerate(anchors)]
    guess = Intrinsics.from_fov(1920, 1080, 84.0)   # wrong lens metadata
    fs = solve_frame(0, cors, guess, refine_focal=True)
    assert fs.intrinsics.focal_px == pytest.approx(real.focal_px, rel=0.02)
    assert fs.rms_px < 0.5


def test_four_anchors_are_the_minimum():
    a = [Vec3(0, 0, 0), Vec3(10, 0, 0), Vec3(10, 10, 0)]
    cors = [Correspondence(f"a{i}", p, 100 * i, 100 * i) for i, p in enumerate(a)]
    with pytest.raises(SolveError):
        solve_frame(0, cors, INTR)


def test_solved_track_is_stable_and_reports_no_drift():
    rng = random.Random(9)
    anchors = [Vec3(-30, 10, 0), Vec3(28, 6, 0), Vec3(-14, -70, 0),
               Vec3(35, -95, 0), Vec3(0, -40, 0)]
    cors = {}
    for i in range(8):
        t = i / 7
        pose = CameraPose(Vec3(2 * t, -220 + 150 * t, 110 - 45 * t), 4 * t, -22 - 8 * t, 0.0)
        cors[i * 20] = [
            Correspondence(f"a{j}", a,
                           *[v + rng.gauss(0, 0.3) for v in project_truth(pose, INTR, a)])
            for j, a in enumerate(anchors)
        ]
    track, solves = solve_track(cors, INTR, 30.0)
    assert track.solve_error_px < 1.0
    drift = drift_report(solves)
    assert drift and all(abs(v) < 0.02 for v in drift.values())


def test_a_locked_track_refuses_to_have_its_motion_rewritten():
    """Section 31: the original drone camera move is never altered."""
    tr = track_with(CameraPose(Vec3(0, -120, 80), 0, -30, 0))
    with pytest.raises(PermissionError):
        tr.set_keyframes([Keyframe(0, CameraPose(Vec3(50, 50, 50), 90, -10, 0))])


def test_track_interpolates_yaw_the_short_way_round():
    t = CameraTrack(INTR, 30.0, locked=False)
    t.set_keyframes([
        Keyframe(0, CameraPose(Vec3(0, 0, 50), 359.0, -30, 0)),
        Keyframe(10, CameraPose(Vec3(0, 0, 50), 3.0, -30, 0)),
    ])
    mid = t.pose_at(5).yaw % 360.0
    assert mid > 358.0 or mid < 2.0


def test_track_serialisation_round_trip():
    tr = track_with(CameraPose(Vec3(3, -90, 60), 12.0, -24.0, 0.5))
    again = CameraTrack.from_dict(tr.to_dict())
    a = tr.project(Vec3(0, 0, 0), 0)
    b = again.project(Vec3(0, 0, 0), 0)
    assert (a.x, a.y) == pytest.approx((b.x, b.y))
    assert again.locked
