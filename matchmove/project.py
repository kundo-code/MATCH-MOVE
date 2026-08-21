"""End-to-end pipeline: references in, verified overlay track out.

A project file gathers everything about one hole - the hole spec, the anchor
correspondences marked in the drone frames, the camera metadata, any elevation
samples - and :class:`Project` runs the fixed pipeline over it:

    solve camera  ->  build overlays  ->  confidence gate  ->  final validation
                  ->  strip whatever failed  ->  six-phase sequence  ->  render

The order matters.  Validation runs *before* rendering, and anything it fails
is removed rather than replaced with a guess (section 36).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from .camera import CameraTrack, Intrinsics
from .confidence import Omission
from .geo import LatLon, Vec3, geodetic_to_enu
from .occlusion import OcclusionModel
from .overlay import OverlayElement, build_overlays
from .prompt import ShotBrief, build_brief
from .sequence import FrameRender, PhaseSequence, build_sequence, render_sequence
from .solve import Correspondence, FrameSolve, solve_track
from .spec import HoleSpec
from .terrain import FlatTerrain, SampledTerrain, Terrain
from .validate import ValidationReport, apply_report, validate


class ProjectError(RuntimeError):
    pass


@dataclass
class Project:
    spec: HoleSpec
    intrinsics: Intrinsics
    fps: float = 30.0
    correspondences: Dict[int, List[Correspondence]] = field(default_factory=dict)
    track: Optional[CameraTrack] = None
    terrain: Terrain = field(default_factory=FlatTerrain)
    solves: List[FrameSolve] = field(default_factory=list)
    elements: List[OverlayElement] = field(default_factory=list)
    omissions: List[Omission] = field(default_factory=list)
    report: Optional[ValidationReport] = None
    sequence: Optional[PhaseSequence] = None
    frames: List[FrameRender] = field(default_factory=list)
    refine_focal: bool = False

    # ------------------------------------------------------------------ steps
    def solve(self) -> CameraTrack:
        if self.track is not None:
            return self.track
        if not self.correspondences:
            raise ProjectError(
                "no camera track and no anchor correspondences: mark at least 4 "
                "permanent anchors (section 05) in at least one frame"
            )
        self.track, self.solves = solve_track(
            self.correspondences, self.intrinsics, self.fps,
            source_footage=self.spec.footage_id, refine_focal=self.refine_focal,
        )
        return self.track

    def build(self) -> List[OverlayElement]:
        self.elements, self.omissions = build_overlays(self.spec, self.terrain)
        return self.elements

    def verify(self) -> ValidationReport:
        self.report = validate(
            self.spec, self.elements, self.track, self.solves, self.omissions
        )
        self.elements = apply_report(self.elements, self.report)
        return self.report

    def render(self, step: int = 1) -> List[FrameRender]:
        if self.track is None:
            raise ProjectError("solve() must run before render()")
        self.sequence = build_sequence(self.track, self.spec)
        occlusion = OcclusionModel.from_features(self.spec.features, self.terrain)
        self.frames = render_sequence(
            self.elements, self.track, self.sequence, occlusion, step=step
        )
        return self.frames

    def run(self, step: int = 1) -> "Project":
        self.solve()
        self.build()
        self.verify()
        self.render(step=step)
        return self

    def brief(self) -> ShotBrief:
        return build_brief(
            self.spec, self.elements, self.track, self.sequence,
            self.report, self.omissions,
        )

    # -------------------------------------------------------------- exporting
    def export_all(self, out_dir: str | Path, plates: Optional[Dict[int, str]] = None) -> Dict[str, Path]:
        from .exporters import (
            export_after_effects_jsx,
            export_blender_py,
            export_chan,
            export_html_preview,
            export_overlay_json,
            export_svg_frame,
        )

        if self.track is None or not self.frames:
            raise ProjectError("run() must complete before export_all()")
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        stem = f"hole{self.spec.hole_number:02d}"
        written: Dict[str, Path] = {
            "overlay_json": export_overlay_json(
                out / f"{stem}_overlay.json", self.frames, self.track,
                self.sequence, self.report,
                meta={"course": self.spec.course_name, "hole": self.spec.hole_number},
            ),
            "after_effects": export_after_effects_jsx(
                out / f"{stem}_matchmove.jsx", self.track, self.elements, self.spec),
            "blender": export_blender_py(
                out / f"{stem}_matchmove.py", self.track, self.elements, self.spec),
            "chan": export_chan(out / f"{stem}_camera.chan", self.track),
            "preview": export_html_preview(
                out / f"{stem}_preview.html", self.frames, self.track, self.spec,
                self.sequence, self.report, plates),
            "brief": _write(out / f"{stem}_brief.md", self.brief().hole_block()),
            "prompt": _write(out / f"{stem}_prompt.md", self.brief().full_prompt()),
            "validation": _write(
                out / f"{stem}_validation.txt",
                self.report.text() if self.report else "not validated"),
            "spec": _write(
                out / f"{stem}_spec.json",
                json.dumps(self.spec.to_dict(), indent=2, ensure_ascii=False)),
        }
        if self.frames:
            mid = self.frames[len(self.frames) // 2]
            written["svg"] = export_svg_frame(
                out / f"{stem}_frame{mid.frame:05d}.svg", mid, self.track,
                title=f"{self.spec.course_name} H{self.spec.hole_number:02d}")
        return written


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# --------------------------------------------------------------- project file
def _world_point(entry: Dict, datum: Optional[LatLon]) -> Vec3:
    if "world" in entry:
        return Vec3.from_seq(entry["world"])
    if "lat" in entry and "lon" in entry:
        if datum is None:
            raise ProjectError(
                "anchor given as lat/lon but the hole spec has no datum "
                "(set datum to the Green Center's coordinates)"
            )
        return geodetic_to_enu(
            LatLon(float(entry["lat"]), float(entry["lon"]), float(entry.get("alt", 0.0))),
            datum,
        )
    raise ProjectError(f"anchor {entry.get('anchor_id')} has no world or lat/lon position")


def strip_help_keys(value: object) -> object:
    """Drop ``_``-prefixed keys anywhere in the structure.

    The shipped templates document themselves with ``_help`` notes sitting
    right next to real values.  They are for the person filling the file in,
    so the loader removes them before anything tries to parse them.
    """
    if isinstance(value, dict):
        return {k: strip_help_keys(v) for k, v in value.items()
                if not (isinstance(k, str) and k.startswith("_"))}
    if isinstance(value, list):
        return [strip_help_keys(v) for v in value]
    return value


def load_project(path: str | Path) -> Project:
    """Load a project file (see ``matchmove template project``)."""
    data = strip_help_keys(json.loads(Path(path).read_text(encoding="utf-8")))
    if not isinstance(data, dict):
        raise ProjectError("project file must contain a JSON object")
    base = Path(path).parent

    spec_ref = data.get("hole_spec")
    if isinstance(spec_ref, str):
        spec = HoleSpec.load(base / spec_ref)
    elif isinstance(spec_ref, dict):
        spec = HoleSpec.from_dict(spec_ref)
    else:
        raise ProjectError("project file must contain 'hole_spec' (path or object)")

    cam = data.get("camera", {})
    width = int(cam.get("width", 1920))
    height = int(cam.get("height", 1080))
    if "focal_px" in cam:
        intr = Intrinsics(width, height, float(cam["focal_px"]),
                          cam.get("cx"), cam.get("cy"))
    elif "hfov_deg" in cam:
        intr = Intrinsics.from_fov(width, height, float(cam["hfov_deg"]))
    elif "focal_mm" in cam and "sensor_width_mm" in cam:
        intr = Intrinsics.from_sensor(width, height, float(cam["focal_mm"]),
                                      float(cam["sensor_width_mm"]))
    else:
        raise ProjectError(
            "camera block needs focal_px, hfov_deg, or focal_mm + sensor_width_mm"
        )
    fps = float(cam.get("fps", 30.0))
    if cam.get("footage"):
        spec.footage_id = str(cam["footage"])

    terrain: Terrain = FlatTerrain()
    tdata = data.get("terrain")
    if isinstance(tdata, dict) and tdata.get("samples"):
        terrain = SampledTerrain([Vec3.from_seq(s) for s in tdata["samples"]])

    correspondences: Dict[int, List[Correspondence]] = {}
    for frame_key, entries in (data.get("anchors") or {}).items():
        frame = int(frame_key)
        correspondences[frame] = [
            Correspondence(
                anchor_id=str(e.get("anchor_id", f"a{i}")),
                world=_world_point(e, spec.datum),
                x=float(e["x"]),
                y=float(e["y"]),
                weight=float(e.get("weight", 1.0)),
            )
            for i, e in enumerate(entries)
        ]

    track = None
    if data.get("camera_track"):
        ref = data["camera_track"]
        track = CameraTrack.load(base / ref) if isinstance(ref, str) else CameraTrack.from_dict(ref)

    return Project(
        spec=spec,
        intrinsics=intr,
        fps=fps,
        correspondences=correspondences,
        track=track,
        terrain=terrain,
        refine_focal=bool(cam.get("refine_focal", False)),
    )
