"""Section 36 FINAL VALIDATION - run before anything is rendered or exported.

Checks are grouped exactly as the master prompt groups them: COURSE IDENTITY,
GEOMETRY, DATA, TRACKING, GREEN, VISUAL.  The rule at the bottom of section 36
is the important one:

    If any data fails verification:
    REMOVE OR SIMPLIFY THE UNVERIFIED INFORMATION RATHER THAN INVENTING IT.

so a failing check never triggers a fallback that makes something up - it
strips the offending element out of the render list.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence

from .camera import CameraTrack
from .confidence import Confidence, Omission
from .overlay import ElementKind, OverlayElement
from .solve import FrameSolve, drift_report
from .spec import (
    FORBIDDEN_TARGET_LABELS,
    FeatureType,
    HoleSpec,
)


class Severity(str, Enum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"


@dataclass
class Check:
    group: str
    name: str
    severity: Severity
    detail: str = ""
    element_ids: List[str] = field(default_factory=list)

    def __str__(self) -> str:
        mark = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}[self.severity.value]
        line = f"[{mark}] {self.group} / {self.name}"
        return f"{line}: {self.detail}" if self.detail else line


@dataclass
class ValidationReport:
    checks: List[Check] = field(default_factory=list)
    omissions: List[Omission] = field(default_factory=list)
    stripped: List[str] = field(default_factory=list)

    @property
    def failed(self) -> List[Check]:
        return [c for c in self.checks if c.severity is Severity.FAIL]

    @property
    def warnings(self) -> List[Check]:
        return [c for c in self.checks if c.severity is Severity.WARN]

    @property
    def ok(self) -> bool:
        return not self.failed

    def add(self, group: str, name: str, severity: Severity, detail: str = "",
            element_ids: Optional[Sequence[str]] = None) -> None:
        self.checks.append(Check(group, name, severity, detail, list(element_ids or [])))

    def text(self) -> str:
        lines = ["FINAL VALIDATION (master prompt section 36)", "=" * 46]
        group = None
        for c in self.checks:
            if c.group != group:
                group = c.group
                lines.append(f"\n{group}")
            lines.append(f"  {c}")
        if self.omissions:
            lines.append("\nOMITTED RATHER THAN FABRICATED (section 32)")
            for o in self.omissions:
                lines.append(f"  - {o.describe()}")
        if self.stripped:
            lines.append("\nSTRIPPED FROM RENDER LIST")
            for s in self.stripped:
                lines.append(f"  - {s}")
        verdict = "PASS" if self.ok else "FAIL"
        lines.append(
            f"\nRESULT: {verdict}  "
            f"({len(self.failed)} failed, {len(self.warnings)} warnings, "
            f"{len(self.omissions)} omitted)"
        )
        return "\n".join(lines)

    def to_dict(self) -> Dict[str, object]:
        return {
            "ok": self.ok,
            "checks": [
                {"group": c.group, "name": c.name, "severity": c.severity.value,
                 "detail": c.detail, "elements": c.element_ids}
                for c in self.checks
            ],
            "omissions": [
                {"field": o.field, "kind": o.kind.value, "reason": o.reason.value,
                 "detail": o.detail}
                for o in self.omissions
            ],
            "stripped": self.stripped,
        }


def _classification_check(
    rep: "ValidationReport",
    spec: HoleSpec,
    elements: Sequence[OverlayElement],
    queued: set,
    check_name: str,
    types: Sequence[FeatureType],
    noun: str,
    short: str,
) -> None:
    """OB and penalty areas may only be drawn from CONFIRMED data (s.19, 20).

    An unconfirmed one that the gate already refused is not a failure - that is
    the system working.  It fails only if such a feature reached the render
    list, which would mean a rules classification was invented.
    """
    feats = spec.features_of(*types)
    unconfirmed = [f for f in feats if f.confidence is not Confidence.CONFIRMED]
    leaked = [f.id for f in unconfirmed if f.id in queued]
    confirmed = [f for f in feats if f.confidence is Confidence.CONFIRMED]
    if leaked:
        rep.add("DATA", check_name, Severity.FAIL,
                f"unconfirmed {noun} reached the render list: {', '.join(leaked)}",
                leaked)
        return
    if unconfirmed:
        rep.add("DATA", check_name, Severity.WARN,
                f"{len(unconfirmed)} unconfirmed {noun}(s) refused and not drawn: "
                + ", ".join(f.id for f in unconfirmed)
                + " - confirm against official course data before displaying")
        return
    rep.add("DATA", check_name, Severity.PASS,
            f"{len(confirmed)} confirmed {noun}(s)" if confirmed
            else f"no {short} displayed")


def validate(
    spec: HoleSpec,
    elements: Sequence[OverlayElement],
    track: Optional[CameraTrack] = None,
    solves: Optional[Sequence[FrameSolve]] = None,
    omissions: Optional[Sequence[Omission]] = None,
    *,
    max_rms_px: float = 2.0,
    max_drift_px_per_frame: float = 0.02,
) -> ValidationReport:
    rep = ValidationReport(omissions=list(omissions or []))

    # ------------------------------------------------------ COURSE IDENTITY
    rep.add("COURSE IDENTITY", "course name",
            Severity.PASS if spec.course_name.strip() else Severity.FAIL,
            spec.course_name or "no course name supplied")
    rep.add("COURSE IDENTITY", "hole number",
            Severity.PASS if spec.hole_number > 0 else Severity.FAIL,
            f"hole {spec.hole_number}" if spec.hole_number > 0 else "missing")
    rep.add("COURSE IDENTITY", "par",
            Severity.PASS if spec.par else Severity.WARN,
            f"par {spec.par}" if spec.par else "par not supplied - title card will omit it")
    rep.add("COURSE IDENTITY", "footage identified",
            Severity.PASS if spec.footage_id else Severity.WARN,
            spec.footage_id or "no footage id recorded for this solve")

    # ------------------------------------------------------------- GEOMETRY
    green = spec.green()
    tee = spec.primary_tee_position()
    rep.add("GEOMETRY", "green matched",
            Severity.PASS if green and len(green.points) >= 3 else Severity.FAIL,
            "green polygon traced" if green else "no green geometry - target cannot be placed")
    rep.add("GEOMETRY", "tee matched",
            Severity.PASS if tee else Severity.WARN,
            "tee box located" if tee else "no tee geometry - phase timing falls back to an even split")
    fairway = spec.features_of(FeatureType.FAIRWAY)
    rep.add("GEOMETRY", "fairway geometry",
            Severity.PASS if fairway else Severity.WARN,
            "fairway traced" if fairway else "fairway not traced")
    bunkers = [b for b in spec.features_of(FeatureType.BUNKER) if b.displayable]
    rep.add("GEOMETRY", "major bunkers matched",
            Severity.PASS if bunkers else Severity.WARN,
            f"{len(bunkers)} bunker(s) matched" if bunkers else "no bunkers matched")
    water = [w for w in spec.features_of(FeatureType.WATER) if w.displayable]
    rep.add("GEOMETRY", "water matched", Severity.PASS,
            f"{len(water)} water feature(s) matched" if water else "no water in this hole's references")

    # ------------------------------------------------------------------ DATA
    dist = spec.tee_distance()
    rep.add("DATA", "distance verified",
            Severity.PASS if dist is not None else Severity.WARN,
            f"{round(dist)}m from confirmed data" if dist is not None
            else "no confirmed tee distance - all distance readouts omitted (section 32)")

    queued = {e.id for e in elements}
    _classification_check(rep, spec, elements, queued, "OB verified when displayed",
                          (FeatureType.OUT_OF_BOUNDS,), "OB boundary", "OB")
    _classification_check(rep, spec, elements, queued,
                          "penalty area verified when displayed",
                          (FeatureType.PENALTY_AREA_RED, FeatureType.PENALTY_AREA_YELLOW),
                          "penalty area", "penalty area")

    slope_pct = spec.facts.get("green_slope_percent")
    if slope_pct is not None and not slope_pct.displayable:
        rep.add("DATA", "green slope percentage",
                Severity.WARN,
                "slope percentage supplied but not confirmed - direction only will be shown")
    else:
        rep.add("DATA", "green slope percentage", Severity.PASS,
                "confirmed slope data" if slope_pct else "no slope percentage claimed")

    # -------------------------------------------------------------- TRACKING
    if track is not None and track.keyframes:
        first, last = track.frame_range
        rep.add("TRACKING", "camera track present", Severity.PASS,
                f"{len(track.keyframes)} keyframes over frames {first}-{last} "
                f"({track.duration_s:.1f}s @ {track.fps:g}fps)")
        rep.add("TRACKING", "footage untouched",
                Severity.PASS if track.locked else Severity.FAIL,
                "camera solve is locked read-only (section 31)" if track.locked
                else "camera track is unlocked - original camera motion could be altered")
        if track.solve_error_px is not None:
            sev = Severity.PASS if track.solve_error_px <= max_rms_px else Severity.FAIL
            rep.add("TRACKING", "reprojection error", sev,
                    f"worst-frame RMS {track.solve_error_px:.2f}px "
                    f"(limit {max_rms_px:.2f}px)")
    else:
        rep.add("TRACKING", "camera track present", Severity.FAIL,
                "no camera solve - graphics cannot be locked to the terrain")

    if solves:
        drift = drift_report(solves)
        bad = {k: v for k, v in drift.items() if abs(v) > max_drift_px_per_frame}
        # These names are anchor ids, not overlay ids, so they are reported in
        # the text and never fed to apply_report(): a drifting solve is a
        # problem with the whole track, not with one graphic that happens to
        # share a name.
        rep.add("TRACKING", "no tracking drift",
                Severity.FAIL if bad else Severity.PASS,
                ("residual trending on " +
                 ", ".join(f"{k} {v:+.4f}px/frame" for k, v in sorted(bad.items()))
                 + " - re-check these anchors before trusting the solve")
                if bad else f"{len(drift)} anchors stable over the solve")
        worst = max((s.max_px for s in solves), default=0.0)
        rep.add("TRACKING", "no sliding markers",
                Severity.PASS if worst <= max_rms_px * 2 else Severity.WARN,
                f"worst single-anchor residual {worst:.2f}px")

    # ----------------------------------------------------------------- GREEN
    center = spec.target()
    rep.add("GREEN", "green center used as target",
            Severity.PASS if center is not None else Severity.FAIL,
            f"target at ENU ({center.x:.1f}, {center.y:.1f})" if center
            else "no Green Center - nothing to aim at")

    target_elements = [e for e in elements if e.kind is ElementKind.TARGET]
    bad_labels = [
        e.id for e in target_elements
        if e.label.strip().upper().replace("-", " ") in FORBIDDEN_TARGET_LABELS
    ]
    rep.add("GREEN", "actual pin NOT estimated",
            Severity.FAIL if bad_labels else Severity.PASS,
            f"forbidden pin labelling on: {', '.join(bad_labels)}" if bad_labels
            else "no daily pin position claimed anywhere in the render list",
            bad_labels)
    rep.add("GREEN", "green center correctly anchored",
            Severity.PASS if len(target_elements) == 1 else
            (Severity.FAIL if len(target_elements) > 1 else Severity.WARN),
            f"{len(target_elements)} target marker(s)")

    if center is not None and green is not None and len(green.points) >= 3:
        from .geo import point_in_polygon

        inside = point_in_polygon(center, green.points)
        rep.add("GREEN", "target lies on the putting surface",
                Severity.PASS if inside else Severity.FAIL,
                "Green Center falls inside the traced green" if inside
                else "Green Center falls outside the traced green - re-trace the green")

    # ---------------------------------------------------------------- VISUAL
    undisplayable = [e.id for e in elements if not e.displayable]
    rep.add("VISUAL", "only verified graphics queued",
            Severity.FAIL if undisplayable else Severity.PASS,
            f"unverified elements queued: {', '.join(undisplayable)}" if undisplayable
            else f"{len(elements)} verified elements queued",
            undisplayable)

    labelled = [e for e in elements if e.label]
    rep.add("VISUAL", "graphics remain minimal",
            Severity.PASS if len(labelled) <= 12 else Severity.WARN,
            f"{len(labelled)} labelled elements"
            + ("" if len(labelled) <= 12 else " - consider retiring some per section 25"))

    return rep


def apply_report(elements: Sequence[OverlayElement], report: ValidationReport) -> List[OverlayElement]:
    """Strip every element a failed check named - never substitute a guess."""
    doomed = {eid for c in report.failed for eid in c.element_ids}
    doomed.update(e.id for e in elements if not e.displayable)
    kept = [e for e in elements if e.id not in doomed]
    report.stripped = sorted(doomed)
    return kept
