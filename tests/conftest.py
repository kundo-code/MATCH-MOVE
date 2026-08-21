import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def demo_project_file(tmp_path):
    """A project file built from the synthetic demo hole."""
    from matchmove.camera import Intrinsics
    from matchmove.demo import demo_correspondences, demo_spec, demo_terrain

    spec = demo_spec()
    spec.save(tmp_path / "hole.json")
    intr = Intrinsics.from_fov(1920, 1080, 78.0)
    anchors = {
        str(frame): [
            {"anchor_id": c.anchor_id, "world": list(c.world.as_tuple()),
             "x": round(c.x, 2), "y": round(c.y, 2)}
            for c in rows
        ]
        for frame, rows in demo_correspondences(spec, intr).items()
    }
    path = tmp_path / "project.json"
    path.write_text(json.dumps({
        "hole_spec": "hole.json",
        "camera": {"width": 1920, "height": 1080, "fps": 30, "hfov_deg": 78.0,
                   "footage": "SYNTHETIC_DEMO_FLIGHT_01"},
        "anchors": anchors,
        "terrain": {"samples": [list(s.as_tuple()) for s in demo_terrain().samples]},
    }, indent=1), encoding="utf-8")
    return path
