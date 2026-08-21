"""Nuke/3DEqualizer .chan camera export.

One line per frame: ``frame tx ty tz rx ry rz vfov`` - the interchange format
every match-move package reads.  Axis convention is the standard Y-up VFX one,
converted from the system's Z-up ENU frame.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Sequence

from ..camera import CameraTrack


def _enu_to_yup(x: float, y: float, z: float):
    # ENU (X east, Y north, Z up) -> VFX (X right, Y up, Z toward viewer)
    return x, z, -y


def chan_lines(track: CameraTrack, frames: Optional[Sequence[int]] = None) -> list[str]:
    first, last = track.frame_range
    frame_list = list(frames) if frames is not None else list(range(first, last + 1))
    out: list[str] = []
    for f in frame_list:
        pose = track.pose_at(f)
        tx, ty, tz = _enu_to_yup(*pose.position.as_tuple())
        # Nuke rotation order ZXY, degrees; yaw about Y, pitch about X.
        rx = pose.pitch
        ry = -pose.yaw
        rz = pose.roll
        intr = track.intrinsics_at(f)
        out.append(
            f"{f} {tx:.6f} {ty:.6f} {tz:.6f} {rx:.6f} {ry:.6f} {rz:.6f} {intr.vfov_deg:.6f}"
        )
    return out


def export_chan(path: str | Path, track: CameraTrack) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(chan_lines(track)) + "\n", encoding="utf-8")
    return p
