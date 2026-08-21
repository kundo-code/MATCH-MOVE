"""The command line entry points."""

import json

import pytest

from matchmove.cli import main


def test_template_emits_valid_json(capsys):
    assert main(["template", "project"]) == 0
    json.loads(capsys.readouterr().out)
    assert main(["template", "hole"]) == 0
    json.loads(capsys.readouterr().out)


def test_prompt_without_a_project_prints_the_master_prompt(capsys):
    assert main(["prompt"]) == 0
    out = capsys.readouterr().out
    assert "COURSE INTELLIGENCE MASTER PROMPT v1.0" in out
    assert "ANTI-HALLUCINATION RULE" in out
    assert "GREEN CENTER RULE" in out


def test_demo_runs_end_to_end(tmp_path, capsys):
    assert main(["demo", "-o", str(tmp_path), "--step", "10"]) == 0
    out = capsys.readouterr().out
    assert "RESULT: PASS" in out
    assert (tmp_path / "hole07_preview.html").exists()
    assert "not a real golf course" in out


def test_solve_reports_residuals(tmp_path, capsys, demo_project_file):
    assert main(["solve", str(demo_project_file)]) == 0
    out = capsys.readouterr().out
    assert "solved frames" in out
    assert "worst-frame RMS" in out


def test_validate_returns_zero_when_the_hole_checks_out(demo_project_file, capsys):
    assert main(["validate", str(demo_project_file)]) == 0
    assert "RESULT: PASS" in capsys.readouterr().out


def test_render_writes_every_export(tmp_path, demo_project_file, capsys):
    out_dir = tmp_path / "render"
    assert main(["render", str(demo_project_file), "-o", str(out_dir), "--step", "10"]) == 0
    printed = capsys.readouterr().out
    assert "WROTE" in printed
    assert (out_dir / "hole07_overlay.json").exists()
    assert (out_dir / "hole07_brief.md").exists()


def test_a_broken_project_file_exits_cleanly(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text('{"camera": {}}')
    with pytest.raises(SystemExit) as exc:
        main(["validate", str(bad)])
    assert exc.value.code == 2


def test_init_creates_a_pair_that_actually_loads(tmp_path, capsys):
    """The two generated files must reference each other by the right name."""
    folder = tmp_path / "hole07"
    assert main(["init", str(folder)]) == 0
    assert (folder / "hole.json").exists()
    assert (folder / "project.json").exists()

    from matchmove.project import load_project

    project = load_project(folder / "project.json")   # must not raise
    assert project.spec.green() is not None
    assert project.correspondences, "template ships example anchor frames"


def test_init_refuses_to_clobber_an_existing_folder(tmp_path, capsys):
    folder = tmp_path / "hole07"
    assert main(["init", str(folder)]) == 0
    assert main(["init", str(folder)]) == 2
    assert "already exists" in capsys.readouterr().err
    assert main(["init", str(folder), "--force"]) == 0


def test_documentation_keys_do_not_reach_the_parser(tmp_path):
    """Templates annotate themselves with _help notes next to real values."""
    from matchmove.project import load_project, strip_help_keys

    folder = tmp_path / "hole07"
    main(["init", str(folder)])
    raw = json.loads((folder / "project.json").read_text())
    assert any(k.startswith("_") for k in raw["anchors"]), "template has a _help note"
    cleaned = strip_help_keys(raw)
    assert all(not k.startswith("_") for k in cleaned["anchors"])
    load_project(folder / "project.json")


def test_the_template_solve_fails_loudly_on_placeholder_anchors(tmp_path, capsys):
    """Shipped example pixels are placeholders; the report must say so, not pass."""
    folder = tmp_path / "hole07"
    main(["init", str(folder)])
    assert main(["validate", str(folder / "project.json")]) == 1
    out = capsys.readouterr().out
    assert "reprojection error" in out
    assert "RESULT: FAIL" in out


def test_malformed_json_reports_the_problem_without_a_traceback(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json at all")
    with pytest.raises(SystemExit) as exc:
        main(["validate", str(bad)])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert "not valid JSON" in err


def test_a_missing_hole_spec_suggests_the_fix(tmp_path, capsys):
    project = tmp_path / "project.json"
    project.write_text(json.dumps({
        "hole_spec": "nope.json",
        "camera": {"width": 1920, "height": 1080, "hfov_deg": 78.0},
        "anchors": {},
    }))
    with pytest.raises(SystemExit) as exc:
        main(["validate", str(project)])
    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert "matchmove init" in err
