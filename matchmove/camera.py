"""Drone camera model, camera track and world->screen projection.

Sections 06 (camera analysis), 07 (match move) and 08 (terrain-aware tracking).

Convention: camera looks down its local +Z axis; +X right, +Y down in image
space.  World is ENU (X east, Y north, Z up).  Rotation is built from the
drone-native yaw / pitch / roll triple:

* yaw   - compass heading of the optical axis, 0 = North, 90 = East
* pitch - negative looking down (a drone flying level with a -30 deg gimbal
          has pitch = -30)
* roll  - clockwise roll of the horizon, normally ~0 on a stabilised gimbal
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .geo import Vec3

Mat3 = Tuple[Tuple[float, float, float], ...]


def mat3_mul(a: Mat3, b: Mat3) -> Mat3:
    return tuple(
        tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3))
        for i in range(3)
    )


def mat3_vec(m: Mat3, v: Vec3) -> Vec3:
    t = v.as_tuple()
    return Vec3(*[sum(m[i][k] * t[k] for k in range(3)) for i in range(3)])


def mat3_transpose(m: Mat3) -> Mat3:
    return tuple(tuple(m[j][i] for j in range(3)) for i in range(3))


def mat3_inverse(m: Mat3) -> Mat3:
    a, b, c = m[0]
    d, e, f = m[1]
    g, h, i = m[2]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-15:
        raise ValueError("singular matrix")
    inv = (
        ((e * i - f * h), (c * h - b * i), (b * f - c * e)),
        ((f * g - d * i), (a * i - c * g), (c * d - a * f)),
        ((d * h - e * g), (b * g - a * h), (a * e - b * d)),
    )
    return tuple(tuple(x / det for x in row) for row in inv)


@dataclass(frozen=True)
class Intrinsics:
    """Pinhole intrinsics derived from sensor and focal length, or from FOV."""

    width: int
    height: int
    focal_px: float
    cx: Optional[float] = None
    cy: Optional[float] = None

    @property
    def principal(self) -> Tuple[float, float]:
        return (
            self.width / 2.0 if self.cx is None else self.cx,
            self.height / 2.0 if self.cy is None else self.cy,
        )

    @staticmethod
    def from_fov(width: int, height: int, hfov_deg: float) -> "Intrinsics":
        f = (width / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
        return Intrinsics(width, height, f)

    @staticmethod
    def from_sensor(
        width: int, height: int, focal_mm: float, sensor_width_mm: float
    ) -> "Intrinsics":
        return Intrinsics(width, height, focal_mm * width / sensor_width_mm)

    @property
    def hfov_deg(self) -> float:
        return math.degrees(2.0 * math.atan((self.width / 2.0) / self.focal_px))

    @property
    def vfov_deg(self) -> float:
        return math.degrees(2.0 * math.atan((self.height / 2.0) / self.focal_px))

    def matrix(self) -> Mat3:
        cx, cy = self.principal
        return (
            (self.focal_px, 0.0, cx),
            (0.0, self.focal_px, cy),
            (0.0, 0.0, 1.0),
        )

    def to_dict(self) -> Dict[str, float]:
        cx, cy = self.principal
        return {
            "width": self.width,
            "height": self.height,
            "focal_px": self.focal_px,
            "cx": cx,
            "cy": cy,
        }


def rotation_from_ypr(yaw_deg: float, pitch_deg: float, roll_deg: float) -> Mat3:
    """World->camera rotation for a drone gimbal orientation.

    Camera axes in world coordinates:
      forward = optical axis, right = image +X, down = image +Y.
    """
    y = math.radians(yaw_deg)
    p = math.radians(pitch_deg)
    r = math.radians(roll_deg)
    cy, sy = math.cos(y), math.sin(y)
    cp, sp = math.cos(p), math.sin(p)
    cr, sr = math.cos(r), math.sin(r)

    # Heading vector on the ground plane (yaw 0 = +North).
    forward = Vec3(sy * cp, cy * cp, sp)
    # Right vector, level with the horizon before roll.
    right0 = Vec3(cy, -sy, 0.0)
    down0 = forward.cross(right0).normalized()
    right = Vec3(
        right0.x * cr + down0.x * sr,
        right0.y * cr + down0.y * sr,
        right0.z * cr + down0.z * sr,
    )
    down = Vec3(
        -right0.x * sr + down0.x * cr,
        -right0.y * sr + down0.y * cr,
        -right0.z * sr + down0.z * cr,
    )
    # Rows of the world->camera rotation are the camera axes in world space.
    return (right.as_tuple(), down.as_tuple(), forward.normalized().as_tuple())


def ypr_from_rotation(m: Mat3) -> Tuple[float, float, float]:
    """Inverse of :func:`rotation_from_ypr` (yaw, pitch, roll in degrees)."""
    forward = Vec3(*m[2])
    right = Vec3(*m[0])
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, forward.z))))
    yaw = (math.degrees(math.atan2(forward.x, forward.y)) + 360.0) % 360.0
    y = math.radians(yaw)
    right0 = Vec3(math.cos(y), -math.sin(y), 0.0)
    down0 = forward.cross(right0).normalized()
    roll = math.degrees(math.atan2(right.dot(down0), right.dot(right0)))
    return yaw, pitch, roll


@dataclass(frozen=True)
class CameraPose:
    """Camera position and orientation at one instant."""

    position: Vec3
    yaw: float
    pitch: float
    roll: float = 0.0

    def rotation(self) -> Mat3:
        return rotation_from_ypr(self.yaw, self.pitch, self.roll)

    def forward(self) -> Vec3:
        return Vec3(*self.rotation()[2])


@dataclass(frozen=True)
class Projected:
    """Result of projecting a world point into the image."""

    x: float
    y: float
    depth: float          # metres along the optical axis
    in_front: bool
    in_frame: bool

    @property
    def visible(self) -> bool:
        return self.in_front and self.in_frame

    def as_tuple(self) -> Tuple[float, float]:
        return (self.x, self.y)


@dataclass(frozen=True)
class Keyframe:
    frame: int
    pose: CameraPose
    focal_px: Optional[float] = None   # overrides track intrinsics when set


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _lerp_angle(a: float, b: float, t: float) -> float:
    """Interpolate along the shortest arc so 359 -> 1 does not spin backwards."""
    d = ((b - a + 180.0) % 360.0) - 180.0
    return a + d * t


@dataclass
class CameraTrack:
    """A solved (or supplied) drone camera trajectory.

    The track is READ-ONLY ground truth (section 31): nothing downstream may
    modify the original footage's camera motion.  ``locked`` is enforced by
    :meth:`set_keyframes`.
    """

    intrinsics: Intrinsics
    fps: float = 30.0
    keyframes: List[Keyframe] = field(default_factory=list)
    source_footage: str = ""
    solve_error_px: Optional[float] = None
    locked: bool = True

    def set_keyframes(self, keyframes: Iterable[Keyframe]) -> None:
        if self.locked and self.keyframes:
            raise PermissionError(
                "camera track is locked: the original drone camera movement "
                "must never be altered (master prompt section 31)"
            )
        self.keyframes = sorted(keyframes, key=lambda k: k.frame)

    @property
    def frame_range(self) -> Tuple[int, int]:
        if not self.keyframes:
            return (0, 0)
        return (self.keyframes[0].frame, self.keyframes[-1].frame)

    @property
    def duration_s(self) -> float:
        a, b = self.frame_range
        return (b - a) / self.fps if self.fps else 0.0

    def pose_at(self, frame: float) -> CameraPose:
        if not self.keyframes:
            raise ValueError("camera track has no keyframes")
        kfs = self.keyframes
        if frame <= kfs[0].frame:
            return kfs[0].pose
        if frame >= kfs[-1].frame:
            return kfs[-1].pose
        for i in range(len(kfs) - 1):
            a, b = kfs[i], kfs[i + 1]
            if a.frame <= frame <= b.frame:
                span = b.frame - a.frame
                t = 0.0 if span == 0 else (frame - a.frame) / span
                return CameraPose(
                    position=Vec3(
                        _lerp(a.pose.position.x, b.pose.position.x, t),
                        _lerp(a.pose.position.y, b.pose.position.y, t),
                        _lerp(a.pose.position.z, b.pose.position.z, t),
                    ),
                    yaw=_lerp_angle(a.pose.yaw, b.pose.yaw, t),
                    pitch=_lerp(a.pose.pitch, b.pose.pitch, t),
                    roll=_lerp_angle(a.pose.roll, b.pose.roll, t),
                )
        return kfs[-1].pose

    def focal_at(self, frame: float) -> float:
        kfs = self.keyframes
        if not kfs:
            return self.intrinsics.focal_px
        explicit = [k for k in kfs if k.focal_px is not None]
        if not explicit:
            return self.intrinsics.focal_px
        if frame <= explicit[0].frame:
            return float(explicit[0].focal_px)
        if frame >= explicit[-1].frame:
            return float(explicit[-1].focal_px)
        for i in range(len(explicit) - 1):
            a, b = explicit[i], explicit[i + 1]
            if a.frame <= frame <= b.frame:
                span = b.frame - a.frame
                t = 0.0 if span == 0 else (frame - a.frame) / span
                return _lerp(float(a.focal_px), float(b.focal_px), t)
        return self.intrinsics.focal_px

    def intrinsics_at(self, frame: float) -> Intrinsics:
        f = self.focal_at(frame)
        if f == self.intrinsics.focal_px:
            return self.intrinsics
        cx, cy = self.intrinsics.principal
        return Intrinsics(self.intrinsics.width, self.intrinsics.height, f, cx, cy)

    # ------------------------------------------------------------ projection
    def project(self, point: Vec3, frame: float, margin_px: float = 0.0) -> Projected:
        pose = self.pose_at(frame)
        intr = self.intrinsics_at(frame)
        rel = point - pose.position
        cam = mat3_vec(pose.rotation(), rel)
        depth = cam.z
        if depth <= 1e-6:
            return Projected(math.nan, math.nan, depth, False, False)
        cx, cy = intr.principal
        x = intr.focal_px * cam.x / depth + cx
        y = intr.focal_px * cam.y / depth + cy
        in_frame = (
            -margin_px <= x <= intr.width + margin_px
            and -margin_px <= y <= intr.height + margin_px
        )
        return Projected(x, y, depth, True, in_frame)

    def project_many(
        self, points: Sequence[Vec3], frame: float, margin_px: float = 0.0
    ) -> List[Projected]:
        return [self.project(p, frame, margin_px) for p in points]

    def screen_scale(self, point: Vec3, frame: float, world_size: float = 1.0) -> float:
        """Pixels per ``world_size`` metres at ``point`` - depth scaling (s.08)."""
        p = self.project(point, frame)
        if not p.in_front:
            return 0.0
        return self.intrinsics_at(frame).focal_px * world_size / p.depth

    def ray_through_pixel(self, x: float, y: float, frame: float) -> Vec3:
        """Unit world-space direction of the ray through an image pixel."""
        pose = self.pose_at(frame)
        intr = self.intrinsics_at(frame)
        cx, cy = intr.principal
        cam = Vec3((x - cx) / intr.focal_px, (y - cy) / intr.focal_px, 1.0)
        return mat3_vec(mat3_transpose(pose.rotation()), cam).normalized()

    def ground_point(self, x: float, y: float, frame: float, z: float = 0.0) -> Optional[Vec3]:
        """Intersect the ray through a pixel with the horizontal plane at ``z``."""
        pose = self.pose_at(frame)
        d = self.ray_through_pixel(x, y, frame)
        if abs(d.z) < 1e-9:
            return None
        t = (z - pose.position.z) / d.z
        if t <= 0:
            return None
        return pose.position + d * t

    # ------------------------------------------------------------------ i/o
    def to_dict(self) -> Dict[str, object]:
        return {
            "intrinsics": self.intrinsics.to_dict(),
            "fps": self.fps,
            "source_footage": self.source_footage,
            "solve_error_px": self.solve_error_px,
            "keyframes": [
                {
                    "frame": k.frame,
                    "position": k.pose.position.as_tuple(),
                    "yaw": k.pose.yaw,
                    "pitch": k.pose.pitch,
                    "roll": k.pose.roll,
                    "focal_px": k.focal_px,
                }
                for k in self.keyframes
            ],
        }

    @staticmethod
    def from_dict(d: Dict) -> "CameraTrack":
        i = d["intrinsics"]
        track = CameraTrack(
            intrinsics=Intrinsics(
                int(i["width"]), int(i["height"]), float(i["focal_px"]),
                i.get("cx"), i.get("cy"),
            ),
            fps=float(d.get("fps", 30.0)),
            source_footage=d.get("source_footage", ""),
            solve_error_px=d.get("solve_error_px"),
            locked=False,
        )
        track.set_keyframes(
            Keyframe(
                frame=int(k["frame"]),
                pose=CameraPose(
                    Vec3.from_seq(k["position"]),
                    float(k["yaw"]), float(k["pitch"]), float(k.get("roll", 0.0)),
                ),
                focal_px=k.get("focal_px"),
            )
            for k in d.get("keyframes", [])
        )
        track.locked = True
        return track

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")

    @staticmethod
    def load(path: str | Path) -> "CameraTrack":
        return CameraTrack.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
