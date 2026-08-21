"""Command line interface.

    matchmove init       hole07/                   # new hole, ready to fill in
    matchmove template project > project.json      # section 35 input template
    matchmove solve      project.json              # camera solve + residuals
    matchmove validate   project.json              # section 36 report only
    matchmove brief      project.json              # per-hole data block
    matchmove prompt     [project.json]            # master prompt (+ hole data)
    matchmove render     project.json -o out/      # full pipeline + all exports
    matchmove demo -o out/                         # synthetic end-to-end demo
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import __version__
from .project import Project, ProjectError, load_project
from .solve import SolveError
from .prompt import master_prompt_text
from .templates import HOLE_SPEC_TEMPLATE, PROJECT_TEMPLATE


def _load(path: str) -> Project:
    try:
        return load_project(path)
    except FileNotFoundError as exc:
        print(f"error: cannot open {exc.filename}", file=sys.stderr)
        print("hint: run `matchmove init <folder>` to create a matching "
              "project.json + hole.json pair", file=sys.stderr)
        raise SystemExit(2)
    except json.JSONDecodeError as exc:
        print(f"error: {path} is not valid JSON - {exc}", file=sys.stderr)
        raise SystemExit(2)
    except (ProjectError, ValueError, KeyError, TypeError) as exc:
        print(f"error: {path} could not be read: {exc}", file=sys.stderr)
        raise SystemExit(2)


def cmd_template(args: argparse.Namespace) -> int:
    text = PROJECT_TEMPLATE if args.kind == "project" else HOLE_SPEC_TEMPLATE
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"wrote {args.output}")
    else:
        print(text)
    return 0


def cmd_init(args: argparse.Namespace) -> int:
    """Create a ready-to-fill project folder with matching file names."""
    folder = Path(args.folder)
    if folder.exists() and any(folder.iterdir()) and not args.force:
        print(f"error: {folder} already exists and is not empty "
              "(pass --force to overwrite)", file=sys.stderr)
        return 2
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "hole.json").write_text(HOLE_SPEC_TEMPLATE, encoding="utf-8")
    (folder / "project.json").write_text(PROJECT_TEMPLATE, encoding="utf-8")
    print(f"created {folder}/hole.json      <- hole data: green, tee, bunkers, distances")
    print(f"created {folder}/project.json   <- camera, anchor points, terrain")
    print()
    print("next:")
    print(f"  1. fill in {folder}/hole.json from the yardage book and course map")
    print(f"  2. mark 4+ fixed landmarks per frame in {folder}/project.json")
    print(f"  3. matchmove render {folder}/project.json -o out/")
    print()
    print("every field you cannot confirm should stay null - the pipeline omits")
    print("unconfirmed data instead of inventing it.")
    return 0


def cmd_solve(args: argparse.Namespace) -> int:
    project = _load(args.project)
    try:
        track = project.solve()
    except (ProjectError, SolveError) as exc:
        print(f"solve failed: {exc}", file=sys.stderr)
        return 2
    first, last = track.frame_range
    print(f"solved frames {first}-{last} ({track.duration_s:.2f}s @ {track.fps:g}fps)")
    print(f"intrinsics: {track.intrinsics.width}x{track.intrinsics.height}, "
          f"focal {track.intrinsics.focal_px:.1f}px, "
          f"hfov {track.intrinsics.hfov_deg:.1f}deg")
    for s in project.solves:
        flag = "" if s.ok else "   <-- above 2.0px"
        print(f"  frame {s.frame:>6}: {s.n_points} anchors, "
              f"rms {s.rms_px:.3f}px, max {s.max_px:.3f}px{flag}")
    if track.solve_error_px is not None:
        print(f"worst-frame RMS: {track.solve_error_px:.3f}px")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    project = _load(args.project)
    project.solve()
    project.build()
    report = project.verify()
    print(report.text())
    return 0 if report.ok else 1


def cmd_brief(args: argparse.Namespace) -> int:
    project = _load(args.project)
    project.run(step=args.step)
    print(project.brief().hole_block())
    return 0


def cmd_prompt(args: argparse.Namespace) -> int:
    if not args.project:
        print(master_prompt_text())
        return 0
    project = _load(args.project)
    project.run(step=args.step)
    print(project.brief().full_prompt())
    return 0


def cmd_render(args: argparse.Namespace) -> int:
    project = _load(args.project)
    project.run(step=args.step)
    report = project.report
    written = project.export_all(args.output)
    print(report.text() if report else "")
    print("\nWROTE")
    for name, path in written.items():
        print(f"  {name:<14} {path}")
    if report is not None and not report.ok:
        print("\nvalidation failed: unverified information was stripped, not invented.",
              file=sys.stderr)
        return 1
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    from .demo import build_demo_project

    project = build_demo_project()
    project.run(step=args.step)
    written = project.export_all(args.output)
    print(project.report.text() if project.report else "")
    print("\nWROTE")
    for name, path in written.items():
        print(f"  {name:<14} {path}")
    print("\nNOTE: the demo hole is synthetic test geometry, not a real golf course.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="matchmove",
        description="Golf course drone match move / course intelligence pipeline",
    )
    p.add_argument("--version", action="version", version=f"matchmove {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    i = sub.add_parser("init", help="create a new hole folder ready to fill in")
    i.add_argument("folder")
    i.add_argument("--force", action="store_true",
                   help="overwrite an existing non-empty folder")
    i.set_defaults(func=cmd_init)

    t = sub.add_parser("template", help="print a section 35 input template")
    t.add_argument("kind", choices=["project", "hole"], nargs="?", default="project")
    t.add_argument("-o", "--output")
    t.set_defaults(func=cmd_template)

    s = sub.add_parser("solve", help="solve the camera and report residuals")
    s.add_argument("project")
    s.set_defaults(func=cmd_solve)

    v = sub.add_parser("validate", help="run the section 36 final validation")
    v.add_argument("project")
    v.set_defaults(func=cmd_validate)

    b = sub.add_parser("brief", help="print the verified per-hole data block")
    b.add_argument("project")
    b.add_argument("--step", type=int, default=2)
    b.set_defaults(func=cmd_brief)

    pr = sub.add_parser("prompt", help="print the master prompt, optionally filled")
    pr.add_argument("project", nargs="?")
    pr.add_argument("--step", type=int, default=2)
    pr.set_defaults(func=cmd_prompt)

    r = sub.add_parser("render", help="run the pipeline and write every export")
    r.add_argument("project")
    r.add_argument("-o", "--output", default="out")
    r.add_argument("--step", type=int, default=1)
    r.set_defaults(func=cmd_render)

    d = sub.add_parser("demo", help="run the synthetic demo hole end to end")
    d.add_argument("-o", "--output", default="out/demo")
    d.add_argument("--step", type=int, default=2)
    d.set_defaults(func=cmd_demo)

    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
