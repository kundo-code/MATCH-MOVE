"""Ground-plane match move: solve camera pose from anchor correspondences.

Section 05 (spatial anchor matching) + 07 (match move).  The operator marks
permanent anchor points - Green Center, tee box corners, bunker lips, cart
path junctions, building corners - in the drone frame, and states where those
anchors are in the world (from the course map / yardage book).  This module
turns those correspondences into a camera solve.

Pipeline per solved frame:
  1. normalised DLT homography  image <-> ground plane (z = anchor plane)
  2. decompose the homography into R, t using the known intrinsics
  3. Levenberg-Marquardt refinement of the 6 pose DOF (optionally focal)
     against the full 3D anchor set, minimising reprojection error

Nothing here modifies the footage; it only measures what the footage already
shows (section 31).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .camera import (
    CameraPose,
    CameraTrack,
    Intrinsics,
    Keyframe,
    Mat3,
    mat3_inverse,
    mat3_vec,
    ypr_from_rotation,
)
from .geo import Vec3


class SolveError(RuntimeError):
    pass


@dataclass(frozen=True)
class Correspondence:
    """One anchor seen at one pixel in one frame."""

    anchor_id: str
    world: Vec3
    x: float
    y: float
    weight: float = 1.0


@dataclass
class FrameSolve:
    frame: int
    pose: CameraPose
    intrinsics: Intrinsics
    rms_px: float
    max_px: float
    n_points: int
    residuals: Dict[str, float] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.rms_px < 2.0


# --------------------------------------------------------------- linear algebra
def _solve_linear(a: List[List[float]], b: List[float]) -> List[float]:
    """Gaussian elimination with partial pivoting."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-14:
            raise SolveError("singular normal equations (degenerate anchors?)")
        m[col], m[pivot] = m[pivot], m[col]
        pv = m[col][col]
        for r in range(n):
            if r == col:
                continue
            factor = m[r][col] / pv
            if factor == 0.0:
                continue
            for c in range(col, n + 1):
                m[r][c] -= factor * m[col][c]
    return [m[i][n] / m[i][i] for i in range(n)]


def _least_squares(rows: List[List[float]], rhs: List[float], damping: float = 0.0) -> List[float]:
    """Solve min |A x - b| through damped normal equations."""
    n = len(rows[0])
    ata = [[0.0] * n for _ in range(n)]
    atb = [0.0] * n
    for row, r in zip(rows, rhs):
        for i in range(n):
            atb[i] += row[i] * r
            for j in range(n):
                ata[i][j] += row[i] * row[j]
    if damping:
        for i in range(n):
            ata[i][i] += damping * (ata[i][i] if ata[i][i] > 1e-12 else 1.0)
    return _solve_linear(ata, atb)


# ------------------------------------------------------------------ homography
def _normalise(points: Sequence[Tuple[float, float]]):
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    mean_dist = sum(math.hypot(p[0] - mx, p[1] - my) for p in points) / n
    if mean_dist < 1e-12:
        raise SolveError("degenerate anchor configuration (all points coincide)")
    s = math.sqrt(2.0) / mean_dist
    t: Mat3 = ((s, 0.0, -s * mx), (0.0, s, -s * my), (0.0, 0.0, 1.0))
    out = [((p[0] - mx) * s, (p[1] - my) * s) for p in points]
    return out, t


def homography_from_points(
    world_xy: Sequence[Tuple[float, float]], image_xy: Sequence[Tuple[float, float]]
) -> Mat3:
    """Normalised DLT homography mapping ground plane -> image."""
    if len(world_xy) != len(image_xy):
        raise SolveError("correspondence count mismatch")
    if len(world_xy) < 4:
        raise SolveError("ground-plane solve needs at least 4 anchors")
    w_n, tw = _normalise(world_xy)
    i_n, ti = _normalise(image_xy)
    rows: List[List[float]] = []
    rhs: List[float] = []
    for (X, Y), (u, v) in zip(w_n, i_n):
        rows.append([X, Y, 1, 0, 0, 0, -u * X, -u * Y])
        rhs.append(u)
        rows.append([0, 0, 0, X, Y, 1, -v * X, -v * Y])
        rhs.append(v)
    h = _least_squares(rows, rhs)
    hn: Mat3 = ((h[0], h[1], h[2]), (h[3], h[4], h[5]), (h[6], h[7], 1.0))
    # De-normalise:  H = Ti^-1 * Hn * Tw
    from .camera import mat3_mul

    return mat3_mul(mat3_mul(mat3_inverse(ti), hn), tw)


def pose_from_homography(h: Mat3, intr: Intrinsics, plane_z: float = 0.0) -> CameraPose:
    """Decompose a ground-plane homography into a camera pose."""
    kinv = mat3_inverse(intr.matrix())
    from .camera import mat3_mul

    m = mat3_mul(kinv, h)
    c1 = Vec3(m[0][0], m[1][0], m[2][0])
    c2 = Vec3(m[0][1], m[1][1], m[2][1])
    c3 = Vec3(m[0][2], m[1][2], m[2][2])
    n1, n2 = c1.length(), c2.length()
    if n1 < 1e-12 or n2 < 1e-12:
        raise SolveError("degenerate homography")
    scale = 2.0 / (n1 + n2)
    r1 = c1 * scale
    r2 = c2 * scale
    t = c3 * scale
    if t.z < 0:  # camera must be in front of the plane
        r1, r2, t = r1 * -1.0, r2 * -1.0, t * -1.0
    # Gram-Schmidt orthonormalisation of r1, r2
    r1 = r1.normalized()
    r2 = (r2 - r1 * r1.dot(r2)).normalized()
    r3 = r1.cross(r2)
    # Columns r1,r2,r3 are world axes in camera space -> rows are camera axes
    # in world space.
    rot: Mat3 = (
        (r1.x, r2.x, r3.x),
        (r1.y, r2.y, r3.y),
        (r1.z, r2.z, r3.z),
    )
    yaw, pitch, roll = ypr_from_rotation(rot)
    # position = -R^T t, then lift back onto the true plane height
    pos = Vec3(
        -(rot[0][0] * t.x + rot[1][0] * t.y + rot[2][0] * t.z),
        -(rot[0][1] * t.x + rot[1][1] * t.y + rot[2][1] * t.z),
        -(rot[0][2] * t.x + rot[1][2] * t.y + rot[2][2] * t.z),
    )
    return CameraPose(Vec3(pos.x, pos.y, pos.z + plane_z), yaw, pitch, roll)


# ------------------------------------------------------------------ refinement
def _reproject(pose: CameraPose, intr: Intrinsics, p: Vec3) -> Optional[Tuple[float, float]]:
    rel = p - pose.position
    cam = mat3_vec(pose.rotation(), rel)
    if cam.z <= 1e-6:
        return None
    cx, cy = intr.principal
    return (intr.focal_px * cam.x / cam.z + cx, intr.focal_px * cam.y / cam.z + cy)


def reprojection_stats(
    pose: CameraPose, intr: Intrinsics, points: Sequence[Correspondence]
) -> Tuple[float, float, Dict[str, float]]:
    per: Dict[str, float] = {}
    total = 0.0
    worst = 0.0
    for c in points:
        pr = _reproject(pose, intr, c.world)
        if pr is None:
            err = float("inf")
        else:
            err = math.hypot(pr[0] - c.x, pr[1] - c.y)
        per[c.anchor_id] = err
        total += err * err
        worst = max(worst, err)
    rms = math.sqrt(total / len(points)) if points else 0.0
    return rms, worst, per


def refine_pose(
    pose: CameraPose,
    intr: Intrinsics,
    points: Sequence[Correspondence],
    *,
    refine_focal: bool = False,
    iterations: int = 60,
) -> Tuple[CameraPose, Intrinsics, float]:
    """Levenberg-Marquardt refinement of pose (and optionally focal length)."""
    params = [
        pose.position.x, pose.position.y, pose.position.z,
        pose.yaw, pose.pitch, pose.roll,
    ]
    if refine_focal:
        params.append(intr.focal_px)
    cx, cy = intr.principal

    def unpack(p: List[float]) -> Tuple[CameraPose, Intrinsics]:
        po = CameraPose(Vec3(p[0], p[1], p[2]), p[3], p[4], p[5])
        it = (
            Intrinsics(intr.width, intr.height, max(1.0, p[6]), cx, cy)
            if refine_focal
            else intr
        )
        return po, it

    def residuals(p: List[float]) -> List[float]:
        po, it = unpack(p)
        out: List[float] = []
        for c in points:
            pr = _reproject(po, it, c.world)
            if pr is None:
                out.extend([1e4, 1e4])
            else:
                out.append((pr[0] - c.x) * c.weight)
                out.append((pr[1] - c.y) * c.weight)
        return out

    def cost(p: List[float]) -> float:
        return sum(r * r for r in residuals(p))

    lam = 1e-3
    current = cost(params)
    steps = [0.05, 0.05, 0.05, 0.02, 0.02, 0.02, 0.5]
    for _ in range(iterations):
        base = residuals(params)
        jac: List[List[float]] = [[0.0] * len(params) for _ in base]
        for j in range(len(params)):
            trial = params[:]
            h = steps[j] if j < len(steps) else 0.05
            trial[j] += h
            pert = residuals(trial)
            for i in range(len(base)):
                jac[i][j] = (pert[i] - base[i]) / h
        try:
            delta = _least_squares(jac, [-r for r in base], damping=lam)
        except SolveError:
            break
        candidate = [params[j] + delta[j] for j in range(len(params))]
        cand_cost = cost(candidate)
        if cand_cost < current:
            improvement = current - cand_cost
            params, current = candidate, cand_cost
            lam = max(lam * 0.4, 1e-9)
            if improvement < 1e-9:
                break
        else:
            lam *= 6.0
            if lam > 1e7:
                break
    po, it = unpack(params)
    rms = math.sqrt(current / max(1, len(points) * 2))
    return po, it, rms


def solve_frame(
    frame: int,
    points: Sequence[Correspondence],
    intr: Intrinsics,
    *,
    plane_z: Optional[float] = None,
    refine_focal: bool = False,
    seed: Optional[CameraPose] = None,
) -> FrameSolve:
    """Solve one frame's camera from >= 4 anchor correspondences."""
    pts = list(points)
    if len(pts) < 4:
        raise SolveError(
            f"frame {frame}: {len(pts)} anchors supplied, at least 4 are required"
        )
    if plane_z is None:
        plane_z = sum(p.world.z for p in pts) / len(pts)
    pose = seed
    if pose is None:
        h = homography_from_points(
            [(p.world.x, p.world.y) for p in pts], [(p.x, p.y) for p in pts]
        )
        pose = pose_from_homography(h, intr, plane_z=plane_z)
    pose, intr_out, _ = refine_pose(pose, intr, pts, refine_focal=refine_focal)
    rms, worst, per = reprojection_stats(pose, intr_out, pts)
    return FrameSolve(frame, pose, intr_out, rms, worst, len(pts), per)


def solve_track(
    correspondences: Dict[int, Sequence[Correspondence]],
    intr: Intrinsics,
    fps: float = 30.0,
    *,
    source_footage: str = "",
    refine_focal: bool = False,
) -> Tuple[CameraTrack, List[FrameSolve]]:
    """Solve every supplied frame and build a locked CameraTrack.

    Each frame is seeded from the previous solve, which keeps the solution
    temporally coherent and is what stops markers from crawling between
    frames (section 07: no drift, no sliding).
    """
    if not correspondences:
        raise SolveError("no correspondences supplied")
    solves: List[FrameSolve] = []
    seed: Optional[CameraPose] = None
    for frame in sorted(correspondences):
        fs = solve_frame(
            frame, correspondences[frame], intr,
            refine_focal=refine_focal, seed=seed,
        )
        solves.append(fs)
        seed = fs.pose
    track = CameraTrack(
        intrinsics=solves[0].intrinsics,
        fps=fps,
        source_footage=source_footage,
        solve_error_px=max(s.rms_px for s in solves),
        locked=False,
    )
    track.set_keyframes(
        Keyframe(s.frame, s.pose, focal_px=s.intrinsics.focal_px) for s in solves
    )
    track.locked = True
    return track, solves


def drift_report(solves: Sequence[FrameSolve]) -> Dict[str, float]:
    """Per-anchor residual trend - a rising trend means the solve is drifting."""
    if len(solves) < 2:
        return {}
    out: Dict[str, float] = {}
    ids = set()
    for s in solves:
        ids.update(s.residuals)
    for anchor in sorted(ids):
        series = [(s.frame, s.residuals[anchor]) for s in solves if anchor in s.residuals]
        if len(series) < 2:
            continue
        n = len(series)
        mean_f = sum(f for f, _ in series) / n
        mean_r = sum(r for _, r in series) / n
        num = sum((f - mean_f) * (r - mean_r) for f, r in series)
        den = sum((f - mean_f) ** 2 for f, _ in series)
        out[anchor] = 0.0 if den == 0 else num / den  # px drift per frame
    return out
