"""Overlay construction and the six-phase reveal (sections 13-16, 23, 25, 28)."""

import pytest

from matchmove.camera import CameraPose, CameraTrack, Intrinsics, Keyframe
from matchmove.confidence import Confidence, Fact, FactKind, FactSet, Source
from matchmove.geo import Vec3
from matchmove.overlay import ElementKind, build_overlays, render_frame
from matchmove.sequence import PHASE_ORDER, build_sequence, render_sequence
from matchmove.spec import Feature, FeatureType, HoleSpec, TeeColor, TeeDistance
from matchmove.terrain import FlatTerrain, SampledTerrain

INTR = Intrinsics.from_fov(1920, 1080, 78.0)


def make_spec(**kw):
    green = Feature("green", FeatureType.GREEN,
                    [Vec3(-12, -12), Vec3(12, -12), Vec3(12, 12), Vec3(-12, 12)],
                    Source.COURSE_MAP, Confidence.VISUALLY_MATCHED,
                    corroborated_by=(Source.DRONE,))
    tee = Feature("tee_white", FeatureType.TEE_BOX,
                  [Vec3(-4, -304), Vec3(4, -304), Vec3(4, -296), Vec3(-4, -296)],
                  Source.COURSE_MAP, Confidence.VISUALLY_MATCHED, name="white")
    spec = HoleSpec("Test CC", 7, 4, features=[green, tee],
                    tees=[TeeDistance(TeeColor.WHITE, 300.0, source=Source.YARDAGE_BOOK,
                                      confidence=Confidence.CONFIRMED)],
                    primary_tee=TeeColor.WHITE)
    for k, v in kw.items():
        setattr(spec, k, v)
    return spec


def make_track(fps=30.0, frames=300):
    t = CameraTrack(INTR, fps, locked=False)
    keys = []
    for i in range(11):
        u = i / 10
        keys.append(Keyframe(int(frames * u), CameraPose(
            Vec3(0, -360 + 340 * u, 120 - 70 * u), 0.0, -22 - 12 * u, 0.0)))
    t.set_keyframes(keys)
    t.locked = True
    return t


def test_target_marker_is_built_at_the_green_center_and_named_correctly():
    els, _ = build_overlays(make_spec(), FlatTerrain())
    targets = [e for e in els if e.kind is ElementKind.TARGET]
    assert len(targets) == 1
    assert targets[0].label == "GREEN CENTER"
    assert targets[0].anchor.x == pytest.approx(0.0)
    assert targets[0].anchor.y == pytest.approx(0.0)


def test_title_card_omits_distance_when_it_is_not_confirmed():
    spec = make_spec()
    spec.tees[0].source = Source.DRONE      # downgraded, so no number may print
    els, _ = build_overlays(spec, FlatTerrain())
    hud = [e for e in els if e.kind is ElementKind.HUD][0]
    assert "PAR 4" in hud.sublabel
    assert "m /" not in hud.sublabel
    assert not [e for e in els if e.id == "distance_to_center"]


def test_title_card_prints_confirmed_distance_in_both_units():
    els, _ = build_overlays(make_spec(), FlatTerrain())
    hud = [e for e in els if e.kind is ElementKind.HUD][0]
    assert "HOLE 07" == hud.label
    assert "300m / 328yd" in hud.sublabel


def test_no_route_is_drawn_without_enough_waypoints():
    """Section 15: never auto-draw a straight tee-to-green line."""
    els, _ = build_overlays(make_spec(), FlatTerrain())
    assert not [e for e in els if e.kind is ElementKind.ROUTE]


def test_route_follows_the_supplied_waypoints():
    spec = make_spec(strategy_route=[Vec3(0, -300, 0), Vec3(14, -150, 0),
                                     Vec3(8, -70, 0), Vec3(0, 0, 0)],
                     route_source=Source.YARDAGE_BOOK,
                     route_confidence=Confidence.VISUALLY_MATCHED)
    els, _ = build_overlays(spec, FlatTerrain())
    route = [e for e in els if e.kind is ElementKind.ROUTE][0]
    assert len(route.points) > 20                       # densified for conforming
    assert max(p.x for p in route.points) > 5           # bends right, not a straight line


def test_water_is_labelled_water_not_penalty_area():
    """Section 18: appearance alone never makes something a penalty area."""
    spec = make_spec()
    spec.features.append(Feature(
        "pond", FeatureType.WATER,
        [Vec3(-60, -120), Vec3(-40, -120), Vec3(-40, -90), Vec3(-60, -90)],
        Source.DRONE, Confidence.VISUALLY_MATCHED, corroborated_by=(Source.COURSE_MAP,)))
    els, _ = build_overlays(spec, FlatTerrain())
    labels = {e.label for e in els}
    assert "WATER" in labels
    assert not any("PENALTY" in l for l in labels)


def test_unconfirmed_ob_is_omitted_with_a_reason():
    spec = make_spec()
    spec.features.append(Feature(
        "ob_right", FeatureType.OUT_OF_BOUNDS,
        [Vec3(50, -300), Vec3(52, -150), Vec3(48, -20)],
        Source.DRONE, Confidence.VISUALLY_MATCHED, closed=False))
    els, omissions = build_overlays(spec, FlatTerrain())
    assert not [e for e in els if e.id == "ob_right"]
    assert any("ob_right" in o.field for o in omissions)


def test_confirmed_ob_is_drawn():
    spec = make_spec()
    spec.features.append(Feature(
        "ob_right", FeatureType.OUT_OF_BOUNDS,
        [Vec3(50, -300), Vec3(52, -150), Vec3(48, -20)],
        Source.OFFICIAL, Confidence.CONFIRMED, closed=False))
    els, _ = build_overlays(spec, FlatTerrain())
    ob = [e for e in els if e.id == "ob_right"]
    assert ob and ob[0].label == "OB"


def test_bunkers_are_classified_by_distance_to_the_green_center():
    spec = make_spec()
    spec.features.append(Feature("b_green", FeatureType.BUNKER,
                                 [Vec3(-26, -8), Vec3(-18, -10), Vec3(-16, 0), Vec3(-24, 2)],
                                 Source.YARDAGE_BOOK, Confidence.CONFIRMED))
    spec.features.append(Feature("b_fair", FeatureType.BUNKER,
                                 [Vec3(20, -150), Vec3(30, -152), Vec3(31, -138), Vec3(21, -136)],
                                 Source.YARDAGE_BOOK, Confidence.CONFIRMED))
    els, _ = build_overlays(spec, FlatTerrain())
    by_id = {e.id: e.label for e in els}
    assert by_id["b_green"] == "GREENSIDE BUNKER"
    assert by_id["b_fair"] == "FAIRWAY BUNKER"


def test_slope_direction_shows_without_a_fabricated_percentage():
    spec = make_spec()
    spec.facts = FactSet([
        Fact("green_slope_direction", 210.0, FactKind.DIRECTION, Source.OFFICIAL,
             Confidence.CONFIRMED),
        Fact("green_slope_percent", 2.4, FactKind.SLOPE, Source.ESTIMATE,
             Confidence.ESTIMATED),
    ])
    els, _ = build_overlays(spec, FlatTerrain())
    slope = [e for e in els if e.kind is ElementKind.SLOPE_ARROW][0]
    assert slope.label == "SLOPE DIRECTION"
    assert "%" not in slope.label


def test_confirmed_slope_percentage_is_printed():
    spec = make_spec()
    spec.facts = FactSet([
        Fact("green_slope_direction", 210.0, FactKind.DIRECTION, Source.OFFICIAL,
             Confidence.CONFIRMED),
        Fact("green_slope_percent", 2.3, FactKind.SLOPE, Source.OFFICIAL,
             Confidence.CONFIRMED),
    ])
    els, _ = build_overlays(spec, FlatTerrain())
    slope = [e for e in els if e.kind is ElementKind.SLOPE_ARROW][0]
    assert slope.label == "GREEN SLOPE 2.3%"


def test_ground_elements_are_conformed_to_the_terrain():
    terrain = SampledTerrain([Vec3(-40, -40, 0), Vec3(40, -40, 2),
                              Vec3(0, 40, 6), Vec3(0, 0, 4)])
    els, _ = build_overlays(make_spec(), terrain)
    target = [e for e in els if e.kind is ElementKind.TARGET][0]
    assert target.anchor.z == pytest.approx(terrain.height(target.anchor.x, target.anchor.y))
    assert target.anchor.z > 1.0


# ------------------------------------------------------------------ sequence
def test_sequence_has_all_six_phases_in_order_and_covers_the_shot():
    spec, track = make_spec(), make_track()
    seq = build_sequence(track, spec)
    assert [p.name for p in seq.phases] == list(PHASE_ORDER)
    assert seq.phases[0].start_frame == track.frame_range[0]
    assert seq.phases[-1].end_frame == track.frame_range[1]
    for a, b in zip(seq.phases, seq.phases[1:]):
        assert a.end_frame == b.start_frame


def test_every_phase_is_long_enough_to_read():
    seq = build_sequence(make_track(), make_spec())
    for p in seq.phases:
        assert p.length >= 30, f"{p.name} is only {p.length} frames"


def test_phase_timing_follows_the_camera_not_the_clock():
    seq = build_sequence(make_track(), make_spec())
    assert seq.derived_from_camera


def test_phase_timing_falls_back_and_says_so_without_tee_geometry():
    spec = make_spec()
    spec.features = [f for f in spec.features if f.type is not FeatureType.TEE_BOX]
    seq = build_sequence(make_track(), spec)
    assert not seq.derived_from_camera
    assert "evenly divided" in seq.note


def test_information_is_retired_as_the_drone_advances():
    """Section 25: the tee readout must be gone by the green."""
    spec = make_spec(strategy_route=[Vec3(0, -300, 0), Vec3(6, -140, 0), Vec3(0, 0, 0)])
    track = make_track()
    els, _ = build_overlays(spec, FlatTerrain())
    seq = build_sequence(track, spec)
    tee_shot_mid = (seq.phase("tee_shot").start_frame + seq.phase("tee_shot").end_frame) // 2
    green_mid = (seq.phase("green").start_frame + seq.phase("green").end_frame) // 2
    dist = [e for e in els if e.id == "distance_to_center"][0]
    assert seq.opacity_for(dist, tee_shot_mid) > 0.9
    assert seq.opacity_for(dist, green_mid) == 0.0


def test_the_target_marker_is_present_in_every_phase():
    spec, track = make_spec(), make_track()
    els, _ = build_overlays(spec, FlatTerrain())
    seq = build_sequence(track, spec)
    target = [e for e in els if e.kind is ElementKind.TARGET][0]
    for p in seq.phases:
        mid = (p.start_frame + p.end_frame) // 2
        assert seq.opacity_for(target, mid) > 0.5, f"target faded during {p.name}"


def test_elements_fade_rather_than_pop():
    spec, track = make_spec(), make_track()
    els, _ = build_overlays(spec, FlatTerrain())
    seq = build_sequence(track, spec)
    hud = [e for e in els if e.kind is ElementKind.HUD][0]
    end = seq.phase("establishing").end_frame
    assert 0.0 < seq.opacity_for(hud, end + 6) < 1.0


def test_rendered_frames_carry_phase_and_screen_geometry():
    spec, track = make_spec(), make_track()
    els, _ = build_overlays(spec, FlatTerrain())
    seq = build_sequence(track, spec)
    frames = render_sequence(els, track, seq, None, step=10)
    assert frames and all(f.phase in PHASE_ORDER for f in frames)
    drawn = [e for f in frames for e in f.elements]
    assert any(e.kind is ElementKind.TARGET for e in drawn)
    assert any(e.kind is ElementKind.HUD for e in drawn)
    for e in drawn:
        if e.anchor_px:
            assert -400 <= e.anchor_px[0] <= INTR.width + 400
