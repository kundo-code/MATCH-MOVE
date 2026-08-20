"""Occlusion: AR graphics disappear behind real objects (section 09).

Occluders are modelled as vertical prisms - a polygon footprint extruded to a
height (trees, tree lines, buildings) - or as terrain ridges.  A world point is
occluded when the segment from the camera to that point passes through an
occluder volume, or when the terrain itself rises above the line of sight.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from .camera import CameraTrack
from .geo import Vec3, point_in_polygon
from .spec import Feature, FeatureType
from .terrain import Terrain


def _segment_inside_intervals(a: Vec3, b: Vec3, poly: Sequence[Vec3]) -> List[Tuple[float, float]]:
    """Parameter intervals of segment a->b (in plan view) that lie inside ``poly``."""
    ts: List[float] = [0.0, 1.0]
    dx, dy = b.x - a.x, b.y - a.y
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        ex, ey = q.x - p.x, q.y - p.y
        denom = dx * ey - dy * ex
        if abs(denom) < 1e-12:
            continue
        t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / denom
        u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / denom
        if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
            ts.append(t)
    ts = sorted(set(round(t, 12) for t in ts))
    out: List[Tuple[float, float]] = []
    for t0, t1 in zip(ts, ts[1:]):
        if t1 - t0 < 1e-12:
            continue
        mid = (t0 + t1) / 2.0
        probe = Vec3(a.x + dx * mid, a.y + dy * mid, 0.0)
        if point_in_polygon(probe, poly):
            out.append((t0, t1))
    return out


@dataclass
class Occluder:
    """A physical object that hides graphics behind it."""

    id: str
    footprint: List[Vec3]
    height: float
    base_z: float = 0.0
    closed: bool = True
    radius: float = 0.0   # for a single-point occluder (a lone tree)

    @staticmethod
    def from_feature(f: Feature, default_height: float = 8.0) -> "Occluder":
        h = f.height if f.height > 0 else default_height
        base = min((p.z for p in f.points), default=0.0)
        radius = 0.0
        if f.type == FeatureType.TREE and len(f.points) == 1:
            radius = 4.0
        return Occluder(f.id, list(f.points), h, base, f.closed, radius)

    def _expanded(self) -> List[Vec3]:
        """Give a point/線 occluder physical width so it can actually occlude."""
        if self.radius <= 0 and len(self.footprint) >= 3:
            return self.footprint
        r = self.radius if self.radius > 0 else 2.0
        if len(self.footprint) == 1:
            c = self.footprint[0]
            return [
                Vec3(c.x + r * math.cos(2 * math.pi * i / 12),
                     c.y + r * math.sin(2 * math.pi * i / 12), c.z)
                for i in range(12)
            ]
        left: List[Vec3] = []
        right: List[Vec3] = []
        for i, p in enumerate(self.footprint):
            nxt = self.footprint[min(i + 1, len(self.footprint) - 1)]
            prv = self.footprint[max(i - 1, 0)]
            dx, dy = nxt.x - prv.x, nxt.y - prv.y
            n = math.hypot(dx, dy) or 1.0
            ox, oy = -dy / n * r, dx / n * r
            left.append(Vec3(p.x + ox, p.y + oy, p.z))
            right.append(Vec3(p.x - ox, p.y - oy, p.z))
        return left + list(reversed(right))

    def blocks(self, cam: Vec3, target: Vec3) -> bool:
        """True when the sight line from ``cam`` to ``target`` enters this volume.

        The footprint crossing is solved exactly rather than sampled: a thin
        tree line is only a couple of metres deep, and a sampled ray steps
        straight over it, which would silently drop the occlusion.
        """
        poly = self._expanded()
        if len(poly) < 3:
            return False
        top = self.base_z + self.height
        for t0, t1 in _segment_inside_intervals(cam, target, poly):
            z0 = cam.z + (target.z - cam.z) * t0
            z1 = cam.z + (target.z - cam.z) * t1
            if min(z0, z1) <= top and max(z0, z1) >= self.base_z:
                return True
        return False


class OcclusionModel:
    """Visibility test combining solid occluders and terrain line-of-sight."""

    def __init__(self, occluders: Sequence[Occluder] = (), terrain: Optional[Terrain] = None):
        self.occluders = list(occluders)
        self.terrain = terrain

    @staticmethod
    def from_features(features: Sequence[Feature], terrain: Optional[Terrain] = None) -> "OcclusionModel":
        from .spec import OCCLUDING_FEATURES

        return OcclusionModel(
            [Occluder.from_feature(f) for f in features if f.type in OCCLUDING_FEATURES],
            terrain,
        )

    def terrain_blocks(self, cam: Vec3, target: Vec3, samples: int = 40,
                       clearance: float = 0.3) -> bool:
        if self.terrain is None or not self.terrain.has_elevation_data:
            return False
        for i in range(1, samples):
            t = i / samples
            x = cam.x + (target.x - cam.x) * t
            y = cam.y + (target.y - cam.y) * t
            z = cam.z + (target.z - cam.z) * t
            if self.terrain.height(x, y) > z + clearance:
                return True
        return False

    def occluded_by(self, cam: Vec3, target: Vec3) -> Optional[str]:
        for o in self.occluders:
            if o.blocks(cam, target):
                return o.id
        if self.terrain_blocks(cam, target):
            return "terrain"
        return None

    def is_visible(self, cam: Vec3, target: Vec3) -> bool:
        return self.occluded_by(cam, target) is None

    def visibility_mask(self, track: CameraTrack, points: Sequence[Vec3],
                        frame: float) -> List[bool]:
        """Per-vertex visibility, used to cut a route line where it goes behind."""
        cam = track.pose_at(frame).position
        return [self.is_visible(cam, p) for p in points]

    def split_visible_runs(self, track: CameraTrack, points: Sequence[Vec3],
                           frame: float) -> List[List[int]]:
        """Contiguous runs of visible vertices - each becomes a drawn segment."""
        mask = self.visibility_mask(track, points, frame)
        runs: List[List[int]] = []
        current: List[int] = []
        for i, v in enumerate(mask):
            if v:
                current.append(i)
            elif current:
                runs.append(current)
                current = []
        if current:
            runs.append(current)
        return runs
