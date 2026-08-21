"""Terrain model and terrain conforming for ground graphics (section 08).

Graphics placed on the ground must sit *on* the ground - following fairway
undulation, bunker depth and green surface - rather than floating as flat
stickers over the image.  A :class:`Terrain` samples height at any (x, y):

* ``FlatTerrain``    - the honest default when no elevation data was supplied
* ``SampledTerrain`` - inverse-distance interpolation over surveyed spot heights
  (from GPS course data, a green map, or drone photogrammetry)

When no elevation data exists the system says so instead of inventing
undulation: ``Terrain.has_elevation_data`` is False and validation reports it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional, Sequence

from .confidence import Confidence, Source
from .geo import Vec3


class Terrain:
    has_elevation_data: bool = False
    source: Source = Source.ESTIMATE
    confidence: Confidence = Confidence.ESTIMATED

    def height(self, x: float, y: float) -> float:  # pragma: no cover - interface
        raise NotImplementedError

    def point_on(self, x: float, y: float, offset: float = 0.0) -> Vec3:
        return Vec3(x, y, self.height(x, y) + offset)

    def conform(self, points: Sequence[Vec3], offset: float = 0.0) -> List[Vec3]:
        """Snap points onto the terrain surface."""
        return [self.point_on(p.x, p.y, offset) for p in points]

    def normal(self, x: float, y: float, eps: float = 1.0) -> Vec3:
        hx = (self.height(x + eps, y) - self.height(x - eps, y)) / (2 * eps)
        hy = (self.height(x, y + eps) - self.height(x, y - eps)) / (2 * eps)
        return Vec3(-hx, -hy, 1.0).normalized()

    def slope_percent(self, x: float, y: float, eps: float = 1.0) -> float:
        hx = (self.height(x + eps, y) - self.height(x - eps, y)) / (2 * eps)
        hy = (self.height(x, y + eps) - self.height(x, y - eps)) / (2 * eps)
        return math.hypot(hx, hy) * 100.0

    def fall_direction(self, x: float, y: float, eps: float = 1.0) -> Optional[float]:
        """Compass bearing the surface falls toward, or None if effectively level."""
        hx = (self.height(x + eps, y) - self.height(x - eps, y)) / (2 * eps)
        hy = (self.height(x, y + eps) - self.height(x, y - eps)) / (2 * eps)
        if math.hypot(hx, hy) < 1e-6:
            return None
        return (math.degrees(math.atan2(-hx, -hy)) + 360.0) % 360.0


@dataclass
class FlatTerrain(Terrain):
    """Level reference plane. Used when no elevation data was supplied."""

    z: float = 0.0
    has_elevation_data: bool = False

    def height(self, x: float, y: float) -> float:
        return self.z


@dataclass
class SampledTerrain(Terrain):
    """Inverse-distance-weighted surface through surveyed spot heights."""

    samples: List[Vec3] = field(default_factory=list)
    power: float = 2.0
    smoothing: float = 1.0
    source: Source = Source.OFFICIAL
    confidence: Confidence = Confidence.CONFIRMED
    fallback_z: float = 0.0

    def __post_init__(self) -> None:
        self.has_elevation_data = len(self.samples) >= 3

    def height(self, x: float, y: float) -> float:
        if not self.samples:
            return self.fallback_z
        num = 0.0
        den = 0.0
        for s in self.samples:
            d2 = (s.x - x) ** 2 + (s.y - y) ** 2
            if d2 < 1e-9:
                return s.z
            w = 1.0 / ((d2 + self.smoothing) ** (self.power / 2.0))
            num += w * s.z
            den += w
        return num / den if den else self.fallback_z


def resample_polyline(points: Sequence[Vec3], spacing: float = 2.0) -> List[Vec3]:
    """Densify a polyline so terrain conforming has enough samples to follow.

    Densifying only adds points along the supplied path - it never changes the
    path's shape (section 31).
    """
    pts = list(points)
    if len(pts) < 2 or spacing <= 0:
        return pts
    out: List[Vec3] = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        seg = b - a
        length = math.hypot(seg.x, seg.y)
        steps = max(1, int(math.ceil(length / spacing)))
        for i in range(1, steps + 1):
            t = i / steps
            out.append(Vec3(a.x + seg.x * t, a.y + seg.y * t, a.z + seg.z * t))
    return out


def smooth_polyline(points: Sequence[Vec3], iterations: int = 2) -> List[Vec3]:
    """Chaikin-style corner rounding for route lines - endpoints preserved."""
    pts = list(points)
    for _ in range(max(0, iterations)):
        if len(pts) < 3:
            break
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out.append(Vec3(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25,
                            a.z * 0.75 + b.z * 0.25))
            out.append(Vec3(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75,
                            a.z * 0.25 + b.z * 0.75))
        out.append(pts[-1])
        pts = out
    return pts


def ellipse(center: Vec3, radius_a: float, radius_b: float, rotation_deg: float,
            segments: int = 48) -> List[Vec3]:
    """Terrain-conforming landing-zone ellipse footprint (section 16)."""
    r = math.radians(rotation_deg)
    cr, sr = math.cos(r), math.sin(r)
    out: List[Vec3] = []
    for i in range(segments):
        t = 2.0 * math.pi * i / segments
        ux, uy = radius_a * math.cos(t), radius_b * math.sin(t)
        out.append(Vec3(center.x + ux * cr - uy * sr, center.y + ux * sr + uy * cr,
                        center.z))
    return out
