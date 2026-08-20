"""A synthetic hole that exercises the whole pipeline.

IMPORTANT: this hole is invented test geometry.  It is NOT a real golf course
and its numbers are not real yardages - it exists so the solver, the
confidence gate, the occlusion model and the exporters can be run and
inspected without needing footage.  Real work starts from
``matchmove template project``.

The demo deliberately includes data that must be refused:

* a water hazard that nobody confirmed as a penalty area  -> shown as WATER only
* an OB line traced from the drone image only             -> refused entirely
* a green slope percentage that is only estimated         -> direction only
"""

from __future__ import annotations

import math
import random
from typing import Dict, List

from .camera import CameraPose, Intrinsics, mat3_vec
from .confidence import Confidence, Fact, FactKind, FactSet, Source
from .geo import Vec3
from .project import Project
from .solve import Correspondence
from .spec import Feature, FeatureType, HoleSpec, TeeColor, TeeDistance
from .terrain import SampledTerrain

DEMO_COURSE = "SYNTHETIC DEMO COURSE (not a real golf course)"


def demo_spec() -> HoleSpec:
    green = Feature(
        id="green", type=FeatureType.GREEN,
        points=[Vec3(-12, -14, 0), Vec3(9, -16, 0), Vec3(15, 2, 0),
                Vec3(6, 15, 0), Vec3(-11, 11, 0)],
        source=Source.COURSE_MAP, confidence=Confidence.VISUALLY_MATCHED,
        corroborated_by=(Source.DRONE, Source.YARDAGE_BOOK),
        name="green",
    )
    tee = Feature(
        id="tee_white", type=FeatureType.TEE_BOX, name="white",
        points=[Vec3(-5, -352, 6), Vec3(5, -352, 6), Vec3(5, -342, 6), Vec3(-5, -342, 6)],
        source=Source.COURSE_MAP, confidence=Confidence.VISUALLY_MATCHED,
        corroborated_by=(Source.YARDAGE_BOOK,),
    )
    fairway = Feature(
        id="fairway", type=FeatureType.FAIRWAY,
        points=[Vec3(-22, -330, 4), Vec3(20, -332, 4), Vec3(34, -200, 2),
                Vec3(22, -70, 1), Vec3(-18, -66, 1), Vec3(-30, -205, 2)],
        source=Source.COURSE_MAP, confidence=Confidence.VISUALLY_MATCHED,
        corroborated_by=(Source.DRONE,),
    )
    bunker_g = Feature(
        id="bunker_greenside_left", type=FeatureType.BUNKER, name="greenside left",
        points=[Vec3(-30, -14, -1.2), Vec3(-19, -17, -1.2), Vec3(-16, -4, -1.2),
                Vec3(-27, -1, -1.2)],
        source=Source.YARDAGE_BOOK, confidence=Confidence.CONFIRMED,
    )
    bunker_f = Feature(
        id="bunker_fairway_right", type=FeatureType.BUNKER, name="fairway right",
        points=[Vec3(24, -150, 0.5), Vec3(35, -154, 0.5), Vec3(37, -132, 0.5),
                Vec3(26, -128, 0.5)],
        source=Source.YARDAGE_BOOK, confidence=Confidence.CONFIRMED,
    )
    # Visible water. Nobody confirmed its penalty-area colour, so it stays WATER.
    water = Feature(
        id="water_left", type=FeatureType.WATER,
        points=[Vec3(-64, -120, -1), Vec3(-40, -126, -1), Vec3(-34, -78, -1),
                Vec3(-58, -70, -1)],
        source=Source.DRONE, confidence=Confidence.VISUALLY_MATCHED,
        corroborated_by=(Source.COURSE_MAP,),
    )
    # Traced off the drone image alone: final validation must refuse to draw it.
    ob = Feature(
        id="ob_right_unconfirmed", type=FeatureType.OUT_OF_BOUNDS,
        points=[Vec3(60, -330, 0), Vec3(64, -190, 0), Vec3(56, -50, 0)],
        source=Source.DRONE, confidence=Confidence.VISUALLY_MATCHED, closed=False,
        note="traced from the drone image only - not confirmed by official data",
    )
    trees = Feature(
        id="treeline_left", type=FeatureType.TREE_LINE,
        points=[Vec3(-56, -300, 0), Vec3(-50, -210, 0), Vec3(-46, -140, 0)],
        source=Source.DRONE, confidence=Confidence.VISUALLY_MATCHED,
        closed=False, height=15.0,
    )
    lz = Feature(
        id="lz_primary", type=FeatureType.LANDING_ZONE,
        points=[Vec3(2, -130, 1)],
        source=Source.YARDAGE_BOOK, confidence=Confidence.CONFIRMED,
    )

    facts = FactSet([
        Fact("green_slope_direction", 214.0, FactKind.DIRECTION,
             Source.OFFICIAL, Confidence.CONFIRMED,
             note="green map: falls toward the front left"),
        # Estimated only -> the gate refuses the number, direction still shows.
        Fact("green_slope_percent", 2.4, FactKind.SLOPE,
             Source.ESTIMATE, Confidence.ESTIMATED,
             note="eyeballed from the drone frame - must not reach the screen"),
    ])

    spec = HoleSpec(
        course_name=DEMO_COURSE,
        hole_number=7,
        par=4,
        features=[green, tee, fairway, bunker_g, bunker_f, water, ob, trees, lz],
        facts=facts,
        tees=[
            TeeDistance(TeeColor.WHITE, metres=352.0, yards=385.0,
                        source=Source.YARDAGE_BOOK, confidence=Confidence.CONFIRMED),
            TeeDistance(TeeColor.BLUE, metres=378.0, yards=413.0,
                        source=Source.YARDAGE_BOOK, confidence=Confidence.CONFIRMED),
        ],
        primary_tee=TeeColor.WHITE,
        strategy_route=[
            Vec3(0, -347, 6), Vec3(2, -130, 1), Vec3(4, -60, 0.5), Vec3(0, 0, 0),
        ],
        route_source=Source.YARDAGE_BOOK,
        route_confidence=Confidence.VISUALLY_MATCHED,
        footage_id="SYNTHETIC_DEMO_FLIGHT_01",
        notes="Synthetic geometry for pipeline testing. Not a real golf hole.",
    )
    return spec


def demo_terrain() -> SampledTerrain:
    """Gentle rise toward the green, plus a hollow short left."""
    samples = [
        Vec3(0, -350, 6.0), Vec3(-40, -300, 5.0), Vec3(40, -300, 5.5),
        Vec3(0, -220, 3.4), Vec3(-50, -180, 3.0), Vec3(45, -180, 3.6),
        Vec3(0, -120, 1.6), Vec3(-45, -100, 0.4), Vec3(40, -110, 2.0),
        Vec3(0, -40, 0.4), Vec3(-30, -30, -0.6), Vec3(30, -30, 0.8),
        Vec3(0, 0, 0.0), Vec3(0, 30, 0.6), Vec3(-60, -95, -1.2),
    ]
    return SampledTerrain(samples)


def demo_flight() -> List[CameraPose]:
    """A slow cinematic push-in from behind the tee to over the green (s.29)."""
    poses: List[CameraPose] = []
    n = 13
    for i in range(n):
        t = i / (n - 1)
        ease = t * t * (3 - 2 * t)                 # smooth in/out, no FPV snap
        y = -430.0 + 400.0 * ease
        z = 118.0 - 66.0 * ease
        x = -6.0 + 6.0 * ease
        pitch = -21.0 - 13.0 * ease
        yaw = 2.5 - 2.5 * ease
        poses.append(CameraPose(Vec3(x, y, z), yaw, pitch, 0.4 * math.sin(t * 3.1)))
    return poses


def _anchor_points(spec: HoleSpec) -> List[tuple]:
    """Permanent landmarks an operator would mark, in section 05 priority order."""
    green = spec.feature("green")
    bunker_g = spec.feature("bunker_greenside_left")
    bunker_f = spec.feature("bunker_fairway_right")
    tee = spec.feature("tee_white")
    return [
        ("green_center", spec.target()),
        ("green_edge_front", green.points[0]),
        ("green_edge_back", green.points[3]),
        ("bunker_greenside_lip", bunker_g.points[1]),
        ("bunker_fairway_lip", bunker_f.points[0]),
        ("tee_corner", tee.points[0]),
    ]


def demo_correspondences(
    spec: HoleSpec, intr: Intrinsics, noise_px: float = 0.35, seed: int = 11
) -> Dict[int, List[Correspondence]]:
    """Simulate an operator marking anchors in the drone frames.

    Ground-truth poses project the anchors; a little noise stands in for human
    marking error, so the solve that follows is a real solve, not a copy.
    """
    rng = random.Random(seed)
    anchors = _anchor_points(spec)
    out: Dict[int, List[Correspondence]] = {}
    poses = demo_flight()
    cx, cy = intr.principal
    for i, pose in enumerate(poses):
        frame = i * 30
        rows: List[Correspondence] = []
        for name, world in anchors:
            rel = world - pose.position
            cam = mat3_vec(pose.rotation(), rel)
            if cam.z <= 1.0:
                continue
            x = intr.focal_px * cam.x / cam.z + cx
            y = intr.focal_px * cam.y / cam.z + cy
            if not (-intr.width * 0.2 <= x <= intr.width * 1.2):
                continue
            if not (-intr.height * 0.2 <= y <= intr.height * 1.2):
                continue
            rows.append(Correspondence(
                name, world, x + rng.gauss(0, noise_px), y + rng.gauss(0, noise_px)
            ))
        if len(rows) >= 4:
            out[frame] = rows
    return out


def build_demo_project() -> Project:
    spec = demo_spec()
    intr = Intrinsics.from_fov(1920, 1080, 78.0)
    return Project(
        spec=spec,
        intrinsics=intr,
        fps=30.0,
        correspondences=demo_correspondences(spec, intr),
        terrain=demo_terrain(),
    )
