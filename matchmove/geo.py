"""WGS84 <-> local ENU conversion and golf-relevant distance helpers.

All internal geometry in this system is expressed in a right-handed local ENU
frame in metres:  +X = East, +Y = North, +Z = Up.
The datum (origin) of that frame is, by convention, the Green Center of the
hole being processed (see section 11/33 of the master prompt: the Green Center
is the standardised target for every hole).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence, Tuple

# WGS84
_A = 6378137.0
_F = 1.0 / 298.257223563
_E2 = _F * (2.0 - _F)

YARDS_PER_METRE = 1.0936132983377078


@dataclass(frozen=True)
class LatLon:
    lat: float
    lon: float
    alt: float = 0.0

    def as_tuple(self) -> Tuple[float, float, float]:
        return (self.lat, self.lon, self.alt)


@dataclass(frozen=True)
class Vec3:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def __add__(self, o: "Vec3") -> "Vec3":
        return Vec3(self.x + o.x, self.y + o.y, self.z + o.z)

    def __sub__(self, o: "Vec3") -> "Vec3":
        return Vec3(self.x - o.x, self.y - o.y, self.z - o.z)

    def __mul__(self, s: float) -> "Vec3":
        return Vec3(self.x * s, self.y * s, self.z * s)

    __rmul__ = __mul__

    def dot(self, o: "Vec3") -> float:
        return self.x * o.x + self.y * o.y + self.z * o.z

    def cross(self, o: "Vec3") -> "Vec3":
        return Vec3(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )

    def length(self) -> float:
        return math.sqrt(self.dot(self))

    def normalized(self) -> "Vec3":
        n = self.length()
        if n == 0.0:
            return Vec3(0.0, 0.0, 0.0)
        return Vec3(self.x / n, self.y / n, self.z / n)

    def as_tuple(self) -> Tuple[float, float, float]:
        return (self.x, self.y, self.z)

    @staticmethod
    def from_seq(seq: Sequence[float]) -> "Vec3":
        vals = list(seq) + [0.0, 0.0, 0.0]
        return Vec3(float(vals[0]), float(vals[1]), float(vals[2]))


def _prime_vertical(lat_rad: float) -> float:
    s = math.sin(lat_rad)
    return _A / math.sqrt(1.0 - _E2 * s * s)


def geodetic_to_ecef(p: LatLon) -> Vec3:
    lat = math.radians(p.lat)
    lon = math.radians(p.lon)
    n = _prime_vertical(lat)
    x = (n + p.alt) * math.cos(lat) * math.cos(lon)
    y = (n + p.alt) * math.cos(lat) * math.sin(lon)
    z = (n * (1.0 - _E2) + p.alt) * math.sin(lat)
    return Vec3(x, y, z)


def geodetic_to_enu(p: LatLon, datum: LatLon) -> Vec3:
    """Convert a WGS84 point to local ENU metres about ``datum``."""
    d = geodetic_to_ecef(p) - geodetic_to_ecef(datum)
    lat = math.radians(datum.lat)
    lon = math.radians(datum.lon)
    sl, cl = math.sin(lat), math.cos(lat)
    so, co = math.sin(lon), math.cos(lon)
    east = -so * d.x + co * d.y
    north = -sl * co * d.x - sl * so * d.y + cl * d.z
    up = cl * co * d.x + cl * so * d.y + sl * d.z
    return Vec3(east, north, up)


def enu_to_geodetic(v: Vec3, datum: LatLon) -> LatLon:
    lat = math.radians(datum.lat)
    lon = math.radians(datum.lon)
    sl, cl = math.sin(lat), math.cos(lat)
    so, co = math.sin(lon), math.cos(lon)
    dx = -so * v.x - sl * co * v.y + cl * co * v.z
    dy = co * v.x - sl * so * v.y + cl * so * v.z
    dz = cl * v.y + sl * v.z
    base = geodetic_to_ecef(datum)
    x, y, z = base.x + dx, base.y + dy, base.z + dz
    lon_out = math.atan2(y, x)
    p = math.hypot(x, y)
    lat_out = math.atan2(z, p * (1.0 - _E2))
    for _ in range(8):
        n = _prime_vertical(lat_out)
        alt = p / math.cos(lat_out) - n
        lat_out = math.atan2(z, p * (1.0 - _E2 * n / (n + alt)))
    n = _prime_vertical(lat_out)
    alt = p / math.cos(lat_out) - n
    return LatLon(math.degrees(lat_out), math.degrees(lon_out), alt)


def ground_distance(a: Vec3, b: Vec3) -> float:
    """Plan (map) distance in metres, ignoring elevation."""
    return math.hypot(b.x - a.x, b.y - a.y)


def slope_distance(a: Vec3, b: Vec3) -> float:
    return (b - a).length()


def bearing_deg(a: Vec3, b: Vec3) -> float:
    """Compass bearing from a to b (0 = North, 90 = East)."""
    return (math.degrees(math.atan2(b.x - a.x, b.y - a.y)) + 360.0) % 360.0


def metres_to_yards(m: float) -> float:
    return m * YARDS_PER_METRE


def yards_to_metres(y: float) -> float:
    return y / YARDS_PER_METRE


def polygon_centroid(points: Iterable[Vec3]) -> Vec3:
    """Area-weighted centroid of a planar polygon (XY), z averaged.

    Falls back to the vertex mean for degenerate (zero-area) input.
    """
    pts = list(points)
    if not pts:
        raise ValueError("polygon_centroid() requires at least one point")
    if len(pts) < 3:
        n = float(len(pts))
        return Vec3(
            sum(p.x for p in pts) / n,
            sum(p.y for p in pts) / n,
            sum(p.z for p in pts) / n,
        )
    a2 = 0.0
    cx = 0.0
    cy = 0.0
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        cross = p.x * q.y - q.x * p.y
        a2 += cross
        cx += (p.x + q.x) * cross
        cy += (p.y + q.y) * cross
    if abs(a2) < 1e-12:
        n = float(len(pts))
        return Vec3(
            sum(p.x for p in pts) / n,
            sum(p.y for p in pts) / n,
            sum(p.z for p in pts) / n,
        )
    area = a2 / 2.0
    z = sum(p.z for p in pts) / float(len(pts))
    return Vec3(cx / (6.0 * area), cy / (6.0 * area), z)


def polygon_area(points: Iterable[Vec3]) -> float:
    pts = list(points)
    if len(pts) < 3:
        return 0.0
    a2 = 0.0
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        a2 += p.x * q.y - q.x * p.y
    return abs(a2) / 2.0


def point_in_polygon(pt: Vec3, poly: Sequence[Vec3]) -> bool:
    inside = False
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        if (a.y > pt.y) != (b.y > pt.y):
            t = (pt.y - a.y) / (b.y - a.y)
            if pt.x < a.x + t * (b.x - a.x):
                inside = not inside
    return inside
