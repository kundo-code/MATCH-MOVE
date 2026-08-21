"""The anti-hallucination gate (sections 02, 03, 32)."""

import pytest

from matchmove.confidence import (
    Confidence,
    Fact,
    FactKind,
    FactSet,
    OmissionReason,
    Source,
    resolve_conflict,
)


def test_yardage_book_distance_is_displayable():
    f = Fact("tee", 352.0, FactKind.DISTANCE, Source.YARDAGE_BOOK, Confidence.CONFIRMED)
    assert f.displayable
    assert f.omission() is None


def test_a_source_cannot_certify_itself_above_its_ceiling():
    """Claiming CONFIRMED for something only seen in the footage is downgraded."""
    f = Fact("tee", 352.0, FactKind.DISTANCE, Source.DRONE, Confidence.CONFIRMED)
    assert f.confidence is Confidence.VISUALLY_MATCHED
    assert not f.displayable
    assert f.omission().reason is OmissionReason.BELOW_FLOOR


def test_estimated_distance_is_never_displayed():
    f = Fact("carry", 210.0, FactKind.DISTANCE, Source.ESTIMATE, Confidence.ESTIMATED)
    assert not f.displayable


def test_visible_geometry_may_show_at_grade_b():
    f = Fact("feature:green", "green", FactKind.GEOMETRY, Source.COURSE_MAP,
             Confidence.VISUALLY_MATCHED)
    assert f.displayable


def test_hazard_classification_requires_confirmation():
    """Section 19/20: OB and penalty areas are rules calls, not observations."""
    f = Fact("feature:ob", "ob", FactKind.HAZARD_CLASS, Source.DRONE,
             Confidence.VISUALLY_MATCHED)
    assert not f.displayable


def test_slope_percentage_requires_confirmation():
    f = Fact("green_slope_percent", 2.4, FactKind.SLOPE, Source.ESTIMATE,
             Confidence.ESTIMATED)
    assert not f.displayable


def test_missing_value_is_omitted_not_defaulted():
    f = Fact("tee", None, FactKind.DISTANCE, Source.OFFICIAL, Confidence.CONFIRMED)
    assert not f.displayable
    assert f.omission().reason is OmissionReason.MISSING


def test_official_data_beats_the_yardage_book():
    official = Fact("tee", 350.0, FactKind.DISTANCE, Source.OFFICIAL, Confidence.CONFIRMED)
    book = Fact("tee", 352.0, FactKind.DISTANCE, Source.YARDAGE_BOOK, Confidence.CONFIRMED)
    assert resolve_conflict([book, official]).value == 350.0


def test_visual_guesswork_never_replaces_supplied_data():
    book = Fact("tee", 352.0, FactKind.DISTANCE, Source.YARDAGE_BOOK, Confidence.CONFIRMED)
    guess = Fact("tee", 361.0, FactKind.DISTANCE, Source.ESTIMATE, Confidence.ESTIMATED)
    assert resolve_conflict([guess, book]).value == 352.0


def test_factset_value_returns_default_for_unverified_data():
    fs = FactSet([
        Fact("green_slope_percent", 2.4, FactKind.SLOPE, Source.ESTIMATE,
             Confidence.ESTIMATED),
    ])
    assert fs.value("green_slope_percent") is None
    assert len(fs.omissions()) == 1


def test_factset_round_trips_through_json_shape():
    fs = FactSet([
        Fact("par", 4, FactKind.IDENTITY, Source.OFFICIAL, Confidence.CONFIRMED),
    ])
    again = FactSet.from_list(fs.to_list())
    assert again.value("par") == 4
