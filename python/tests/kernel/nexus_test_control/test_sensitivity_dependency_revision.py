from __future__ import annotations

from nexus_test_control.sensitivity import _base_overlays


def test_base_sensitivity_keeps_the_unfixed_dependency_revision_coherent() -> None:
    """Risk: candidate dependencies prevent BASE from reaching the proof assertion."""

    overlays = _base_overlays("python/tests/service/test_candidate_behavior.py")

    assert "python/pyproject.toml" not in overlays
    assert "python/uv.lock" not in overlays
    assert "python/nexus_test_control/provider_api_contract.py" in overlays
