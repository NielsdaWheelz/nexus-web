from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest

from nexus.services.resonance._ranking import (
    SLATE_SEMANTIC_CALIBRATION,
    slate_semantic_qualifies,
)

pytestmark = pytest.mark.artifact

_SEMANTIC_CALIBRATION_FIXTURE = (
    Path(__file__).parent / "fixtures" / "resonance_semantic_calibration.json"
)


def _load_semantic_calibration_fixture() -> dict[str, Any]:
    payload = json.loads(_SEMANTIC_CALIBRATION_FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return cast(dict[str, Any], payload)


def test_semantic_slate_calibration_matches_the_approved_production_fixture() -> None:
    fixture = _load_semantic_calibration_fixture()
    calibration = fixture["calibration"]
    assert calibration == {
        "provider": "openai",
        "model": "openai_text_embedding_3_small_256_v1",
        "dimensions": 256,
        "min_similarity": 0.8,
    }
    assert fixture["provenance"]["reviewed_by"] == "repository_owner"
    assert fixture["provenance"]["review_outcome"] == "approved"
    assert (
        SLATE_SEMANTIC_CALIBRATION.provider,
        SLATE_SEMANTIC_CALIBRATION.model,
        SLATE_SEMANTIC_CALIBRATION.dimensions,
        SLATE_SEMANTIC_CALIBRATION.min_similarity,
    ) == (
        calibration["provider"],
        calibration["model"],
        calibration["dimensions"],
        calibration["min_similarity"],
    )

    positive_pairs = fixture["positive_pairs"]
    hard_negative_pairs = fixture["hard_negative_pairs"]
    assert len(positive_pairs) == 12
    assert len(hard_negative_pairs) == 12
    assert all(pair["nearest_media_rank"] == 1 for pair in hard_negative_pairs)
    assert all(pair["nearest_chunk_rank"] == 1 for pair in hard_negative_pairs)

    exact_tuple = {
        "provider": calibration["provider"],
        "model": calibration["model"],
        "dimensions": calibration["dimensions"],
    }
    assert all(
        slate_semantic_qualifies(
            **exact_tuple,
            similarity=pair["similarity"],
        )
        for pair in positive_pairs
    )
    assert all(
        not slate_semantic_qualifies(
            **exact_tuple,
            similarity=pair["similarity"],
        )
        for pair in hard_negative_pairs
    )
