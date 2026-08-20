"""Input templates - the section 35 data template, as fillable JSON.

Every ``_help`` key is documentation for whoever fills the file in and is
ignored by the loader.  Leave a value ``null`` when you do not have confirmed
information: null means "omit it", and omitting is always correct (section 32).
"""

from __future__ import annotations

PROJECT_TEMPLATE = r"""{
  "_help": "matchmove project file. Fill from the yardage book, the course map and the drone footage. Leave anything unconfirmed as null - the pipeline omits it rather than inventing it.",

  "hole_spec": "hole07_spec.json",
  "_help_hole_spec": "Path to a hole spec file, or an inline hole spec object with the same shape as `matchmove template hole`.",

  "camera": {
    "_help": "Drone camera metadata. Give focal_px, or hfov_deg, or focal_mm + sensor_width_mm. refine_focal lets the solver adjust focal length when the lens metadata is unreliable.",
    "width": 3840,
    "height": 2160,
    "fps": 30,
    "hfov_deg": 84.0,
    "focal_mm": null,
    "sensor_width_mm": null,
    "refine_focal": false,
    "footage": "DJI_0123.MOV"
  },

  "anchors": {
    "_help": "Section 05 spatial anchors. For each solved frame, list at least 4 permanent landmarks you can see in the drone frame and locate on the course map: x/y are pixel coordinates in that frame; world is [east, north, up] metres from the Green Center, or give lat/lon instead. Prefer things that cannot move - green edges, bunker lips, cart path junctions, building corners.",
    "0": [
      {"anchor_id": "green_center", "world": [0, 0, 0], "x": 1920, "y": 1180},
      {"anchor_id": "green_front_edge", "world": [0, -14, 0], "x": 1920, "y": 1290},
      {"anchor_id": "bunker_left_lip", "world": [-26, -9, 0], "x": 1600, "y": 1260},
      {"anchor_id": "cartpath_junction", "world": [38, -120, 0], "x": 2450, "y": 1720}
    ],
    "120": [
      {"anchor_id": "green_center", "world": [0, 0, 0], "x": 1918, "y": 1090},
      {"anchor_id": "green_front_edge", "world": [0, -14, 0], "x": 1918, "y": 1230},
      {"anchor_id": "bunker_left_lip", "world": [-26, -9, 0], "x": 1520, "y": 1190},
      {"anchor_id": "cartpath_junction", "world": [38, -120, 0], "x": 2610, "y": 1930}
    ]
  },

  "camera_track": null,
  "_help_camera_track": "Optional: a pre-solved camera track (path to JSON, or inline). Supply this instead of anchors when the shot was solved in SynthEyes, 3DEqualizer, Blender or PFTrack.",

  "terrain": {
    "_help": "Optional surveyed spot heights [east, north, up] in metres, from GPS course data, a green map or photogrammetry. Without these the system treats the hole as level and says so in the validation report - it does not invent undulation.",
    "samples": []
  }
}
"""

HOLE_SPEC_TEMPLATE = r"""{
  "_help": "Hole spec. Geometry is in metres, in a local ENU frame whose ORIGIN IS THE GREEN CENTER: +x east, +y north, +z up. So the green sits around [0,0,0] and the tee has a large negative coordinate along the hole axis.",

  "course_name": "",
  "hole_number": 0,
  "par": null,
  "datum": null,
  "_help_datum": "[lat, lon, alt] of the Green Center. Required only if you want to give anchors or features as lat/lon.",

  "primary_tee": "white",
  "tees": [
    {"_help": "Published tee length. confidence must be A and the source official or yardage_book, or the distance is omitted from every readout.",
     "color": "white", "metres": null, "yards": null,
     "source": "yardage_book", "confidence": "A"}
  ],

  "features": [
    {"_help": "Trace the actual green from the map/footage. At least 3 points. The Green Center is computed as this polygon's geometric centre - never as a guessed pin.",
     "id": "green", "type": "green", "source": "course_map", "confidence": "B",
     "closed": true, "points": [[-11,-13,0], [12,-11,0], [14,10,0], [-9,12,0]]},

    {"id": "tee_white", "type": "tee_box", "name": "white",
     "source": "course_map", "confidence": "B", "closed": true,
     "points": [[-4,-330,3], [4,-330,3], [4,-322,3], [-4,-322,3]]},

    {"_help": "type must be one of: tee_box, fairway, first_cut, rough, deep_rough, green, fringe, bunker, water, penalty_area_red, penalty_area_yellow, out_of_bounds, cart_path, tree, tree_line, building, terrain_ridge, landmark, landing_zone.",
     "id": "bunker_greenside_left", "type": "bunker",
     "source": "yardage_book", "confidence": "A", "closed": true,
     "points": [[-30,-12,-1], [-20,-14,-1], [-18,-4,-1], [-28,-2,-1]]},

    {"_help": "OB and penalty areas need confidence A from official data or the yardage book. Anything less is refused by final validation - never infer OB from a treeline or a road.",
     "id": "ob_right", "type": "out_of_bounds",
     "source": "official", "confidence": "A", "closed": false,
     "points": [[55,-320,0], [58,-180,0], [52,-40,0]]},

    {"_help": "Occluders need a height in metres so graphics can pass behind them.",
     "id": "treeline_left", "type": "tree_line",
     "source": "drone", "confidence": "B", "closed": false, "height": 14,
     "points": [[-52,-260,0], [-48,-150,0], [-44,-60,0]]},

    {"_help": "A landing zone may be a traced polygon, or a single point that becomes a terrain-conforming ellipse.",
     "id": "lz_primary", "type": "landing_zone",
     "source": "yardage_book", "confidence": "A", "closed": true,
     "points": [[6,-118,0]]}
  ],

  "strategy_route": [],
  "_help_strategy_route": "Optional waypoints TEE -> LANDING ZONE -> APPROACH -> GREEN CENTER. Fewer than 3 waypoints means no route is drawn - the system never auto-draws a straight line.",
  "route_source": "yardage_book",
  "route_confidence": "B",

  "facts": [
    {"_help": "Scalar course data with provenance. Slope percentages need confidence A or only the direction is shown.",
     "field": "green_slope_direction", "value": null, "kind": "direction",
     "source": "official", "confidence": "A",
     "note": "compass bearing the green falls toward, degrees"},
    {"field": "green_slope_percent", "value": null, "kind": "slope",
     "source": "official", "confidence": "A"}
  ],

  "footage_id": "",
  "notes": ""
}
"""
