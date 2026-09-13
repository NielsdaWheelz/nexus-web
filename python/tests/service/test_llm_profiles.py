"""HTTP contract for the fixed product LLM portfolio."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_llm_profiles_returns_the_exact_ordered_nine_row_contract(
    authenticated_client: TestClient,
) -> None:
    response = authenticated_client.get("/llm-profiles")

    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert payload["default_profile_id"] == "balanced"
    assert [
        (
            row["id"],
            tuple(option["id"] for option in row["reasoning_options"]),
            row["default_reasoning_option_id"],
        )
        for row in payload["profiles"]
    ] == [
        ("fast", ("none", "low", "medium", "high", "xhigh", "max"), "low"),
        ("balanced", ("none", "low", "medium", "high", "xhigh", "max"), "medium"),
        ("deep", ("none", "low", "medium", "high", "xhigh", "max"), "high"),
        ("claude", ("low", "medium", "high", "xhigh", "max"), "medium"),
        ("fable", ("low", "medium", "high", "xhigh", "max"), "high"),
        ("gemini", ("minimal", "low", "medium", "high"), "medium"),
        ("kimi", ("low", "high", "max"), "high"),
        ("deepseek-flash", ("none", "high", "max"), "high"),
        ("deepseek-pro", ("none", "high", "max"), "high"),
    ]

    flash, pro = payload["profiles"][-2:]
    assert (flash["label"], flash["description"]) == (
        "DeepSeek · V4 Flash",
        "Fast, cost-efficient reasoning for everyday questions",
    )
    assert (pro["label"], pro["description"]) == (
        "DeepSeek · V4 Pro",
        "DeepSeek's strongest model for harder reasoning.",
    )
    expected_privacy = {
        "kind": "Standard",
        "notice": (
            "Requests are sent directly to DeepSeek under the operator's API account and "
            "DeepSeek's current terms."
        ),
    }
    assert flash["privacy"] == expected_privacy
    assert pro["privacy"] == expected_privacy
