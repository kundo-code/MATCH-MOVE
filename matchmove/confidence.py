"""Source priority, confidence grading and the anti-hallucination gate.

This module implements sections 02, 03 and 32 of the master prompt:

* 02 SOURCE PRIORITY  - official > yardage book > course map > drone > estimate
* 03 DATA CONFIDENCE  - A CONFIRMED / B VISUALLY MATCHED / C ESTIMATED
* 32 ANTI-HALLUCINATION - when reliable information is unavailable, OMIT IT.

Every fact that reaches the screen passes through :class:`Fact`, and every
:class:`Fact` knows where it came from.  A fact that cannot name a source
cannot be rendered - that is the whole point of the design.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Iterable, List, Optional, Sequence


class Source(str, Enum):
    """Reference material a fact was extracted from, in priority order."""

    OFFICIAL = "official"       # official course data, scorecard, GPS data, green map
    YARDAGE_BOOK = "yardage_book"
    COURSE_MAP = "course_map"   # Kakao map / satellite capture / official course map
    DRONE = "drone"             # drone footage or still
    ESTIMATE = "estimate"       # visual estimation only

    @property
    def priority(self) -> int:
        """Lower number wins a conflict (section 02)."""
        return _SOURCE_PRIORITY[self]


_SOURCE_PRIORITY: Dict[Source, int] = {
    Source.OFFICIAL: 1,
    Source.YARDAGE_BOOK: 2,
    Source.COURSE_MAP: 3,
    Source.DRONE: 4,
    Source.ESTIMATE: 5,
}


class Confidence(str, Enum):
    """Section 03 data confidence grades."""

    CONFIRMED = "A"          # official data or reliable yardage-book data
    VISUALLY_MATCHED = "B"   # map <-> yardage book <-> drone correspondence
    ESTIMATED = "C"          # visual inference only

    @property
    def rank(self) -> int:
        return {"A": 3, "B": 2, "C": 1}[self.value]

    def __ge__(self, other: "Confidence") -> bool:  # type: ignore[override]
        return self.rank >= other.rank

    def __gt__(self, other: "Confidence") -> bool:  # type: ignore[override]
        return self.rank > other.rank

    def __le__(self, other: "Confidence") -> bool:  # type: ignore[override]
        return self.rank <= other.rank

    def __lt__(self, other: "Confidence") -> bool:  # type: ignore[override]
        return self.rank < other.rank


#: Confidence a source can support on its own, before cross-referencing.
_SOURCE_MAX_CONFIDENCE: Dict[Source, Confidence] = {
    Source.OFFICIAL: Confidence.CONFIRMED,
    Source.YARDAGE_BOOK: Confidence.CONFIRMED,
    Source.COURSE_MAP: Confidence.VISUALLY_MATCHED,
    Source.DRONE: Confidence.VISUALLY_MATCHED,
    Source.ESTIMATE: Confidence.ESTIMATED,
}


class FactKind(str, Enum):
    """What a fact describes; drives the minimum confidence required to show it."""

    IDENTITY = "identity"        # hole number, par, course name
    DISTANCE = "distance"        # any metre / yard number
    GEOMETRY = "geometry"        # polygons and positions of visible features
    HAZARD_CLASS = "hazard_class"  # OB, Red/Yellow Penalty Area classification
    SLOPE = "slope"              # green slope percentage / contour values
    DIRECTION = "direction"      # dominant slope direction, approach direction
    STRATEGY = "strategy"        # recommended route, landing zone intent


#: Section 32 - the grades below which a fact must never be drawn.
#: Numbers, hazard classifications and slope values demand CONFIRMED data.
#: Things the camera can actually see may be shown when VISUALLY MATCHED.
DISPLAY_FLOOR: Dict[FactKind, Confidence] = {
    FactKind.IDENTITY: Confidence.CONFIRMED,
    FactKind.DISTANCE: Confidence.CONFIRMED,
    FactKind.GEOMETRY: Confidence.VISUALLY_MATCHED,
    FactKind.HAZARD_CLASS: Confidence.CONFIRMED,
    FactKind.SLOPE: Confidence.CONFIRMED,
    FactKind.DIRECTION: Confidence.VISUALLY_MATCHED,
    FactKind.STRATEGY: Confidence.VISUALLY_MATCHED,
}


class OmissionReason(str, Enum):
    BELOW_FLOOR = "below_confidence_floor"
    NO_SOURCE = "no_source"
    MISSING = "missing_value"
    CONFLICT_UNRESOLVED = "conflict_unresolved"


@dataclass(frozen=True)
class Omission:
    """A fact that was deliberately NOT rendered, and why.

    Omissions are first-class output: the QA report lists them so a human can
    see exactly what the system refused to invent.
    """

    field: str
    kind: FactKind
    reason: OmissionReason
    detail: str = ""

    def describe(self) -> str:
        base = f"{self.field} [{self.kind.value}] omitted: {self.reason.value}"
        return f"{base} - {self.detail}" if self.detail else base


@dataclass(frozen=True)
class Fact:
    """A single piece of course information plus its provenance."""

    field: str
    value: Any
    kind: FactKind
    source: Source
    confidence: Confidence
    note: str = ""
    corroborated_by: Sequence[Source] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        ceiling = _SOURCE_MAX_CONFIDENCE[self.source]
        effective = self.confidence
        if effective.rank > ceiling.rank and not self._cross_referenced():
            # A source cannot certify itself above its own ceiling.
            object.__setattr__(self, "confidence", ceiling)

    def _cross_referenced(self) -> bool:
        """Map/drone data may reach B (never A) when corroborated elsewhere."""
        return len(set(self.corroborated_by) - {self.source}) >= 1

    @property
    def displayable(self) -> bool:
        """True when section 32 permits this fact on screen."""
        if self.value is None:
            return False
        return self.confidence.rank >= DISPLAY_FLOOR[self.kind].rank

    def omission(self) -> Optional[Omission]:
        if self.value is None:
            return Omission(self.field, self.kind, OmissionReason.MISSING)
        if not self.displayable:
            floor = DISPLAY_FLOOR[self.kind]
            return Omission(
                self.field,
                self.kind,
                OmissionReason.BELOW_FLOOR,
                f"confidence {self.confidence.value} < required {floor.value} "
                f"(source: {self.source.value})",
            )
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "field": self.field,
            "value": self.value,
            "kind": self.kind.value,
            "source": self.source.value,
            "confidence": self.confidence.value,
            "note": self.note,
            "corroborated_by": [s.value for s in self.corroborated_by],
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "Fact":
        return Fact(
            field=data["field"],
            value=data.get("value"),
            kind=FactKind(data["kind"]),
            source=Source(data["source"]),
            confidence=Confidence(data.get("confidence", "C")),
            note=data.get("note", ""),
            corroborated_by=tuple(Source(s) for s in data.get("corroborated_by", [])),
        )


def resolve_conflict(candidates: Iterable[Fact]) -> Optional[Fact]:
    """Pick the winning fact for one field using section 02 source priority.

    Never replaces reliable supplied information with visual guesswork: the
    highest-priority source wins, ties broken by confidence.
    """
    facts = [f for f in candidates if f.value is not None]
    if not facts:
        return None
    return min(facts, key=lambda f: (f.source.priority, -f.confidence.rank))


class FactSet:
    """Collection of facts about one hole, keyed by field name."""

    def __init__(self, facts: Iterable[Fact] = ()) -> None:
        self._by_field: Dict[str, List[Fact]] = {}
        for f in facts:
            self.add(f)

    def add(self, fact: Fact) -> None:
        self._by_field.setdefault(fact.field, []).append(fact)

    def get(self, field_name: str) -> Optional[Fact]:
        """Resolved (conflict-free) fact for a field, or None."""
        return resolve_conflict(self._by_field.get(field_name, []))

    def value(self, field_name: str, default: Any = None) -> Any:
        """Value of a field only if it is allowed on screen, else ``default``."""
        fact = self.get(field_name)
        if fact is None or not fact.displayable:
            return default
        return fact.value

    def displayable(self) -> List[Fact]:
        out = [self.get(k) for k in sorted(self._by_field)]
        return [f for f in out if f is not None and f.displayable]

    def omissions(self) -> List[Omission]:
        out: List[Omission] = []
        for key in sorted(self._by_field):
            fact = self.get(key)
            if fact is None:
                # Every candidate had value None, so resolve_conflict dropped
                # them all; keep the declared kind so the report still says
                # what sort of information is missing.
                declared = self._by_field[key][0].kind
                out.append(Omission(key, declared, OmissionReason.MISSING))
                continue
            om = fact.omission()
            if om is not None:
                out.append(om)
        return out

    def fields(self) -> List[str]:
        return sorted(self._by_field)

    def __len__(self) -> int:
        return len(self._by_field)

    def __contains__(self, field_name: object) -> bool:
        return field_name in self._by_field

    def to_list(self) -> List[Dict[str, Any]]:
        return [f.to_dict() for k in sorted(self._by_field) for f in self._by_field[k]]

    @staticmethod
    def from_list(items: Iterable[Dict[str, Any]]) -> "FactSet":
        return FactSet(Fact.from_dict(d) for d in items)
