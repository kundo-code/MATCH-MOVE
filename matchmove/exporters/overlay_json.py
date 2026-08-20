"""Per-frame overlay track as JSON - the format a compositor or web player reads."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional, Sequence

from ..camera import CameraTrack
from ..sequence import FrameRender, PhaseSequence
from ..validate import ValidationReport


def _round(v: float, nd: int = 2) -> float:
    return round(float(v), nd)


def overlay_track_dict(
    frames: Sequence[FrameRender],
    track: CameraTrack,
    seq: Optional[PhaseSequence] = None,
    report: Optional[ValidationReport] = None,
    meta: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    out: Dict[str, object] = {
        "format": "matchmove.overlay_track",
        "version": 1,
        "meta": dict(meta or {}),
        "camera": track.to_dict(),
        "sequence": seq.to_dict() if seq else None,
        "validation": report.to_dict() if report else None,
        "frames": [],
    }
    for fr in frames:
        out["frames"].append({
            "frame": fr.frame,
            "phase": fr.phase,
            "elements": [
                {
                    "id": e.id,
                    "kind": e.kind.value,
                    "label": e.label,
                    "sublabel": e.sublabel,
                    "polylines": [[[_round(x), _round(y)] for x, y in line]
                                  for line in e.polylines],
                    "anchor": None if e.anchor_px is None
                              else [_round(e.anchor_px[0]), _round(e.anchor_px[1])],
                    "depth": _round(e.depth, 3),
                    "px_per_metre": _round(e.px_per_metre, 4),
                    "opacity": _round(e.opacity, 3),
                    "occluded": e.occluded,
                    "occluder": e.occluder_id,
                    "closed": e.closed,
                    "style": e.style,
                }
                for e in fr.elements
            ],
        })
    return out


def export_overlay_json(
    path: str | Path,
    frames: Sequence[FrameRender],
    track: CameraTrack,
    seq: Optional[PhaseSequence] = None,
    report: Optional[ValidationReport] = None,
    meta: Optional[Dict[str, object]] = None,
) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps(overlay_track_dict(frames, track, seq, report, meta),
                   indent=1, ensure_ascii=False),
        encoding="utf-8",
    )
    return p
