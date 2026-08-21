"""Self-contained HTML QC player.

Scrub the solved shot frame by frame, watch the six-phase reveal fire, and
read the validation verdict and the omission list next to the picture.  This
is the review tool: if a marker slides, drifts or floats, it shows up here
before anything reaches a compositor.

The page embeds the overlay track and needs no server and no network.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional, Sequence

from ..camera import CameraTrack
from ..sequence import FrameRender, PhaseSequence
from ..spec import HoleSpec
from ..validate import ValidationReport
from .overlay_json import overlay_track_dict

_TEMPLATE = """<title>__TITLE__</title>
<style>
:root{
  --bg:#f4f6f8; --panel:#ffffff; --ink:#12181d; --muted:#5b6873; --line:#dde3e9;
  --accent:#1f6f4a; --warn:#b4761a; --fail:#b3352c; --pass:#1f6f4a;
}
:root:not([data-theme="light"]){ }
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0e1317; --panel:#161d23; --ink:#e8eef3; --muted:#93a1ad; --line:#26313a;
    --accent:#6fd3a0; --warn:#e0b155; --fail:#e78b82; --pass:#6fd3a0;
  }
}
:root[data-theme="dark"]{
  --bg:#0e1317; --panel:#161d23; --ink:#e8eef3; --muted:#93a1ad; --line:#26313a;
  --accent:#6fd3a0; --warn:#e0b155; --fail:#e78b82; --pass:#6fd3a0;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;
  border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px}
h1{font-size:20px;font-weight:600;margin:0;letter-spacing:.2px}
.sub{color:var(--muted);font-size:13px}
.badge{margin-left:auto;font-size:12px;letter-spacing:1.4px;padding:4px 10px;
  border-radius:3px;border:1px solid currentColor;text-transform:uppercase}
.badge.pass{color:var(--pass)} .badge.fail{color:var(--fail)}
.stage{position:relative;background:#0b0f12;border-radius:6px;overflow:hidden;
  border:1px solid var(--line)}
canvas{display:block;width:100%;height:auto}
.controls{display:flex;gap:14px;align-items:center;margin:14px 0 6px;flex-wrap:wrap}
button{font:inherit;font-size:13px;padding:6px 14px;border-radius:4px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);color:var(--ink)}
button:hover{border-color:var(--accent)}
input[type=range]{flex:1;min-width:220px;accent-color:var(--accent)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.phases{display:flex;gap:3px;margin:10px 0 22px}
.phases div{flex:1;padding:7px 8px;border-radius:3px;background:var(--panel);
  border:1px solid var(--line);font-size:10.5px;letter-spacing:.8px;text-align:center;
  color:var(--muted);text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;transition:.18s}
.phases div.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:16px 18px}
.card h2{font-size:12px;letter-spacing:1.6px;text-transform:uppercase;color:var(--muted);
  margin:0 0 12px}
ul{margin:0;padding-left:17px} li{margin-bottom:5px}
.chk{display:flex;gap:9px;align-items:flex-start;margin-bottom:7px;font-size:13px}
.tag{font-size:9.5px;letter-spacing:1px;padding:2px 6px;border-radius:2px;margin-top:2px;
  flex:0 0 auto;border:1px solid currentColor}
.tag.pass{color:var(--pass)} .tag.warn{color:var(--warn)} .tag.fail{color:var(--fail)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:11px;letter-spacing:1px;text-transform:uppercase}
.scroll{overflow-x:auto}
footer{margin-top:34px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);
  padding-top:14px}
</style>
<div class="wrap">
<header>
  <div>
    <h1>__HEADING__</h1>
    <div class="sub">__SUBHEADING__</div>
  </div>
  <span class="badge __VERDICT_CLASS__">__VERDICT__</span>
</header>

<div class="stage"><canvas id="stage"></canvas></div>
<div class="controls">
  <button id="play">▶ Play</button>
  <input type="range" id="scrub" min="0" max="0" value="0">
  <span class="mono" id="readout">frame 0</span>
</div>
<div class="phases" id="phases"></div>

<div class="grid">
  <div class="card">
    <h2>Final validation — section 36</h2>
    <div id="checks"></div>
  </div>
  <div class="card">
    <h2>Omitted rather than fabricated — section 32</h2>
    <div id="omissions"></div>
  </div>
  <div class="card" style="grid-column:1/-1">
    <h2>Render list at this frame</h2>
    <div class="scroll"><table>
      <thead><tr><th>Element</th><th>Kind</th><th>Label</th><th>Depth</th>
      <th>px / m</th><th>Opacity</th><th>Occlusion</th></tr></thead>
      <tbody id="elements"></tbody>
    </table></div>
  </div>
</div>
<footer>__FOOTER__</footer>
</div>

<script id="track" type="application/json">__TRACK__</script>
<script>
const DATA = JSON.parse(document.getElementById('track').textContent);
const W = DATA.camera.intrinsics.width, H = DATA.camera.intrinsics.height;
const FPS = DATA.camera.fps || 30;
const PLATES = __PLATES__;
const cv = document.getElementById('stage');
cv.width = W; cv.height = H;
const ctx = cv.getContext('2d');
const frames = DATA.frames;
const scrub = document.getElementById('scrub');
scrub.max = String(frames.length - 1);
let idx = 0, playing = false, last = 0;

const plateCache = {};
function plate(frameNo){
  const src = PLATES[String(frameNo)];
  if (!src) return null;
  if (!plateCache[src]) { const im = new Image(); im.src = src; plateCache[src] = im; }
  return plateCache[src];
}

function drawPolys(e){
  const st = e.style || {};
  const op = e.opacity * (e.occluded ? 0.35 : 1);
  if (op <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.strokeStyle = st.color || '#fff';
  ctx.lineWidth = (st.width || 1.2) * 1.7;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (Array.isArray(st.dash)) ctx.setLineDash(st.dash.map(d => d * 1.6));
  if (e.kind === 'target'){ ctx.shadowColor = st.accent || st.color; ctx.shadowBlur = 12; }
  for (const line of e.polylines){
    if (line.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(line[0][0], line[0][1]);
    for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0], line[i][1]);
    if (e.closed && line.length > 2) ctx.closePath();
    if (st.fill){ ctx.globalAlpha = op * st.fill; ctx.fillStyle = st.color; ctx.fill();
                  ctx.globalAlpha = op; }
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabel(e){
  if (!e.anchor || !e.label || e.kind === 'hud') return;
  const st = e.style || {};
  const op = e.opacity * (e.occluded ? 0.3 : 1);
  if (op <= 0.01) return;
  const [x, y] = e.anchor;
  const size = (e.kind === 'target' || e.kind === 'zone') ? 21 : 18;
  const dy = e.kind === 'target' ? -30 : 26;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.font = '300 ' + size + 'px ui-sans-serif, system-ui, sans-serif';
  const w = ctx.measureText(e.label).width + 26;
  ctx.fillStyle = 'rgba(0,0,0,.36)';
  ctx.fillRect(x - w / 2, y + dy - size, w, size + 13);
  ctx.fillStyle = st.color || '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(e.label, x, y + dy + 2);
  ctx.beginPath(); ctx.arc(x, y, 3.6, 0, 6.284); ctx.fill();
  ctx.restore();
}

function drawHud(e){
  ctx.save();
  ctx.globalAlpha = e.opacity;
  ctx.fillStyle = 'rgba(0,0,0,.36)';
  ctx.fillRect(56, 56, 500, 116);
  ctx.fillStyle = (e.style && e.style.color) || '#fff';
  ctx.font = '300 46px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(e.label, 84, 116);
  ctx.font = '300 22px ui-sans-serif, system-ui, sans-serif';
  ctx.globalAlpha = e.opacity * 0.85;
  ctx.fillText(e.sublabel || '', 84, 150);
  ctx.restore();
}

function render(){
  const fr = frames[idx];
  ctx.clearRect(0, 0, W, H);
  const im = plate(fr.frame);
  if (im && im.complete && im.naturalWidth) ctx.drawImage(im, 0, 0, W, H);
  else { ctx.fillStyle = '#0b0f12'; ctx.fillRect(0, 0, W, H);
         drawGuides(); }
  for (const e of fr.elements){
    if (e.kind === 'hud') drawHud(e);
    else { drawPolys(e); drawLabel(e); }
  }
  document.getElementById('readout').textContent =
    'frame ' + fr.frame + '  ·  ' + (fr.frame / FPS).toFixed(2) + 's  ·  ' + fr.phase;
  for (const el of document.querySelectorAll('.phases div'))
    el.classList.toggle('on', el.dataset.name === fr.phase);
  const rows = fr.elements.map(e =>
    '<tr><td class="mono">' + e.id + '</td><td>' + e.kind + '</td><td>' +
    (e.label || e.sublabel || '—') + '</td><td class="mono">' +
    (isFinite(e.depth) ? e.depth.toFixed(1) + ' m' : '—') + '</td><td class="mono">' +
    (e.px_per_metre ? e.px_per_metre.toFixed(2) : '—') + '</td><td class="mono">' +
    e.opacity.toFixed(2) + '</td><td>' +
    (e.occluded ? 'behind ' + (e.occluder || 'object') : 'clear') + '</td></tr>').join('');
  document.getElementById('elements').innerHTML =
    rows || '<tr><td colspan="7">nothing drawn on this frame</td></tr>';
  scrub.value = String(idx);
}

function drawGuides(){
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += W / 12){ ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += H / 8){ ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,.22)';
  ctx.font = '300 22px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('no plate attached — overlay geometry only', W / 2, H - 40);
  ctx.restore();
}

scrub.addEventListener('input', () => { idx = +scrub.value; render(); });
document.getElementById('play').addEventListener('click', () => {
  playing = !playing;
  document.getElementById('play').textContent = playing ? '❚❚ Pause' : '▶ Play';
  last = performance.now();
  if (playing) requestAnimationFrame(tick);
});
function tick(now){
  if (!playing) return;
  if (now - last >= 1000 / FPS){
    last = now;
    idx = (idx + 1) % frames.length;
    render();
  }
  requestAnimationFrame(tick);
}
document.addEventListener('keydown', ev => {
  if (ev.key === 'ArrowRight'){ idx = Math.min(frames.length - 1, idx + 1); render(); }
  if (ev.key === 'ArrowLeft'){ idx = Math.max(0, idx - 1); render(); }
});

const seq = DATA.sequence;
if (seq){
  document.getElementById('phases').innerHTML = seq.phases.map(p =>
    '<div data-name="' + p.name + '">' + p.name.replace(/_/g, ' ') + '</div>').join('');
}
const val = DATA.validation;
if (val){
  document.getElementById('checks').innerHTML = val.checks.map(c =>
    '<div class="chk"><span class="tag ' + c.severity + '">' + c.severity.toUpperCase() +
    '</span><span><b>' + c.group + '</b> · ' + c.name +
    (c.detail ? '<br><span class="sub">' + c.detail + '</span>' : '') +
    '</span></div>').join('');
  document.getElementById('omissions').innerHTML = val.omissions.length
    ? '<ul>' + val.omissions.map(o => '<li><span class="mono">' + o.field +
      '</span> — ' + o.reason.replace(/_/g, ' ') +
      (o.detail ? '<br><span class="sub">' + o.detail + '</span>' : '') + '</li>').join('') + '</ul>'
    : '<p class="sub">Nothing was withheld: every supplied fact cleared its confidence floor.</p>';
}
render();
</script>
"""


def _embed(data: Dict) -> str:
    """JSON for a <script type="application/json"> block.

    A course name or note containing ``</script>`` would otherwise close the
    block early and break the page, so the sequence is escaped.
    """
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


def export_html_preview(
    path: str | Path,
    frames: Sequence[FrameRender],
    track: CameraTrack,
    spec: HoleSpec,
    seq: Optional[PhaseSequence] = None,
    report: Optional[ValidationReport] = None,
    plates: Optional[Dict[int, str]] = None,
) -> Path:
    """Write the QC player.

    ``plates`` maps frame number -> image URL (or data URI) for the drone
    frames.  Without it the overlay is drawn against a neutral grid, which is
    still enough to check tracking stability.
    """
    data = overlay_track_dict(frames, track, seq, report,
                              meta={"course": spec.course_name, "hole": spec.hole_number})
    verdict = "verified" if (report is None or report.ok) else "failed validation"
    heading = f"{spec.course_name or 'Course'} · Hole {spec.hole_number:02d}"
    par = f"Par {spec.par}" if spec.par else "Par not confirmed"
    dist = spec.tee_distance()
    dist_txt = f"{round(dist)}m" if dist is not None else "distance omitted (unconfirmed)"
    sub = (f"{par} · {dist_txt} · target: GREEN CENTER (standardised, not the daily hole cup)"
           f" · {len(frames)} frames @ {track.fps:g}fps")

    html = (_TEMPLATE
            .replace("__TITLE__", f"{heading} Match Move")
            .replace("__HEADING__", heading)
            .replace("__SUBHEADING__", sub)
            .replace("__VERDICT__", verdict)
            .replace("__VERDICT_CLASS__", "pass" if (report is None or report.ok) else "fail")
            .replace("__FOOTER__",
                     "Generated by matchmove against COURSE INTELLIGENCE MASTER PROMPT v1.0. "
                     "Graphics are locked to the solved camera; the original footage and course "
                     "geometry are never modified.")
            .replace("__PLATES__", json.dumps({str(k): v for k, v in (plates or {}).items()}))
            .replace("__TRACK__", _embed(data)))
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html, encoding="utf-8")
    return p
