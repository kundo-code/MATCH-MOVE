"""The HoleSpec: everything the system knows about one golf hole.

A HoleSpec is the single source of truth handed to the tracker, the overlay
compositor, the sequencer and the prompt renderer.  It carries geometry in the
local ENU frame (metres, origin = Green Center) and scalar course data as
provenance-tagged :class:`~matchmove.confidence.Fact` objects.

Sections implemented here: 04 (feature recognition), 10 (hole information),
11-13 (standardised Green Center target), 35 (input data template).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .confidence import Confidence, Fact, FactKind, FactSet, Source
from .geo import LatLon, Vec3, geodetic_to_enu, ground_distance, polygon_centroid

#: Labels that must never be attached to the standardised target (section 12).
FORBIDDEN_TARGET_LABELS = {"PIN", "HOLE CUP", "HOLECUP", "CUP", "FLAGSTICK", "핀", "홀컵"}

#: The one label the standardised target may carry.
TARGET_LABEL = "GREEN CENTER"
TARGET_LABEL_SHORT = "CENTER"


class FeatureType(str, Enum):
    """Section 04 course features."""

    TEE_BOX = "tee_box"
    FAIRWAY = "fairway"
    FIRST_CUT = "first_cut"
    ROUGH = "rough"
    DEEP_ROUGH = "deep_rough"
    GREEN = "green"
    FRINGE = "fringe"
    BUNKER = "bunker"
    WATER = "water"
    PENALTY_AREA_RED = "penalty_area_red"
    PENALTY_AREA_YELLOW = "penalty_area_yellow"
    OUT_OF_BOUNDS = "out_of_bounds"
    CART_PATH = "cart_path"
    TREE = "tree"
    TREE_LINE = "tree_line"
    BUILDING = "building"
    TERRAIN_RIDGE = "terrain_ridge"
    LANDMARK = "landmark"
    LANDING_ZONE = "landing_zone"


#: Feature types whose very existence is a rules classification and therefore
#: requires CONFIRMED data (sections 19, 20).
CLASSIFICATION_FEATURES = {
    FeatureType.PENALTY_AREA_RED,
    FeatureType.PENALTY_AREA_YELLOW,
    FeatureType.OUT_OF_BOUNDS,
}

#: Feature types that occlude AR graphics (section 09).
OCCLUDING_FEATURES = {
    FeatureType.TREE,
    FeatureType.TREE_LINE,
    FeatureType.BUILDING,
    FeatureType.TERRAIN_RIDGE,
}


class TeeColor(str, Enum):
    BLACK = "black"
    BLUE = "blue"
    WHITE = "white"
    RED = "red"
    GOLD = "gold"


@dataclass
class Feature:
    """A real, physical thing on the golf hole, located in ENU metres.

    ``points`` is a polygon (closed area) or polyline (path / boundary line).
    Geometry is never invented: a feature must name the source it was traced
    from, and section 31 forbids editing it downstream.
    """

    id: str
    type: FeatureType
    points: List[Vec3]
    source: Source
    confidence: Confidence
    name: str = ""
    closed: bool = True
    height: float = 0.0            # occluder height above ground, metres
    label: str = ""                # on-screen label, may be blank
    note: str = ""
    corroborated_by: Sequence[Source] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        kind = (
            FactKind.HAZARD_CLASS
            if self.type in CLASSIFICATION_FEATURES
            else FactKind.GEOMETRY
        )
        self._fact = Fact(
            field=f"feature:{self.id}",
            value=self.id,
            kind=kind,
            source=self.source,
            confidence=self.confidence,
            note=self.note,
            corroborated_by=tuple(self.corroborated_by),
        )
        # A source cannot certify itself above its ceiling; mirror the clamp.
        self.confidence = self._fact.confidence

    @property
    def fact(self) -> Fact:
        return self._fact

    @property
    def displayable(self) -> bool:
        return self._fact.displayable

    def centroid(self) -> Vec3:
        return polygon_centroid(self.points)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type.value,
            "name": self.name,
            "points": [p.as_tuple() for p in self.points],
            "closed": self.closed,
            "height": self.height,
            "label": self.label,
            "source": self.source.value,
            "confidence": self.confidence.value,
            "note": self.note,
            "corroborated_by": [s.value for s in self.corroborated_by],
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Feature":
        return Feature(
            id=d["id"],
            type=FeatureType(d["type"]),
            points=[Vec3.from_seq(p) for p in d.get("points", [])],
            source=Source(d["source"]),
            confidence=Confidence(d.get("confidence", "C")),
            name=d.get("name", ""),
            closed=d.get("closed", True),
            height=float(d.get("height", 0.0)),
            label=d.get("label", ""),
            note=d.get("note", ""),
            corroborated_by=tuple(Source(s) for s in d.get("corroborated_by", [])),
        )


@dataclass
class TeeDistance:
    """A tee's published length. Distances are CONFIRMED-only data."""

    color: TeeColor
    metres: Optional[float] = None
    yards: Optional[float] = None
    source: Source = Source.YARDAGE_BOOK
    confidence: Confidence = Confidence.CONFIRMED

    def fact(self) -> Fact:
        return Fact(
            field=f"tee:{self.color.value}",
            value=self.metres,
            kind=FactKind.DISTANCE,
            source=self.source,
            confidence=self.confidence,
        )


class TargetLabelError(ValueError):
    """Raised when something tries to label the standard target as a pin."""


@dataclass
class HoleSpec:
    """One hole, fully described.

    ``datum`` is the WGS84 position of the Green Center and the origin of the
    local ENU frame, so the Green Center is literally the coordinate origin of
    every hole in the series (sections 11, 33).
    """

    course_name: str
    hole_number: int
    par: Optional[int] = None
    datum: Optional[LatLon] = None
    features: List[Feature] = field(default_factory=list)
    facts: FactSet = field(default_factory=FactSet)
    tees: List[TeeDistance] = field(default_factory=list)
    primary_tee: Optional[TeeColor] = None
    green_center_override: Optional[Vec3] = None
    strategy_route: List[Vec3] = field(default_factory=list)
    route_source: Source = Source.ESTIMATE
    route_confidence: Confidence = Confidence.ESTIMATED
    footage_id: str = ""
    notes: str = ""

    # ---------------------------------------------------------------- lookup
    def features_of(self, *types: FeatureType) -> List[Feature]:
        wanted = set(types)
        return [f for f in self.features if f.type in wanted]

    def feature(self, feature_id: str) -> Optional[Feature]:
        for f in self.features:
            if f.id == feature_id:
                return f
        return None

    def green(self) -> Optional[Feature]:
        greens = self.features_of(FeatureType.GREEN)
        return greens[0] if greens else None

    def occluders(self) -> List[Feature]:
        return [f for f in self.features if f.type in OCCLUDING_FEATURES]

    # --------------------------------------------------------- green center
    def green_center(self) -> Optional[Vec3]:
        """Section 12: geometric centre of the actual putting surface.

        Returns None when no green geometry was supplied - the system will not
        guess where a green is.
        """
        if self.green_center_override is not None:
            return self.green_center_override
        g = self.green()
        if g is None or len(g.points) < 3:
            return None
        return g.centroid()

    def target(self) -> Optional[Vec3]:
        """The standardised target for this hole. Always the Green Center."""
        return self.green_center()

    @staticmethod
    def assert_target_label(label: str) -> str:
        """Guard for section 12: the target is never called a pin or hole cup."""
        normalized = label.strip().upper().replace("-", " ")
        if normalized in FORBIDDEN_TARGET_LABELS:
            raise TargetLabelError(
                f"'{label}' is forbidden for the standardised target. "
                f"Use '{TARGET_LABEL}' or '{TARGET_LABEL_SHORT}' - the marker is a "
                "standard analysis target, not the daily hole-cup location."
            )
        return label

    def primary_tee_position(self) -> Optional[Vec3]:
        tees = self.features_of(FeatureType.TEE_BOX)
        if not tees:
            return None
        if self.primary_tee is not None:
            for t in tees:
                if t.name.lower() == self.primary_tee.value:
                    return t.centroid()
        return tees[0].centroid()

    def tee_distance(self, color: Optional[TeeColor] = None) -> Optional[float]:
        """Published tee->green distance in metres, only if CONFIRMED."""
        color = color or self.primary_tee
        for t in self.tees:
            if color is None or t.color == color:
                f = t.fact()
                if f.displayable:
                    return t.metres
        return None

    def measured_distance(self, a: Vec3, b: Vec3) -> float:
        """Geometry-derived plan distance. NEVER displayed as course data.

        Used internally for placing graphics and pacing the sequence; section
        14/32 forbid presenting a measured number as a published yardage.
        """
        return ground_distance(a, b)

    # ------------------------------------------------------------- geo input
    def enu(self, point: LatLon) -> Vec3:
        if self.datum is None:
            raise ValueError("HoleSpec.datum must be set to convert lat/lon")
        return geodetic_to_enu(point, self.datum)

    # ------------------------------------------------------------------ i/o
    def to_dict(self) -> Dict[str, Any]:
        return {
            "course_name": self.course_name,
            "hole_number": self.hole_number,
            "par": self.par,
            "datum": None if self.datum is None else list(self.datum.as_tuple()),
            "features": [f.to_dict() for f in self.features],
            "facts": self.facts.to_list(),
            "tees": [
                {
                    "color": t.color.value,
                    "metres": t.metres,
                    "yards": t.yards,
                    "source": t.source.value,
                    "confidence": t.confidence.value,
                }
                for t in self.tees
            ],
            "primary_tee": None if self.primary_tee is None else self.primary_tee.value,
            "green_center_override": (
                None
                if self.green_center_override is None
                else list(self.green_center_override.as_tuple())
            ),
            "strategy_route": [p.as_tuple() for p in self.strategy_route],
            "route_source": self.route_source.value,
            "route_confidence": self.route_confidence.value,
            "footage_id": self.footage_id,
            "notes": self.notes,
        }

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "HoleSpec":
        datum = d.get("datum")
        override = d.get("green_center_override")
        return HoleSpec(
            course_name=d.get("course_name", ""),
            hole_number=int(d.get("hole_number", 0)),
            par=d.get("par"),
            datum=None if not datum else LatLon(*datum),
            features=[Feature.from_dict(f) for f in d.get("features", [])],
            facts=FactSet.from_list(d.get("facts", [])),
            tees=[
                TeeDistance(
                    color=TeeColor(t["color"]),
                    metres=t.get("metres"),
                    yards=t.get("yards"),
                    source=Source(t.get("source", "yardage_book")),
                    confidence=Confidence(t.get("confidence", "A")),
                )
                for t in d.get("tees", [])
            ],
            primary_tee=(
                TeeColor(d["primary_tee"]) if d.get("primary_tee") else None
            ),
            green_center_override=None if not override else Vec3.from_seq(override),
            strategy_route=[Vec3.from_seq(p) for p in d.get("strategy_route", [])],
            route_source=Source(d.get("route_source", "estimate")),
            route_confidence=Confidence(d.get("route_confidence", "C")),
            footage_id=d.get("footage_id", ""),
            notes=d.get("notes", ""),
        )

    def save(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps(self.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8"
        )

    @staticmethod
    def load(path: str | Path) -> "HoleSpec":
        return HoleSpec.from_dict(
            json.loads(Path(path).read_text(encoding="utf-8"))
        )


def facts_from_template(entries: Iterable[Dict[str, Any]]) -> FactSet:
    """Build a FactSet from the section 35 input template rows."""
    return FactSet.from_list(entries)
