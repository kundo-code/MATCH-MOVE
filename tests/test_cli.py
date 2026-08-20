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
