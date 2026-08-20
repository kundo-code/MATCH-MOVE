"""The six-phase information reveal (sections 25 and 26).

Nothing is shown all at once.  Information appears as the drone reaches the
part of the hole it describes, and earlier information is retired once it is
no longer relevant:

  01 ESTABLISHING  -> HOLE / PAR / distance
  02 TEE SHOT      -> tee, landing zone, tee-shot risk
  03 LANDING ZONE  -> landing zone and nearby risk, tee info removed
  04 APPROACH      -> green center, approach route, greenside risk, distance
  05 GREEN         -> green center and immediate surroundings only
  06 GREEN ANALYSIS-> green shape, contour, slope direction / percentage

Phase boundaries are derived from where the camera actually is along the hole
(tee -> Green Center), so the graphics follow the real flight rather than an
arbitrary stopwatch.  When there is no tee geometry to measure against, the
sequencer falls back to an even split of the shot and says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .camera import CameraTrack
from .geo import Vec3
from .overlay import OverlayElement, RenderedElement, render_frame, _fade
from .occlusion import OcclusionModel
from .spec import HoleSpec

PHASE_ORDER: Tuple[str, ...] = (
    "establishing",
    "tee_shot",
    "landing_zone",
    "approach",
    "green",
    "green_analysis",
)

PHASE_TITLES: Dict[str, str] = {
    "establishing": "PHASE 01 — ESTABLISHING",
    "tee_shot": "PHASE 02 — TEE SHOT",
    "landing_zone": "PHASE 03 — LANDING ZONE",
    "approach": "PHASE 04 — APPROACH",
    "green": "PHASE 05 — GREEN",
    "green_analysis": "PHASE 06 — GREEN ANALYSIS",
}

#: Fraction of the tee -> Green Center axis at which each phase ends.
DEFAULT_PROGRESS_BREAKS: Dict[str, float] = {
    "establishing": 0.12,
    "tee_shot": 0.34,
    "landing_zone": 0.58,
    "approach": 0.82,
    "green": 0.94,
    "green_analysis": 1.0,
}


@dataclass
class Phase:
    name: str
    start_frame: int
    end_frame: int
    title: str = ""

    @property
    def length(self) -> int:
        return max(0, self.end_frame - self.start_frame)

    def contains(self, frame: float) -> bool:
        return self.start_frame <= frame <= self.end_frame


@dataclass
class PhaseSequence:
    phases: List[Phase]
    fade_frames: float = 12.0
    derived_from_camera: bool = True
    note: str = ""

    def phase_at(self, frame: float) -> Optional[Phase]:
        for p in self.phases:
            if p.contains(frame):
                return p
        return self.phases[-1] if self.phases else None

    def phase(self, name: str) -> Optional[Phase]:
        for p in self.phases:
            if p.name == name:
                return p
        return None

    def window(self, names: Sequence[str]) -> Optional[Tuple[int, int]]:
        """Contiguous frame window covering the named phases."""
        found = [p for p in self.phases if p.name in set(names)]
        if not found:
            return None
        return (min(p.start_frame for p in found), max(p.end_frame for p in found))

    def opacity_for(self, element: OverlayElement, frame: float) -> float:
        """Section 28: soft reveal / retire, never a hard pop."""
        if not element.phases:
            return 0.0
        win = self.window(element.phases)
        if win is None:
            return 0.0
        return _fade(frame, win[0], win[1], self.fade_frames)

    def opacities(self, elements: Sequence[OverlayElement], frame: float) -> Dict[str, float]:
        return {e.id: self.opacity_for(e, frame) for e in elements}

    def to_dict(self) -> Dict[str, object]:
        return {
            "fade_frames": self.fade_frames,
            "derived_from_camera": self.derived_from_camera,
            "note": self.note,
            "phases": [
                {"name": p.name, "title": p.title, "start": p.start_frame, "end": p.end_frame}
                for p in self.phases
            ],
        }


def camera_progress(track: CameraTrack, spec: HoleSpec, frame: float) -> Optional[float]:
    """0 at the tee, 1 at the Green Center, measured along the hole axis."""
    tee = spec.primary_tee_position()
    center = spec.target()
    if tee is None or center is None:
        return None
    axis = Vec3(center.x - tee.x, center.y - tee.y, 0.0)
    length = axis.length()
    if length < 1e-6:
        return None
    cam = track.pose_at(frame).position
    rel = Vec3(cam.x - tee.x, cam.y - tee.y, 0.0)
    t = rel.dot(axis) / (length * length)
    return max(0.0, min(1.0, t))


def build_sequence(
    track: CameraTrack,
    spec: HoleSpec,
    *,
    breaks: Optional[Dict[str, float]] = None,
    fade_frames: float = 12.0,
    min_phase_frames: Optional[int] = None,
) -> PhaseSequence:
    """Cut the shot into the six phases using real camera advance."""
    first, last = track.frame_range
    if last <= first:
        raise ValueError("camera track is too short to build a sequence")
    breaks = breaks or DEFAULT_PROGRESS_BREAKS
    if min_phase_frames is None:
        min_phase_frames = max(8, int(round(track.fps * 1.4)))

    progress: List[Tuple[int, float]] = []
    for f in range(first, last + 1):
        p = camera_progress(track, spec, f)
        if p is None:
            progress = []
            break
        progress.append((f, p))

    derived = bool(progress)
    note = ""
    if derived:
        # Enforce monotonicity so a hovering drone cannot rewind the sequence.
        best = 0.0
        mono: List[Tuple[int, float]] = []
        for f, p in progress:
            best = max(best, p)
            mono.append((f, best))
        cuts: List[int] = []
        for name in PHASE_ORDER[:-1]:
            threshold = breaks[name]
            cut = next((f for f, p in mono if p >= threshold), last)
            cuts.append(cut)
        bounds = [first] + cuts + [last]
    else:
        note = (
            "phase timing evenly divided: no tee geometry supplied, so camera "
            "advance along the hole could not be measured"
        )
        step = (last - first) / len(PHASE_ORDER)
        bounds = [int(round(first + step * i)) for i in range(len(PHASE_ORDER))] + [last]

    bounds = _enforce_minimum_lengths(bounds, min_phase_frames)

    phases = [
        Phase(name, bounds[i], bounds[i + 1], PHASE_TITLES[name])
        for i, name in enumerate(PHASE_ORDER)
    ]
    return PhaseSequence(phases, fade_frames=fade_frames, derived_from_camera=derived, note=note)


def _enforce_minimum_lengths(bounds: List[int], minimum: int) -> List[int]:
    """Give every phase at least ``minimum`` frames without changing the total.

    A phase shorter than about a second cannot be read, so short phases borrow
    frames from the longest ones.  The shot's overall length never changes -
    the footage is not retimed (section 31).
    """
    first, last = bounds[0], bounds[-1]
    total = last - first
    n = len(bounds) - 1
    if n <= 0 or total <= 0:
        return bounds
    minimum = max(1, min(minimum, total // n))
    lengths = [bounds[i + 1] - bounds[i] for i in range(n)]

    for _ in range(n * 4):
        short = [i for i, L in enumerate(lengths) if L < minimum]
        if not short:
            break
        i = short[0]
        need = minimum - lengths[i]
        donors = sorted(range(n), key=lambda j: -lengths[j])
        for j in donors:
            if j == i or need <= 0:
                continue
            spare = lengths[j] - minimum
            if spare <= 0:
                continue
            take = min(spare, need)
            lengths[j] -= take
            lengths[i] += take
            need -= take
        if need > 0:  # not enough room anywhere; leave it as even as possible
            break

    out = [first]
    for L in lengths:
        out.append(out[-1] + L)
    out[-1] = last
    return out


@dataclass
class FrameRender:
    frame: int
    phase: str
    elements: List[RenderedElement] = field(default_factory=list)


def render_sequence(
    elements: Sequence[OverlayElement],
    track: CameraTrack,
    seq: PhaseSequence,
    occlusion: Optional[OcclusionModel] = None,
    step: int = 1,
) -> List[FrameRender]:
    """Render the whole shot, frame by frame."""
    first, last = track.frame_range
    out: List[FrameRender] = []
    for f in range(first, last + 1, max(1, step)):
        phase = seq.phase_at(f)
        rendered = render_frame(
            elements, track, f, occlusion, seq.opacities(elements, f)
        )
        out.append(FrameRender(f, phase.name if phase else "", rendered))
    return out
