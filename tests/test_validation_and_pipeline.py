"""Final validation, the end-to-end pipeline and the exporters (sections 31-36)."""

import json

import pytest

from matchmove.camera import CameraTrack
from matchmove.confidence import Confidence, Source
from matchmove.demo import build_demo_project, demo_spec
from matchmove.geo import Vec3
from matchmove.overlay import ElementKind, build_overlays
from matchmove.project import Project, ProjectError, load_project
from matchmove.spec import Feature, FeatureType, HoleSpec
from matchmove.terrain import FlatTerrain
from matchmove.validate import Severity, apply_report, validate


def find(report, name):
    return [c for c in report.checks if c.name == name][0]


# ------------------------------------------------------------------ pipeline
@pytest.fixture(scope="module")
def demo():
    return build_demo_project().run(step=5)


def test_the_demo_hole_passes_final_validation(demo):
    assert demo.report.ok, demo.report.text()


def test_the_solve_is_accurate_and_stable(demo):
    assert demo.track.solve_error_px < 1.0
    assert all(s.ok for s in demo.solves)
    assert find(demo.report, "no tracking drift").severity is Severity.PASS


def test_the_camera_solve_is_locked_against_modification(demo):
    assert demo.track.locked
    assert find(demo.report, "footage untouched").severity is Severity.PASS


def test_unconfirmed_ob_is_refused_and_reported_not_drawn(demo):
    check = find(demo.report, "OB verified when displayed")
    assert check.severity is Severity.WARN
    assert "refused and not drawn" in check.detail
    assert not [e for e in demo.elements if e.id == "ob_right_unconfirmed"]


def test_estimated_slope_percentage_never_reaches_the_screen(demo):
    labels = " ".join(e.label for e in demo.elements)
    assert "2.4%" not in labels
    assert any(o.field == "green_slope_percent" for o in demo.report.omissions)


def test_the_daily_pin_is_never_claimed(demo):
    assert find(demo.report, "actual pin NOT estimated").severity is Severity.PASS
    text = json.dumps([e.label for e in demo.elements]).upper()
    assert "PIN" not in text and "HOLE CUP" not in text


def test_every_frame_is_assigned_a_phase(demo):
    assert demo.frames
    assert all(f.phase for f in demo.frames)


def test_the_brief_lists_what_was_omitted(demo):
    brief = demo.brief().hole_block()
    assert "DO NOT INVENT" in brief
    assert "green_slope_percent" in brief
    assert "GREEN CENTER" in brief


def test_the_full_prompt_carries_the_master_prompt_and_the_hole_data(demo):
    full = demo.brief().full_prompt()
    assert "ANTI-HALLUCINATION RULE" in full
    assert "HOLE BRIEF" in full
    assert "SYNTHETIC DEMO COURSE" in full


# ---------------------------------------------------------------- validation
def test_validation_fails_when_an_unconfirmed_ob_reaches_the_render_list():
    spec = demo_spec()
    ob = spec.feature("ob_right_unconfirmed")
    elements, _ = build_overlays(spec, FlatTerrain())
    # Force the refused OB into the render list, as a careless caller might.
    from matchmove.overlay import OverlayElement

    elements.append(OverlayElement(
        id=ob.id, kind=ElementKind.BOUNDARY, points=list(ob.points),
        anchor=ob.centroid(), label="OB", style_key="ob", facts=[ob.fact]))
    report = validate(spec, elements)
    check = find(report, "OB verified when displayed")
    assert check.severity is Severity.FAIL
    assert not report.ok
    kept = apply_report(elements, report)
    assert ob.id not in {e.id for e in kept}
    assert ob.id in report.stripped


def test_validation_fails_when_a_marker_is_labelled_as_a_pin():
    spec = demo_spec()
    elements, _ = build_overlays(spec, FlatTerrain())
    for e in elements:
        if e.kind is ElementKind.TARGET:
            e.label = "PIN"
    report = validate(spec, elements)
    assert find(report, "actual pin NOT estimated").severity is Severity.FAIL


def test_validation_fails_without_green_geometry():
    spec = HoleSpec("Test", 3, 3)
    report = validate(spec, [])
    assert find(report, "green matched").severity is Severity.FAIL
    assert find(report, "green center used as target").severity is Severity.FAIL


def test_validation_warns_when_no_confirmed_distance_exists():
    spec = demo_spec()
    spec.tees = []
    elements, _ = build_overlays(spec, FlatTerrain())
    report = validate(spec, elements)
    check = find(report, "distance verified")
    assert check.severity is Severity.WARN
    assert "omitted" in check.detail


def test_validation_catches_a_target_placed_off_the_putting_surface():
    spec = demo_spec()
    spec.green_center_override = Vec3(80.0, -120.0, 0.0)
    elements, _ = build_overlays(spec, FlatTerrain())
    report = validate(spec, elements)
    assert find(report, "target lies on the putting surface").severity is Severity.FAIL


# ----------------------------------------------------------------- exporters
def test_all_exports_are_written_and_parse(tmp_path, demo):
    written = demo.export_all(tmp_path)
    for name, path in written.items():
        assert path.exists() and path.stat().st_size > 0, name

    data = json.loads(written["overlay_json"].read_text())
    assert data["format"] == "matchmove.overlay_track"
    assert data["validation"]["ok"]
    assert len(data["frames"]) == len(demo.frames)

    chan = written["chan"].read_text().strip().splitlines()
    assert len(chan) == demo.track.frame_range[1] - demo.track.frame_range[0] + 1
    assert all(len(line.split()) == 8 for line in chan)

    jsx = written["after_effects"].read_text()
    assert "addCamera" in jsx and "SOLVED_DRONE_CAM" in jsx

    blend = written["blender"].read_text()
    compile(blend, "blender_export", "exec")   # must be valid Python

    html = written["preview"].read_text()
    assert "<title>" in html and "matchmove.overlay_track" in html
    assert "GREEN CENTER" in html

    svg = written["svg"].read_text()
    assert svg.startswith("<svg") and svg.rstrip().endswith("</svg>")


def test_the_exported_spec_round_trips(tmp_path, demo):
    written = demo.export_all(tmp_path)
    again = HoleSpec.load(written["spec"])
    assert again.hole_number == demo.spec.hole_number
    assert again.target().as_tuple() == pytest.approx(demo.spec.target().as_tuple())
    assert again.tee_distance() == demo.spec.tee_distance()


# --------------------------------------------------------------- project file
def test_a_project_file_loads_and_runs(tmp_path):
    spec = demo_spec()
    spec_path = tmp_path / "hole.json"
    spec.save(spec_path)
    from matchmove.camera import Intrinsics
    from matchmove.demo import demo_correspondences

    intr = Intrinsics.from_fov(1920, 1080, 78.0)
    cors = demo_correspondences(spec, intr)
    anchors = {
        str(frame): [
            {"anchor_id": c.anchor_id, "world": list(c.world.as_tuple()),
             "x": c.x, "y": c.y}
            for c in rows
        ]
        for frame, rows in cors.items()
    }
    project_file = tmp_path / "project.json"
    project_file.write_text(json.dumps({
        "hole_spec": "hole.json",
        "camera": {"width": 1920, "height": 1080, "fps": 30, "hfov_deg": 78.0,
                   "footage": "TEST.MOV"},
        "anchors": anchors,
        "terrain": {"samples": []},
    }))
    project = load_project(project_file).run(step=10)
    assert project.report.ok
    assert project.track.solve_error_px < 1.0


def test_a_project_without_anchors_or_a_track_refuses_to_guess():
    from matchmove.camera import Intrinsics

    project = Project(spec=demo_spec(), intrinsics=Intrinsics.from_fov(1920, 1080, 78.0))
    with pytest.raises(ProjectError):
        project.solve()


def test_the_shipped_templates_are_valid_json():
    from matchmove.templates import HOLE_SPEC_TEMPLATE, PROJECT_TEMPLATE

    project = json.loads(PROJECT_TEMPLATE)
    hole = json.loads(HOLE_SPEC_TEMPLATE)
    assert "anchors" in project and "camera" in project
    spec = HoleSpec.from_dict(hole)
    assert spec.green() is not None
