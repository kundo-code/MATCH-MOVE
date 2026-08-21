"""AR overlay elements and their per-frame rendered state.

Sections 13-24 (what gets drawn), 27 (graphic design language), 28 (motion).

An :class:`OverlayElement` is a piece of course information bound to real
world coordinates.  :func:`render_frame` turns elements into screen-space
geometry for one frame using the camera solve, terrain and occlusion model -
that is where perspective scaling, depth scaling and occlusion actually
happen.  Nothing is drawn that the confidence gate rejected.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

from .camera import CameraTrack
from .confidence import Fact, FactKind, Omission
from .geo import Vec3, ground_distance
from .occlusion import OcclusionModel
from .spec import (
    TARGET_LABEL,
    Feature,
    FeatureType,
    HoleSpec,
)
from .terrain import Terrain, FlatTerrain, ellipse, resample_polyline, smooth_polyline


class ElementKind(str, Enum):
    TARGET = "target"            # the Green Center flag marker (s.13)
    ROUTE = "route"              # tee -> landing zone -> approach -> center (s.15)
    ZONE = "zone"                # landing zone ellipse (s.16)
    AREA = "area"                # bunker / water / green outline (s.17, 18, 21, 22)
    BOUNDARY = "boundary"        # OB line, penalty area edge (s.19, 20)
    CONTOUR = "contour"          # green contour lines (s.24)
    SLOPE_ARROW = "slope_arrow"  # green slope direction (s.23)
    LABEL = "label"              # world-anchored text callout
    HUD = "hud"                  # screen-space hole title card (s.10)


#: Section 27 - premium broadcast palette. Restrained, thin, legible.
DEFAULT_STYLE: Dict[str, Dict[str, object]] = {
    "target":      {"color": "#F5F7FA", "accent": "#C8A24A", "width": 1.6, "opacity": 0.95},
    "route":       {"color": "#EAF2FF", "width": 2.2, "opacity": 0.72, "dash": None},
    "zone":        {"color": "#8FD6A8", "width": 1.4, "opacity": 0.38, "fill": 0.12},
    "bunker":      {"color": "#E8D9A8", "width": 1.2, "opacity": 0.55, "fill": 0.08},
    "water":       {"color": "#7FC6E8", "width": 1.2, "opacity": 0.55, "fill": 0.10},
    "penalty_red": {"color": "#E2564B", "width": 1.6, "opacity": 0.70, "fill": 0.08},
    "penalty_yellow": {"color": "#E6BE3C", "width": 1.6, "opacity": 0.70, "fill": 0.08},
    "ob":          {"color": "#FFFFFF", "width": 1.2, "opacity": 0.65, "dash": [6, 6]},
    "green":       {"color": "#BFF0CE", "width": 1.2, "opacity": 0.50},
    "contour":     {"color": "#DFF3E6", "width": 0.8, "opacity": 0.35},
    "slope":       {"color": "#DFF3E6", "width": 1.4, "opacity": 0.70},
    "label":       {"color": "#FFFFFF", "width": 1.0, "opacity": 0.90},
    "hud":         {"color": "#FFFFFF", "width": 1.0, "opacity": 0.95},
}

_FEATURE_STYLE_KEY = {
    FeatureType.BUNKER: "bunker",
    FeatureType.WATER: "water",
    FeatureType.PENALTY_AREA_RED: "penalty_red",
    FeatureType.PENALTY_AREA_YELLOW: "penalty_yellow",
    FeatureType.OUT_OF_BOUNDS: "ob",
    FeatureType.GREEN: "green",
    FeatureType.LANDING_ZONE: "zone",
}


@dataclass
class OverlayElement:
    """One piece of information locked to real-world coordinates."""

    id: str
    kind: ElementKind
    points: List[Vec3] = field(default_factory=list)
    anchor: Optional[Vec3] = None
    label: str = ""
    sublabel: str = ""
    closed: bool = False
    style_key: str = "label"
    marker_height: float = 0.0     # metres, for the 3D flag marker
    facts: List[Fact] = field(default_factory=list)
    phases: Tuple[str, ...] = ()
    conform: bool = True           # snap geometry to terrain
    priority: int = 50             # lower draws first / survives declutter longer

    @property
    def displayable(self) -> bool:
        return all(f.displayable for f in self.facts)

    def omissions(self) -> List[Omission]:
        return [o for f in self.facts for o in ([f.omission()] if f.omission() else [])]

    def style(self, style: Optional[Dict[str, Dict[str, object]]] = None) -> Dict[str, object]:
        table = style or DEFAULT_STYLE
        return dict(table.get(self.style_key, table["label"]))


@dataclass
class RenderedElement:
    """Screen-space result for one element on one frame."""

    id: str
    kind: ElementKind
    label: str
    sublabel: str
    polylines: List[List[Tuple[float, float]]]
    anchor_px: Optional[Tuple[float, float]]
    depth: float
    px_per_metre: float
    opacity: float
    style: Dict[str, object]
    occluded: bool
    occluder_id: Optional[str] = None
    closed: bool = False

    @property
    def on_screen(self) -> bool:
        if self.kind is ElementKind.HUD:
            return bool(self.label or self.sublabel)
        return bool(self.polylines) or self.anchor_px is not None


def _fade(frame: float, start: float, end: float, fade_frames: float) -> float:
    """Section 28: fade in / fade out, never a hard pop."""
    if frame < start - fade_frames or frame > end + fade_frames:
        return 0.0
    if frame < start:
        return max(0.0, (frame - (start - fade_frames)) / fade_frames)
    if frame > end:
        return max(0.0, 1.0 - (frame - end) / fade_frames)
    return 1.0


# ----------------------------------------------------------------- builders
def build_target_marker(spec: HoleSpec, terrain: Terrain) -> Optional[OverlayElement]:
    """Section 13: the subtle flag-style marker at the Green Center.

    Never labelled PIN or HOLE CUP - :meth:`HoleSpec.assert_target_label`
    enforces that at construction time.
    """
    center = spec.target()
    if center is None:
        return None
    green = spec.green()
    if green is not None and not green.displayable:
        return None
    label = HoleSpec.assert_target_label(TARGET_LABEL)
    base = terrain.point_on(center.x, center.y)
    facts = [green.fact] if green is not None else []
    return OverlayElement(
        id="target_green_center",
        kind=ElementKind.TARGET,
        points=[base],
        anchor=base,
        label=label,
        closed=False,
        style_key="target",
        marker_height=2.1,
        facts=facts,
        phases=("establishing", "tee_shot", "landing_zone", "approach", "green", "green_analysis"),
        priority=10,
    )


def build_feature_elements(spec: HoleSpec, terrain: Terrain) -> List[OverlayElement]:
    """Outline real features that passed the confidence gate (s.17-22)."""
    out: List[OverlayElement] = []
    phase_map = {
        FeatureType.BUNKER: ("tee_shot", "landing_zone", "approach", "green"),
        FeatureType.WATER: ("establishing", "tee_shot", "landing_zone", "approach"),
        FeatureType.PENALTY_AREA_RED: ("tee_shot", "landing_zone", "approach"),
        FeatureType.PENALTY_AREA_YELLOW: ("tee_shot", "landing_zone", "approach"),
        FeatureType.OUT_OF_BOUNDS: ("tee_shot", "landing_zone", "approach"),
        FeatureType.GREEN: ("approach", "green", "green_analysis"),
    }
    for f in spec.features:
        if f.type not in _FEATURE_STYLE_KEY:
            continue
        if f.type is FeatureType.LANDING_ZONE:
            continue  # handled by build_landing_zones()
        if not f.displayable:
            continue
        kind = (
            ElementKind.BOUNDARY
            if f.type in (FeatureType.OUT_OF_BOUNDS, FeatureType.PENALTY_AREA_RED,
                          FeatureType.PENALTY_AREA_YELLOW)
            else ElementKind.AREA
        )
        label = f.label or _default_label(f, spec)
        phases = phase_map.get(f.type, ("tee_shot", "approach"))
        if f.type is FeatureType.BUNKER and label == "GREENSIDE BUNKER":
            phases = ("approach", "green", "green_analysis")
        out.append(
            OverlayElement(
                id=f.id,
                kind=kind,
                points=list(f.points),
                anchor=f.centroid(),
                label=label,
                closed=f.closed,
                style_key=_FEATURE_STYLE_KEY[f.type],
                facts=[f.fact],
                phases=phases,
                priority=30,
            )
        )
    return out


def _default_label(f: Feature, spec: HoleSpec) -> str:
    if f.type == FeatureType.BUNKER:
        center = spec.target()
        if center is not None:
            d = ground_distance(f.centroid(), center)
            return "GREENSIDE BUNKER" if d <= 45.0 else "FAIRWAY BUNKER"
        return "BUNKER"
    return {
        FeatureType.WATER: "WATER",
        FeatureType.PENALTY_AREA_RED: "RED PENALTY AREA",
        FeatureType.PENALTY_AREA_YELLOW: "YELLOW PENALTY AREA",
        FeatureType.OUT_OF_BOUNDS: "OB",
        FeatureType.GREEN: "",
        FeatureType.LANDING_ZONE: "LANDING ZONE",
    }.get(f.type, "")


def build_landing_zones(spec: HoleSpec, terrain: Terrain) -> List[OverlayElement]:
    """Section 16: terrain-conforming landing-zone footprints."""
    out: List[OverlayElement] = []
    center = spec.target()
    for i, lz in enumerate(spec.features_of(FeatureType.LANDING_ZONE)):
        if not lz.displayable:
            continue
        if len(lz.points) >= 3:
            pts = list(lz.points)
        else:
            c = lz.centroid()
            heading = 0.0
            if center is not None:
                heading = math.degrees(math.atan2(center.y - c.y, center.x - c.x))
            pts = ellipse(c, 26.0, 16.0, heading)
        out.append(
            OverlayElement(
                id=lz.id,
                kind=ElementKind.ZONE,
                points=pts,
                anchor=lz.centroid(),
                label=lz.label or "LANDING ZONE",
                closed=True,
                style_key="zone",
                facts=[lz.fact],
                phases=("tee_shot", "landing_zone"),
                priority=20,
            )
        )
    return out


def build_route(spec: HoleSpec, terrain: Terrain) -> Optional[OverlayElement]:
    """Section 15: strategic route, never an automatic straight line.

    The route is only built from supplied waypoints (tee -> landing zone ->
    approach -> Green Center).  With fewer than three waypoints there is not
    enough information to claim a strategic line, so nothing is drawn.
    """
    pts = list(spec.strategy_route)
    if not pts:
        tee = spec.primary_tee_position()
        lzs = [lz.centroid() for lz in spec.features_of(FeatureType.LANDING_ZONE)
               if lz.displayable]
        center = spec.target()
        if tee is None or center is None or not lzs:
            return None
        pts = [tee, *lzs, center]
    if len(pts) < 3:
        return None
    fact = Fact(
        field="strategy_route",
        value="route",
        kind=FactKind.STRATEGY,
        source=spec.route_source,
        confidence=spec.route_confidence,
    )
    dense = smooth_polyline(resample_polyline(pts, 4.0), 2)
    return OverlayElement(
        id="strategy_route",
        kind=ElementKind.ROUTE,
        points=dense,
        anchor=None,
        label="",
        closed=False,
        style_key="route",
        facts=[fact],
        phases=("tee_shot", "landing_zone", "approach"),
        priority=25,
    )


def build_hole_title(spec: HoleSpec) -> Optional[OverlayElement]:
    """Section 10: HOLE / PAR / distance card. Distance only when confirmed."""
    hole_fact = spec.facts.get("hole_number")
    par = spec.par
    if par is None and spec.facts.get("par") is not None:
        par_fact = spec.facts.get("par")
        par = par_fact.value if par_fact and par_fact.displayable else None
    if spec.hole_number <= 0 and hole_fact is None:
        return None
    title = f"HOLE {spec.hole_number:02d}"
    parts: List[str] = []
    if par is not None:
        parts.append(f"PAR {par}")
    metres = spec.tee_distance()
    if metres is not None:
        from .geo import metres_to_yards

        parts.append(f"{round(metres)}m / {round(metres_to_yards(metres))}yd")
    tee_label = ""
    if spec.primary_tee is not None and metres is not None:
        tee_label = f"{spec.primary_tee.value.upper()} TEE"
    return OverlayElement(
        id="hole_title",
        kind=ElementKind.HUD,
        points=[],
        anchor=None,
        label=title,
        sublabel=" · ".join(parts) + (f"  ({tee_label})" if tee_label else ""),
        style_key="hud",
        facts=[],
        phases=("establishing",),
        priority=5,
    )


def build_distance_callout(spec: HoleSpec, terrain: Terrain) -> Optional[OverlayElement]:
    """Section 14: TO CENTER readout, only from confirmed distance data."""
    metres = spec.tee_distance()
    center = spec.target()
    if metres is None or center is None:
        return None
    base = terrain.point_on(center.x, center.y)
    tee_fact = None
    for t in spec.tees:
        if spec.primary_tee is None or t.color == spec.primary_tee:
            tee_fact = t.fact()
            break
    return OverlayElement(
        id="distance_to_center",
        kind=ElementKind.LABEL,
        points=[base],
        anchor=base,
        label=f"TEE → GREEN CENTER: {round(metres)}m",
        style_key="label",
        facts=[tee_fact] if tee_fact else [],
        phases=("tee_shot",),
        priority=15,
    )


def build_slope_arrows(spec: HoleSpec, terrain: Terrain) -> List[OverlayElement]:
    """Section 23: slope direction, with a percentage only when confirmed."""
    center = spec.target()
    green = spec.green()
    if center is None or green is None:
        return []
    direction_fact = spec.facts.get("green_slope_direction")
    percent_fact = spec.facts.get("green_slope_percent")
    if direction_fact is None or not direction_fact.displayable:
        return []
    bearing = float(direction_fact.value)
    length = 8.0
    rad = math.radians(bearing)
    tip = Vec3(center.x + math.sin(rad) * length, center.y + math.cos(rad) * length, center.z)
    label = "SLOPE DIRECTION"
    facts = [direction_fact]
    if percent_fact is not None and percent_fact.displayable:
        label = f"GREEN SLOPE {float(percent_fact.value):.1f}%"
        facts.append(percent_fact)
    return [
        OverlayElement(
            id="green_slope",
            kind=ElementKind.SLOPE_ARROW,
            points=[center, tip],
            anchor=center,
            label=label,
            style_key="slope",
            facts=facts,
            phases=("green_analysis",),
            priority=18,
        )
    ]


def build_overlays(spec: HoleSpec, terrain: Optional[Terrain] = None) -> Tuple[List[OverlayElement], List[Omission]]:
    """Assemble every overlay the supplied data can honestly support."""
    terrain = terrain or FlatTerrain()
    candidates: List[Optional[OverlayElement]] = [
        build_hole_title(spec),
        build_target_marker(spec, terrain),
        build_route(spec, terrain),
        build_distance_callout(spec, terrain),
    ]
    elements = [e for e in candidates if e is not None]
    elements.extend(build_landing_zones(spec, terrain))
    elements.extend(build_feature_elements(spec, terrain))
    elements.extend(build_slope_arrows(spec, terrain))

    kept: List[OverlayElement] = []
    omitted: List[Omission] = []
    # Features that would have been drawn but failed the gate are recorded here,
    # not silently skipped: the omission list is a deliverable (section 32).
    for f in spec.features:
        if f.type in _FEATURE_STYLE_KEY and not f.displayable:
            om = f.fact.omission()
            if om is not None:
                omitted.append(om)
    for e in elements:
        if e.displayable:
            if e.conform and e.points:
                e.points = terrain.conform(e.points)
            kept.append(e)
        else:
            omitted.extend(e.omissions())
    omitted.extend(spec.facts.omissions())
    kept.sort(key=lambda e: e.priority)
    return kept, omitted


# ------------------------------------------------------------------ renderer
def render_element(
    element: OverlayElement,
    track: CameraTrack,
    frame: float,
    occlusion: Optional[OcclusionModel] = None,
    opacity: float = 1.0,
    style: Optional[Dict[str, Dict[str, object]]] = None,
) -> Optional[RenderedElement]:
    """Project one element into screen space for one frame."""
    st = element.style(style)
    base_opacity = float(st.get("opacity", 1.0)) * opacity
    if base_opacity <= 0.001:
        return None

    if element.kind == ElementKind.HUD:
        return RenderedElement(
            id=element.id, kind=element.kind, label=element.label,
            sublabel=element.sublabel, polylines=[], anchor_px=None, depth=0.0,
            px_per_metre=0.0, opacity=base_opacity, style=st, occluded=False,
        )

    cam = track.pose_at(frame).position
    anchor_px: Optional[Tuple[float, float]] = None
    depth = math.inf
    px_per_m = 0.0
    occluded = False
    occluder_id: Optional[str] = None

    if element.anchor is not None:
        pr = track.project(element.anchor, frame, margin_px=200.0)
        if pr.in_front:
            depth = pr.depth
            px_per_m = track.intrinsics_at(frame).focal_px / pr.depth
            if pr.in_frame:
                anchor_px = (pr.x, pr.y)
        if occlusion is not None:
            occluder_id = occlusion.occluded_by(cam, element.anchor)
            occluded = occluder_id is not None

    polylines: List[List[Tuple[float, float]]] = []
    if element.points:
        pts = list(element.points)
        if element.closed and len(pts) > 2:
            pts = pts + [pts[0]]
        runs: List[List[int]] = [list(range(len(pts)))]
        if occlusion is not None and element.kind in (
            ElementKind.ROUTE, ElementKind.ZONE, ElementKind.AREA,
            ElementKind.BOUNDARY, ElementKind.CONTOUR,
        ):
            runs = occlusion.split_visible_runs(track, pts, frame)
        for run in runs:
            line: List[Tuple[float, float]] = []
            for i in run:
                pr = track.project(pts[i], frame, margin_px=400.0)
                if pr.in_front and pr.in_frame:
                    line.append((pr.x, pr.y))
                elif line:
                    polylines.append(line)
                    line = []
            if len(line) >= 1:
                polylines.append(line)
        polylines = [p for p in polylines if len(p) >= 2 or element.kind == ElementKind.TARGET]
        if element.anchor is None and polylines:
            depths = [track.project(p, frame).depth for p in element.points]
            finite = [d for d in depths if d > 0]
            if finite:
                depth = sum(finite) / len(finite)
                px_per_m = track.intrinsics_at(frame).focal_px / depth

    if element.kind == ElementKind.TARGET and element.anchor is not None:
        # 3D flag marker: a vertical staff whose screen height scales with depth.
        base = element.anchor
        top = Vec3(base.x, base.y, base.z + element.marker_height)
        pb = track.project(base, frame, margin_px=200.0)
        pt = track.project(top, frame, margin_px=200.0)
        if pb.in_front and pt.in_front:
            polylines = [[(pb.x, pb.y), (pt.x, pt.y)]]
            flag_w = element.marker_height * 0.42
            span = math.hypot(pt.x - pb.x, pt.y - pb.y)
            if span > 0.5:
                ux, uy = (pt.x - pb.x) / span, (pt.y - pb.y) / span
                nx, ny = -uy, ux
                fw = span * (flag_w / max(element.marker_height, 1e-6))
                polylines.append([
                    (pt.x, pt.y),
                    (pt.x + nx * fw, pt.y + ny * fw - span * 0.10),
                    (pt.x + ux * span * 0.28, pt.y + uy * span * 0.28),
                    (pt.x, pt.y),
                ])
            anchor_px = (pb.x, pb.y) if pb.in_frame else anchor_px

    if not polylines and anchor_px is None:
        return None

    return RenderedElement(
        id=element.id, kind=element.kind, label=element.label,
        sublabel=element.sublabel, polylines=polylines, anchor_px=anchor_px,
        depth=depth, px_per_metre=px_per_m, opacity=base_opacity, style=st,
        occluded=occluded, occluder_id=occluder_id, closed=element.closed,
    )


def render_frame(
    elements: Sequence[OverlayElement],
    track: CameraTrack,
    frame: float,
    occlusion: Optional[OcclusionModel] = None,
    opacities: Optional[Dict[str, float]] = None,
    style: Optional[Dict[str, Dict[str, object]]] = None,
) -> List[RenderedElement]:
    """Render every visible element for one frame, far-to-near."""
    out: List[RenderedElement] = []
    for e in elements:
        op = 1.0 if opacities is None else opacities.get(e.id, 0.0)
        r = render_element(e, track, frame, occlusion, op, style)
        if r is not None and r.on_screen:
            out.append(r)
    out.sort(key=lambda r: -r.depth)
    return out
