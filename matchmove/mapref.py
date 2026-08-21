"""Georeference a course-map capture so features can be traced off it.

Section 01B / 05: the Kakao (or satellite) capture is where hole geometry gets
traced from, but a screenshot has no coordinate system.  Give this module a
few landmarks whose real position you know - the Green Center, a tee, a bunker
the yardage book locates, a cart-path junction - and it fits the transform from
map pixels to the hole's ENU frame.  After that, clicking a feature outline on
the capture yields real metres.

Two models:

* **similarity** (2+ landmarks) - rotation, uniform scale, translation, and the
  image-Y flip.  Correct for a north-up map capture at a single zoom.
* **affine** (3+ landmarks) - additionally absorbs mild anisotropic scaling,
  which a tilted or slightly stretched capture will have.

The fit reports its own residuals in metres.  A georeference that does not fit
its own landmarks is not trustworthy enough to trace from, and
:meth:`MapReference.check` says so rather than letting bad geometry through.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Sequence, Tuple

from .confidence import Confidence, Source
from .geo import LatLon, Vec3, geodetic_to_enu
from .solve import SolveError, _least_squares
from .spec import Feature, FeatureType


@dataclass(frozen=True)
class MapLandmark:
    """A point identifiable both on the map capture and in the world."""

    name: str
    px: Tuple[float, float]
    world: Vec3

    @staticmethod
    def from_latlon(name: str, px: Tuple[float, float], point: LatLon,
                    datum: LatLon) -> "MapLandmark":
        return MapLandmark(name, px, geodetic_to_enu(point, datum))


@dataclass
class MapReference:
    """Affine map: image pixels -> ENU metres.

    ``coeffs`` is ``(a, b, tx, c, d, ty)`` with
    ``X = a*x + b*y + tx`` and ``Y = c*x + d*y + ty``.
    """

    coeffs: Tuple[float, float, float, float, float, float]
    model: str
    landmarks: List[MapLandmark]
    rms_m: float
    max_m: float

    # ------------------------------------------------------------- transform
    def to_world(self, x: float, y: float, z: float = 0.0) -> Vec3:
        a, b, tx, c, d, ty = self.coeffs
        return Vec3(a * x + b * y + tx, c * x + d * y + ty, z)

    def trace(self, points: Sequence[Tuple[float, float]], z: float = 0.0) -> List[Vec3]:
        """Convert a traced outline of map pixels into world metres."""
        return [self.to_world(px, py, z) for px, py in points]

    def feature(
        self,
        feature_id: str,
        feature_type: FeatureType,
        points: Sequence[Tuple[float, float]],
        *,
        source: Source = Source.COURSE_MAP,
        confidence: Confidence = Confidence.VISUALLY_MATCHED,
        z: float = 0.0,
        **kwargs,
    ) -> Feature:
        """Build a Feature straight from an outline traced on the capture.

        The default provenance is the course map at grade B, which is what a
        traced outline actually is.  Claiming more requires a better source
        (section 03), and the confidence gate will clamp an overclaim anyway.
        """
        return Feature(
            id=feature_id,
            type=feature_type,
            points=self.trace(points, z),
            source=source,
            confidence=confidence,
            **kwargs,
        )

    @property
    def metres_per_pixel(self) -> float:
        a, b, _, c, d, _ = self.coeffs
        return math.sqrt(abs(a * d - b * c))

    @property
    def rotation_deg(self) -> float:
        """Compass bearing that map-image 'up' points to.

        0 on a north-up capture; a capture rotated clockwise by t degrees
        reports 360 - t.
        """
        _, b, _, _, d, _ = self.coeffs
        return (math.degrees(math.atan2(-b, -d)) + 360.0) % 360.0

    # ---------------------------------------------------------------- quality
    def residuals(self) -> List[Tuple[str, float]]:
        out = []
        for lm in self.landmarks:
            p = self.to_world(*lm.px)
            out.append((lm.name, math.hypot(p.x - lm.world.x, p.y - lm.world.y)))
        return out

    def check(self, tolerance_m: float = 3.0) -> Tuple[bool, str]:
        """Is this georeference good enough to trace hole geometry from?"""
        if self.max_m <= tolerance_m:
            return True, (
                f"{self.model} fit over {len(self.landmarks)} landmarks: "
                f"RMS {self.rms_m:.2f}m, worst {self.max_m:.2f}m, "
                f"{self.metres_per_pixel:.3f} m/px"
            )
        # Least squares spreads a bad landmark's error across all of them, so
        # list every residual and let the operator spot the odd one out.
        detail = ", ".join(f"{n} {e:.2f}m" for n, e in self.residuals())
        return False, (
            f"{self.model} fit is off by {self.max_m:.2f}m (limit {tolerance_m:.1f}m). "
            f"Residuals: {detail}. Re-check the landmarks or add more - "
            "do not trace geometry from a georeference this loose"
        )


def fit_map_reference(
    landmarks: Sequence[MapLandmark], model: str = "auto"
) -> MapReference:
    """Fit the pixel -> metre transform from known landmarks.

    ``model`` is ``"similarity"``, ``"affine"``, or ``"auto"`` (affine when
    there are 3 or more landmarks, similarity otherwise).
    """
    lms = list(landmarks)
    if len(lms) < 2:
        raise SolveError(
            "georeferencing a map capture needs at least 2 landmarks whose real "
            "position is known (3 or more for an affine fit)"
        )
    if model == "auto":
        model = "affine" if len(lms) >= 3 else "similarity"

    if model == "similarity":
        # Rotation + uniform scale on image coords with Y flipped (v = -y):
        #   X = a*x + b*y + tx
        #   Y = b*x - a*y + ty          where a = s*cos(t), b = s*sin(t)
        rows: List[List[float]] = []
        rhs: List[float] = []
        for lm in lms:
            x, y = lm.px
            rows.append([x, y, 1.0, 0.0])      # coefficients of (a, b, tx, ty)
            rhs.append(lm.world.x)
            rows.append([-y, x, 0.0, 1.0])
            rhs.append(lm.world.y)
        a, b, tx, ty = _least_squares(rows, rhs)
        coeffs = (a, b, tx, b, -a, ty)
    elif model == "affine":
        if len(lms) < 3:
            raise SolveError("an affine map reference needs at least 3 landmarks")
        rows_x: List[List[float]] = []
        rhs_x: List[float] = []
        rows_y: List[List[float]] = []
        rhs_y: List[float] = []
        for lm in lms:
            x, y = lm.px
            rows_x.append([x, y, 1.0])
            rhs_x.append(lm.world.x)
            rows_y.append([x, y, 1.0])
            rhs_y.append(lm.world.y)
        a, b, tx = _least_squares(rows_x, rhs_x)
        c, d, ty = _least_squares(rows_y, rhs_y)
        coeffs = (a, b, tx, c, d, ty)
    else:
        raise SolveError(f"unknown map model '{model}'")

    ref = MapReference(coeffs, model, lms, 0.0, 0.0)
    errs = [e for _, e in ref.residuals()]
    ref.rms_m = math.sqrt(sum(e * e for e in errs) / len(errs))
    ref.max_m = max(errs)
    return ref
