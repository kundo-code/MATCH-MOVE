"""Single-frame SVG preview - the fastest way to eyeball a solve.

Draws the overlay exactly as the compositor would, optionally over the drone
frame itself (pass ``image_href`` to reference the plate).  The plate is only
ever referenced, never modified.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Sequence

from ..camera import CameraTrack
from ..overlay import ElementKind, RenderedElement
from ..sequence import FrameRender


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def _path_d(line: Sequence[tuple], closed: bool) -> str:
    if not line:
        return ""
    d = f"M {line[0][0]:.1f} {line[0][1]:.1f}"
    for x, y in line[1:]:
        d += f" L {x:.1f} {y:.1f}"
    return d + (" Z" if closed and len(line) > 2 else "")


def svg_frame(
    render: FrameRender,
    track: CameraTrack,
    image_href: Optional[str] = None,
    title: str = "",
) -> str:
    w, h = track.intrinsics.width, track.intrinsics.height
    parts: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" font-family="Inter, Helvetica Neue, Arial, sans-serif">',
        '<defs><filter id="mmGlow" x="-40%" y="-40%" width="180%" height="180%">'
        '<feGaussianBlur stdDeviation="2.2" result="b"/>'
        '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>'
        '</filter></defs>',
    ]
    if image_href:
        parts.append(f'<image href="{_esc(image_href)}" x="0" y="0" width="{w}" height="{h}"/>')
    else:
        parts.append(f'<rect width="{w}" height="{h}" fill="#10161b"/>')

    for e in render.elements:
        parts.extend(_element_svg(e, w, h))

    if title:
        parts.append(
            f'<text x="{w - 28}" y="{h - 26}" text-anchor="end" fill="#ffffff" '
            f'opacity="0.5" font-size="20" letter-spacing="2">{_esc(title)}</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def _element_svg(e: RenderedElement, w: int, h: int) -> List[str]:
    out: List[str] = []
    color = str(e.style.get("color", "#ffffff"))
    width = float(e.style.get("width", 1.2))
    fill_op = float(e.style.get("fill", 0.0) or 0.0)
    dash = e.style.get("dash")
    op = e.opacity * (0.35 if e.occluded else 1.0)
    if op <= 0.01:
        return out

    if e.kind is ElementKind.HUD:
        out.append(
            f'<g opacity="{op:.3f}">'
            f'<rect x="56" y="56" width="470" height="112" rx="4" fill="#000000" '
            f'fill-opacity="0.34"/>'
            f'<text x="84" y="112" fill="{color}" font-size="44" letter-spacing="5" '
            f'font-weight="300">{_esc(e.label)}</text>'
            f'<text x="84" y="146" fill="{color}" opacity="0.82" font-size="21" '
            f'letter-spacing="3">{_esc(e.sublabel)}</text></g>'
        )
        return out

    stroke_dash = ""
    if isinstance(dash, (list, tuple)) and dash:
        stroke_dash = f' stroke-dasharray="{" ".join(str(d) for d in dash)}"'

    for line in e.polylines:
        if len(line) < 2:
            continue
        d = _path_d(line, e.closed)
        fill = f'{color}' if fill_op > 0 else "none"
        glow = ' filter="url(#mmGlow)"' if e.kind is ElementKind.TARGET else ""
        out.append(
            f'<path d="{d}" fill="{fill}" fill-opacity="{fill_op:.3f}" stroke="{color}" '
            f'stroke-width="{width * 1.6:.2f}" stroke-opacity="{op:.3f}" '
            f'stroke-linejoin="round" stroke-linecap="round"{stroke_dash}{glow}/>'
        )

    if e.anchor_px is not None and e.label and e.kind is not ElementKind.HUD:
        x, y = e.anchor_px
        size = 19 if e.kind in (ElementKind.TARGET, ElementKind.ZONE) else 16
        dy = -26 if e.kind is ElementKind.TARGET else 22
        text_w = max(90.0, len(e.label) * size * 0.62 + 26)
        out.append(
            f'<g opacity="{op:.3f}">'
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.4" fill="{color}"/>'
            f'<rect x="{x - text_w / 2:.1f}" y="{y + dy - size:.1f}" width="{text_w:.1f}" '
            f'height="{size + 12:.1f}" rx="3" fill="#000000" fill-opacity="0.32"/>'
            f'<text x="{x:.1f}" y="{y + dy:.1f}" text-anchor="middle" fill="{color}" '
            f'font-size="{size}" letter-spacing="2.2">{_esc(e.label)}</text></g>'
        )
    return out


def export_svg_frame(
    path: str | Path,
    render: FrameRender,
    track: CameraTrack,
    image_href: Optional[str] = None,
    title: str = "",
) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(svg_frame(render, track, image_href, title), encoding="utf-8")
    return p
