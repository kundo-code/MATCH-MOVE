"""Render a per-hole shot brief from a validated HoleSpec.

The master prompt (v1.0) is the standing instruction set for the whole video
series; it lives verbatim at ``matchmove/data/master_prompt_v1.0.md``.  What
changes hole to hole is the *data block* underneath it, and that block is
generated here from the HoleSpec **after** the confidence gate has run.

Two properties matter:

* every value printed carries its source and confidence grade, so a reviewer
  can trace any number on screen back to the yardage book page it came from;
* everything the gate rejected is printed in an explicit
  ``DO NOT INVENT`` list, so whoever (or whatever) executes the brief is told
  what is unknown instead of being left to fill the gap.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence

from .camera import CameraTrack
from .confidence import Confidence, Omission, Source
from .geo import ground_distance, metres_to_yards
from .overlay import ElementKind, OverlayElement
from .sequence import PHASE_TITLES, PhaseSequence
from .spec import TARGET_LABEL, FeatureType, HoleSpec
from .validate import ValidationReport

MASTER_PROMPT_PATH = Path(__file__).with_name("data") / "master_prompt_v1.0.md"
MASTER_PROMPT_VERSION = "v1.0"


def master_prompt_text() -> str:
    return MASTER_PROMPT_PATH.read_text(encoding="utf-8")


def _grade(conf: Confidence) -> str:
    return {"A": "A CONFIRMED", "B": "B VISUALLY MATCHED", "C": "C ESTIMATED"}[conf.value]


def _line(label: str, value: str, source: Optional[Source] = None,
          conf: Optional[Confidence] = None) -> str:
    tag = ""
    if source is not None and conf is not None:
        tag = f"   [{_grade(conf)} · {source.value}]"
    return f"{label}: {value}{tag}"


@dataclass
class ShotBrief:
    """The rendered, hole-specific portion of the prompt."""

    header: str
    data_block: str
    sequence_block: str
    omission_block: str
    validation_block: str

    def hole_block(self) -> str:
        parts = [self.header, self.data_block, self.sequence_block,
                 self.omission_block, self.validation_block]
        return "\n\n".join(p for p in parts if p.strip())

    def full_prompt(self) -> str:
        return master_prompt_text() + "\n\n---\n\n" + self.hole_block() + "\n"


def _feature_rows(spec: HoleSpec, types: Sequence[FeatureType], heading: str) -> List[str]:
    rows: List[str] = []
    feats = spec.features_of(*types)
    if not feats:
        return rows
    rows.append(f"[{heading}]")
    center = spec.target()
    for f in feats:
        if not f.displayable:
            rows.append(f"  - {f.id}: OMITTED (confidence {f.confidence.value})")
            continue
        bits = [f.name or f.id]
        if center is not None and f.points:
            d = ground_distance(f.centroid(), center)
            bits.append(f"position {d:.0f}m from Green Center (measured from traced geometry)")
        rows.append(
            f"  - {'; '.join(bits)}   [{_grade(f.confidence)} · {f.source.value}]"
        )
    return rows


def build_brief(
    spec: HoleSpec,
    elements: Sequence[OverlayElement] = (),
    track: Optional[CameraTrack] = None,
    seq: Optional[PhaseSequence] = None,
    report: Optional[ValidationReport] = None,
    omissions: Sequence[Omission] = (),
) -> ShotBrief:
    header_lines = [
        f"# HOLE BRIEF — {spec.course_name or 'UNNAMED COURSE'} · HOLE {spec.hole_number:02d}",
        "",
        f"Generated against COURSE INTELLIGENCE MASTER PROMPT {MASTER_PROMPT_VERSION}.",
        "Every value below carries its source and confidence grade (section 03).",
        "Values that could not be confirmed are listed under DO NOT INVENT and must",
        "be left off screen entirely (section 32).",
    ]

    rows: List[str] = ["[COURSE]"]
    rows.append(_line("  Golf Course", spec.course_name or "—"))
    rows.append(_line("  Hole", f"{spec.hole_number:02d}"))
    rows.append(_line("  Par", str(spec.par) if spec.par else "OMITTED (not confirmed)"))
    if spec.footage_id:
        rows.append(_line("  Drone footage", spec.footage_id))

    rows.append("")
    rows.append("[TEE]")
    any_tee = False
    for t in spec.tees:
        fact = t.fact()
        if fact.displayable and t.metres is not None:
            any_tee = True
            rows.append(
                _line(f"  {t.color.value.capitalize()}",
                      f"{round(t.metres)}m / {round(metres_to_yards(t.metres))}yd",
                      t.source, t.confidence)
            )
        else:
            rows.append(f"  {t.color.value.capitalize()}: OMITTED (unconfirmed distance)")
    if not spec.tees:
        rows.append("  OMITTED — no tee distances supplied")
    elif not any_tee:
        rows.append("  OMITTED — no supplied tee distance is confirmed")
    if spec.primary_tee is not None:
        rows.append(_line("  Primary Tee", spec.primary_tee.value.upper()))

    rows.append("")
    rows.append("[GREEN]")
    rows.append(_line("  Target", TARGET_LABEL + "  (standardised — NOT the daily hole cup)"))
    center = spec.target()
    green = spec.green()
    if center is not None and green is not None:
        rows.append(
            _line("  Green Center", f"ENU ({center.x:.1f}, {center.y:.1f}) m — geometric "
                  f"centre of the traced putting surface", green.source, green.confidence)
        )
    else:
        rows.append("  Green Center: OMITTED — no green geometry traced")
    for key, label in (("green_front", "Front"), ("green_back", "Back")):
        f = spec.facts.get(key)
        if f is not None and f.displayable:
            rows.append(_line(f"  {label}", f"{f.value}", f.source, f.confidence))

    rows.append("")
    rows.append("[GREEN SLOPE]")
    dirf = spec.facts.get("green_slope_direction")
    pctf = spec.facts.get("green_slope_percent")
    rows.append(_line("  Slope Data Available", "YES" if (dirf and dirf.displayable) else "NO"))
    if dirf is not None and dirf.displayable:
        rows.append(_line("  Dominant Slope Direction", f"{float(dirf.value):.0f}° bearing",
                          dirf.source, dirf.confidence))
    if pctf is not None and pctf.displayable:
        rows.append(_line("  Slope Percentage", f"{float(pctf.value):.1f}%",
                          pctf.source, pctf.confidence))
    elif pctf is not None:
        rows.append("  Slope Percentage: OMITTED — direction only, do not print a number")

    for block, types, heading in (
        (None, (FeatureType.BUNKER,), "BUNKERS"),
        (None, (FeatureType.PENALTY_AREA_RED, FeatureType.PENALTY_AREA_YELLOW), "PENALTY AREA"),
        (None, (FeatureType.WATER,), "WATER"),
        (None, (FeatureType.OUT_OF_BOUNDS,), "OUT OF BOUNDS"),
        (None, (FeatureType.LANDING_ZONE,), "LANDING ZONE"),
    ):
        block_rows = _feature_rows(spec, types, heading)
        if block_rows:
            rows.append("")
            rows.extend(block_rows)

    rows.append("")
    rows.append("[STRATEGY]")
    route = [e for e in elements if e.kind is ElementKind.ROUTE]
    if route:
        rows.append(
            _line("  Route", "TEE → LANDING ZONE → APPROACH → GREEN CENTER, "
                  "terrain-conforming, following the traced fairway shape",
                  spec.route_source, spec.route_confidence)
        )
    else:
        rows.append("  Route: OMITTED — insufficient information for a strategic line")

    rows.append("")
    rows.append("[RENDER LIST — draw exactly these, nothing more]")
    if elements:
        for e in elements:
            phases = ", ".join(e.phases) if e.phases else "—"
            label = e.label or e.sublabel or e.id
            rows.append(f"  - {e.kind.value:<11} {label:<34} phases: {phases}")
    else:
        rows.append("  (empty — no element passed verification)")

    seq_lines: List[str] = []
    if seq is not None:
        seq_lines.append("[REVEAL SEQUENCE — section 25]")
        fps = track.fps if track is not None else 30.0
        for p in seq.phases:
            t0 = p.start_frame / fps
            t1 = p.end_frame / fps
            seq_lines.append(
                f"  {PHASE_TITLES.get(p.name, p.name):<28} "
                f"frames {p.start_frame:>5}-{p.end_frame:<5} ({t0:6.2f}s – {t1:6.2f}s)"
            )
        if not seq.derived_from_camera and seq.note:
            seq_lines.append(f"  NOTE: {seq.note}")

    om_lines: List[str] = []
    all_om = list(omissions) + list(report.omissions if report else [])
    seen = set()
    unique = []
    for o in all_om:
        key = (o.field, o.reason.value)
        if key not in seen:
            seen.add(key)
            unique.append(o)
    if unique:
        om_lines.append("[DO NOT INVENT — section 32]")
        om_lines.append("  The following could not be verified. Leave them off screen;")
        om_lines.append("  do not estimate, interpolate or narrate them.")
        for o in unique:
            om_lines.append(f"  - {o.describe()}")

    val_lines: List[str] = []
    if report is not None:
        val_lines.append("[FINAL VALIDATION — section 36]")
        for c in report.checks:
            if c.severity.value != "pass":
                val_lines.append(f"  {c}")
        val_lines.append(f"  RESULT: {'PASS' if report.ok else 'FAIL'} "
                         f"({len(report.failed)} failed, {len(report.warnings)} warnings)")
        if report.stripped:
            val_lines.append("  Stripped from render list: " + ", ".join(report.stripped))

    return ShotBrief(
        header="\n".join(header_lines),
        data_block="\n".join(rows),
        sequence_block="\n".join(seq_lines),
        omission_block="\n".join(om_lines),
        validation_block="\n".join(val_lines),
    )
