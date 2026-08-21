"""matchmove - GOLF COURSE DRONE MATCH MOVE / COURSE INTELLIGENCE.

A pipeline that takes the references a caddie would use - a Kakao/satellite
course map, a yardage book page, and drone footage of the hole - and locks
verified course information onto the real terrain in that footage.

Three rules are enforced by the code, not by good intentions:

1. Unverified distances, OB lines, penalty areas and slope numbers are never
   drawn.  Every fact carries its source, and the gate omits what it cannot
   confirm (:mod:`matchmove.confidence`).
2. The daily hole cup is never located or labelled.  Every hole aims at the
   GREEN CENTER, which is also the origin of the hole's coordinate frame
   (:mod:`matchmove.spec`).
3. The original drone footage and the real course geometry are never altered.
   The camera solve is read-only and only measures what the footage shows
   (:mod:`matchmove.camera`, :mod:`matchmove.solve`).
"""

from .camera import CameraPose, CameraTrack, Intrinsics, Keyframe
from .confidence import Confidence, Fact, FactKind, FactSet, Omission, Source
from .geo import LatLon, Vec3
from .mapref import MapLandmark, MapReference, fit_map_reference
from .occlusion import Occluder, OcclusionModel
from .overlay import ElementKind, OverlayElement, RenderedElement, build_overlays
from .project import Project, load_project
from .prompt import build_brief, master_prompt_text
from .sequence import PHASE_ORDER, PhaseSequence, build_sequence
from .solve import Correspondence, solve_frame, solve_track
from .spec import Feature, FeatureType, HoleSpec, TeeColor, TeeDistance
from .terrain import FlatTerrain, SampledTerrain, Terrain
from .validate import ValidationReport, validate

__version__ = "1.0.0"
MASTER_PROMPT_VERSION = "v1.0"

__all__ = [
    "CameraPose", "CameraTrack", "Intrinsics", "Keyframe",
    "Confidence", "Fact", "FactKind", "FactSet", "Omission", "Source",
    "LatLon", "Vec3",
    "MapLandmark", "MapReference", "fit_map_reference",
    "Occluder", "OcclusionModel",
    "ElementKind", "OverlayElement", "RenderedElement", "build_overlays",
    "Project", "load_project",
    "build_brief", "master_prompt_text",
    "PHASE_ORDER", "PhaseSequence", "build_sequence",
    "Correspondence", "solve_frame", "solve_track",
    "Feature", "FeatureType", "HoleSpec", "TeeColor", "TeeDistance",
    "FlatTerrain", "SampledTerrain", "Terrain",
    "ValidationReport", "validate",
    "__version__", "MASTER_PROMPT_VERSION",
]
