# GOLF COURSE DRONE MATCH MOVE — COURSE INTELLIGENCE MASTER PROMPT v1.0

Create a hyper-realistic cinematic golf-course course-guide visualization using the supplied golf course reference materials.

The objective is not to redesign or recreate the golf course.
The objective is to analyze the actual golf hole, understand its spatial structure, and overlay accurate golf-course information onto the supplied drone footage using professional:

3D Camera Tracking + Match Move + Motion Tracking + Ground/Surface Tracking + Terrain-Aware AR Graphics.

The final result should feel like:
Professional Drone Cinematography × Premium Golf Broadcast × Course Strategy Guide × Spatial AR Visualization

## 01. REFERENCE ASSETS

Use all supplied reference materials together.

### A. DRONE FOOTAGE / AERIAL STILL
Primary visual reference for: actual terrain, camera movement, perspective, elevation, fairway, rough, green, bunkers, water, trees, vegetation, cart paths, buildings, surrounding landscape.
The supplied drone footage is the primary visual ground truth.

### B. COURSE MAP / KAKAO MAP
Reference for: hole orientation, Tee location, Green location, overall hole geometry, fairway direction, dogleg structure, surrounding course relationships, major terrain landmarks, water locations, bunker locations, spatial cross-checking.
Use visible landmarks to establish spatial correspondence between the map and drone footage.

### C. YARDAGE BOOK
Primary golf-information reference for: Hole Number, Par, Tee distances, hole length, bunker locations, bunker distances, water / penalty-area information, OB information, landing zones, strategic distances, green information, course-specific markings.
Interpret all symbols according to the supplied yardage-book legend when available.

### D. OPTIONAL OFFICIAL DATA
Official Course Map, GPS Course Data, Scorecard, Course Guide, Green Map, Official Hole Description.
Official information takes priority over visual estimation.

## 02. SOURCE PRIORITY

1. Official Golf Course Data
2. Yardage Book
3. Course Map / Satellite Map
4. Drone Footage
5. Visual Estimation

Never replace reliable supplied information with visual guesswork.

## 03. DATA CONFIDENCE SYSTEM

- **A — CONFIRMED**: official course information or reliable yardage-book data (Hole Number, Par, official distance, confirmed OB, confirmed Penalty Area).
- **B — VISUALLY MATCHED**: clearly identifiable through correspondence between map, yardage book and drone footage (Green, Tee, bunker, visible water, fairway geometry).
- **C — ESTIMATED**: inferred only through visual analysis.

Do NOT present estimated information as official course data.
When reliable information cannot be established: **OMIT IT RATHER THAN FABRICATE IT.**

## 04. COURSE FEATURE RECOGNITION

Identify the actual TEE BOX, FAIRWAY, ROUGH, GREEN, FRINGE, BUNKERS, WATER, PENALTY AREAS, OUT OF BOUNDS, CART PATH, MAJOR TREES, LANDMARKS, TERRAIN FEATURES.
Cross-reference their relative positions between the course map, yardage book and drone footage.

## 05. SPATIAL ANCHOR MATCHING

Establish reliable spatial Anchor Points before adding graphics, in priority order:
Green Center, Tee Box, Major Bunkers, Water Boundaries, Fairway Curves, Cart Paths, Tree Lines, Buildings, Terrain Ridges, other permanent landmarks.
Match these features between COURSE MAP ↔ YARDAGE BOOK ↔ DRONE FOOTAGE.

## 06. CAMERA ANALYSIS

Analyze camera position, flight direction, altitude, pitch, yaw, roll, focal length, field of view, camera translation, camera rotation, perspective, horizon and terrain depth.
Reconstruct the approximate camera movement necessary for accurate 3D overlay placement.

## 07. MATCH MOVE

Perform accurate 3D Camera Tracking, Match Move, Motion Tracking, Ground Plane Tracking, Surface Tracking, Perspective Matching.
All course-information graphics must remain locked to their corresponding real-world positions.
Graphics must NEVER float, drift, slide, shake, lag, detach from terrain, or change position incorrectly.
Every marker must appear physically anchored within the real golf course.

## 08. TERRAIN-AWARE TRACKING

Respect elevation, slopes, depressions, hills, bunker depth, water level, green surface and fairway undulation.
Apply Perspective Scaling, Depth Scaling, Surface Alignment, Terrain Conformation and Occlusion.
Ground graphics must conform naturally to the terrain rather than appearing as flat graphics floating above the image.

## 09. OCCLUSION

All AR graphics must respect foreground objects (trees, terrain ridges, buildings, bunkers, hills).
The graphic disappears behind the physical object and reappears naturally when visible again.

## 10. HOLE INFORMATION

At the opening of the hole sequence display:

```
HOLE [00]
PAR [0]
[000]m / [000]yd
```

Optional: `[WHITE / BLUE / BLACK / RED] TEE`. Use only reliable distance data.

## 11. STANDARDIZED GREEN TARGET

For every hole, use the GREEN CENTER as the standardized target point.
Do NOT attempt to reproduce or estimate the actual daily pin position.
The Green Center represents a standardized strategic target for course-guide visualization. It does NOT represent the actual daily hole-cup location.

## 12. GREEN CENTER DETECTION

Analyze course map, yardage book, aerial image and drone footage to determine the actual visible boundary and geometry of the putting green. Estimate the geometric center of the putting surface and place the standardized target precisely at that position.
Display `GREEN CENTER` or `CENTER`. Never label this marker `PIN` or `HOLE CUP`.

## 13. GREEN CENTER MARKER

Place a subtle premium flag-style 3D marker at the Green Center. It must remain anchored to the green, follow terrain perspective, maintain Match Move tracking, scale according to camera distance, respect foreground occlusion and remain visually stable. It must never float or slide.
The flag is a visual target marker, not an actual daily pin representation.

## 14. DISTANCE TO GREEN CENTER

When reliable distance data exists: `TEE → GREEN CENTER: [000]m`.
During the approach sequence: `TO CENTER: [000]m`. Optional: `CENTER: [000]m`.
Never fabricate precise distance values.

## 15. TEE-TO-GREEN ROUTE

Visualize TEE → LANDING ZONE → APPROACH → GREEN CENTER with a subtle 3D trajectory or terrain-conforming route line.
Do not automatically draw a straight line. Analyze actual fairway shape, dogleg, hazards, bunker placement, water and Green position, and visualize a plausible strategic route only when sufficient information is available.

## 16. LANDING ZONE

When supported by reliable course information or clearly interpretable strategic geometry, mark `LANDING ZONE` as a subtle terrain-conforming ellipse, circle or soft surface highlight.
Optional: `TEE → LANDING ZONE: [000]m`, `LANDING ZONE → CENTER: [000]m`. Do not fabricate exact landing-zone distances.

## 17. BUNKER DETECTION

Identify actual bunkers by cross-referencing YARDAGE BOOK ↔ MAP ↔ DRONE. Track each bunker to its actual location.
Optional labels: `FAIRWAY BUNKER`, `GREENSIDE BUNKER`. When reliable distance information exists: `TO BUNKER: [000]m` or `CARRY: [000]m`.
Do not change bunker geometry.

## 18. WATER

Visible water may be marked `WATER` when its physical location is clearly identifiable, using subtle boundary tracing, terrain-conforming outline or translucent surface indication.
Do NOT automatically classify visible water as an official Penalty Area unless supported by reliable course information.

## 19. PENALTY AREA

When officially confirmed, display `RED PENALTY AREA` or `YELLOW PENALTY AREA`, following the official boundary information as closely as possible with restrained AR boundary visualization.
Never infer Red or Yellow classification solely from water appearance.

## 20. OUT OF BOUNDS

Display `OB` only when the Out of Bounds location is supported by reliable information. Trace the confirmed boundary using a thin boundary line, subtle ground indication or small OB markers.
Never assume forest = OB, road = OB, or course boundary = OB unless confirmed.

## 21. FAIRWAY / ROUGH

Identify Fairway, First Cut, Rough and Deep Rough when clearly visible. Do not recolor the entire golf course.
If highlighting is necessary, use only subtle edge tracing, soft masks or terrain contours. Preserve the natural appearance of the course.

## 22. GREEN ANALYSIS

As the drone approaches the Green Center, transition into GREEN ANALYSIS MODE. Identify Green boundary, Green Center, surrounding bunkers, surrounding water, approach direction and confirmed slope information.
Reduce unnecessary information from earlier stages to keep the frame clean.

## 23. GREEN SLOPE

Only display detailed green-slope information when reliable green-map or slope data is supplied.
If numerical slope information is confirmed: `↘ 2.3%`. Without reliable numerical data, do NOT fabricate slope percentages.
When only the general slope direction can be reliably determined, use `SLOPE DIRECTION` with directional visualization rather than an invented number.

## 24. GREEN CONTOUR

When reliable contour/elevation information exists, overlay subtle GREEN CONTOUR LINES that conform to the green surface, respect perspective, remain semi-transparent and thin, and avoid covering grass texture.
Do not fabricate detailed contours from insufficient visual information.

## 25. INFORMATION REVEAL SEQUENCE

Do NOT display every piece of information simultaneously. Reveal information progressively according to the drone's movement.

- **PHASE 01 — ESTABLISHING**: wide aerial overview. Display HOLE / PAR / distance.
- **PHASE 02 — TEE SHOT**: introduce TEE, LANDING ZONE, TEE → CENTER. Highlight major tee-shot risks (fairway bunker, water, penalty area, OB). Visualize the strategic playing direction.
- **PHASE 03 — LANDING ZONE**: highlight LANDING ZONE and nearby risks. Optional `TO CENTER: [000]m`. Remove unnecessary Tee information.
- **PHASE 04 — APPROACH**: shift emphasis to GREEN CENTER. Highlight approach route, greenside bunkers, water, confirmed penalty areas, OB and remaining distance. Display `TO CENTER: [000]m`.
- **PHASE 05 — GREEN**: approach the putting surface. Reduce course-wide graphics. Highlight GREEN CENTER and relevant surrounding hazards.
- **PHASE 06 — GREEN ANALYSIS**: when reliable information exists, reveal Green Shape, Green Center, Green Contours, Slope Direction, Slope Percentage, Greenside Bunkers. Final visual focus: GREEN CENTER.

## 26. INFORMATION HIERARCHY

1. WHAT HOLE IS THIS? — Hole / Par / Distance
2. WHERE SHOULD I HIT? — Target / Landing Zone
3. WHERE IS THE DANGER? — Bunker / Water / Penalty Area / OB
4. HOW FAR IS THE TARGET? — Distance to Green Center
5. HOW SHOULD I APPROACH? — Approach Route
6. WHAT IS THE GREEN LIKE? — Green Center / Slope / Contour

## 27. GRAPHIC DESIGN

Premium Golf Broadcast × Professional Yardage Guide × Modern Spatial AR.
Premium, minimal, elegant, technical, cinematic, highly legible.
Use thin lines, subtle translucent panels, restrained glow, clean typography, small professional icons, elegant 3D markers.
Avoid arcade-game HUD, excessive neon, cartoon graphics, giant markers, excessive text, aggressive animations.
The actual golf course must remain the visual hero.

## 28. MOTION GRAPHICS

Restrained professional animations: Fade In, Line Draw, Soft Scale Up, Subtle Pulse.
Route animation: TEE → LANDING ZONE → APPROACH → GREEN CENTER.
Information should appear only when relevant to the current camera position.

## 29. CINEMATIC CAMERA STYLE

Preserve the supplied drone footage whenever actual footage is provided.
When camera motion must be generated or extended, use a slow cinematic dolly forward / push-in with optional subtle descending movement.
Maintain extreme depth of field so foreground terrain and distant course features remain readable.
Movement must be slow, stable, smooth, majestic, physically believable and professionally stabilized.
Avoid FPV-style aggressive flight, excessive yaw, sudden acceleration, artificial zoom and unrealistic camera movement.

## 30. VISUAL QUALITY

Hyper-realistic, 4K, extreme depth of field, professional cinematography, natural atmospheric perspective, realistic sunlight, natural shadows, detailed grass texture, realistic water reflection, natural vegetation, accurate terrain depth.
Preserve the actual atmosphere and identity of the golf course.

## 31. REFERENCE PRESERVATION — CRITICAL

Never redesign the supplied golf course. Do NOT relocate bunkers, move the Green, move Tee Boxes, change fairway geometry, change water boundaries, straighten doglegs, create fictional hazards, remove important trees, change mountains, modify buildings or create fictional terrain.
The original course geography must remain intact.

## 32. ANTI-HALLUCINATION RULE — CRITICAL

Never fabricate exact distances, OB boundaries, Red Penalty Areas, Yellow Penalty Areas, bunker distances, Green slope percentages, contour data or course strategy information when reliable source information is unavailable.
When uncertain: **OMIT THE DATA.** Do not visually present assumptions as facts.

## 33. GREEN CENTER RULE — CRITICAL

Never attempt to determine the actual daily hole-cup location.
For all holes: **TARGET = GREEN CENTER**, the approximate geometric center of the actual putting surface.
This rule must remain consistent throughout the entire golf-course video series.

## 34. FINAL OUTPUT OBJECTIVE

HOLE OVERVIEW → TEE SHOT → LANDING ZONE → RISK / HAZARD → APPROACH → GREEN CENTER → GREEN ANALYSIS.
The viewer should intuitively understand: Where am I? Where should I hit? Where is the danger? How far is the target? How should I approach the Green? What is the Green structure? — without distracting from the natural beauty of the golf course.
The final result should feel like a professional golfer and caddie are explaining the hole through a cinematic aerial AR visualization.

## 36. FINAL VALIDATION

- **COURSE IDENTITY**: correct golf course, correct course, correct hole.
- **GEOMETRY**: Tee matched, Green matched, fairway geometry matched, major bunkers matched, water matched.
- **DATA**: Par verified, distance verified, OB verified when displayed, Penalty Area verified when displayed.
- **TRACKING**: no floating graphics, no sliding markers, no tracking drift, correct perspective, correct scale, correct occlusion.
- **GREEN**: actual pin NOT estimated, Green Center used as Target, Green Center correctly anchored.
- **VISUAL**: original course preserved, graphics remain minimal, information remains readable, natural course scenery remains dominant.

If any data fails verification: **REMOVE OR SIMPLIFY THE UNVERIFIED INFORMATION RATHER THAN INVENTING IT.**
