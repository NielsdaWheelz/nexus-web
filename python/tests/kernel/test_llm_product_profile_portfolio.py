from nexus.services import llm_profiles


def test_product_profiles_have_the_fixed_nine_row_chat_portfolio() -> None:
    assert [
        (
            entry.id,
            entry.target.provider,
            entry.target.model,
            tuple(option.id for option in entry.reasoning_options),
            entry.default_reasoning_option_id,
        )
        for entry in llm_profiles.PROFILES
    ] == [
        (
            "fast",
            "openai",
            "gpt-5.6-luna",
            ("none", "low", "medium", "high", "xhigh", "max"),
            "low",
        ),
        (
            "balanced",
            "openai",
            "gpt-5.6-terra",
            ("none", "low", "medium", "high", "xhigh", "max"),
            "medium",
        ),
        (
            "deep",
            "openai",
            "gpt-5.6-sol",
            ("none", "low", "medium", "high", "xhigh", "max"),
            "high",
        ),
        (
            "claude",
            "anthropic",
            "claude-sonnet-5",
            ("low", "medium", "high", "xhigh", "max"),
            "medium",
        ),
        (
            "fable",
            "anthropic",
            "claude-fable-5",
            ("low", "medium", "high", "xhigh", "max"),
            "high",
        ),
        ("gemini", "gemini", "gemini-3.5-flash", ("minimal", "low", "medium", "high"), "medium"),
        ("kimi", "moonshot", "kimi-k3", ("low", "high", "max"), "high"),
        ("deepseek-flash", "deepseek", "deepseek-v4-flash", ("none", "high", "max"), "high"),
        ("deepseek-pro", "deepseek", "deepseek-v4-pro", ("none", "high", "max"), "high"),
    ], "DeepSeek Flash exposed a placebo reasoning alias"
    assert llm_profiles.profile("deepseek-flash").description == (
        "Fast, cost-efficient reasoning for everyday questions"
    )
    assert llm_profiles.profile("deepseek-pro").description == (
        "DeepSeek's strongest model for harder reasoning."
    )
    assert llm_profiles.profile("deepseek-flash").privacy.notice == (
        "Requests are sent directly to DeepSeek under the operator's API account and "
        "DeepSeek's current terms."
    )
    assert llm_profiles.OPERATION_PROFILES == {
        "oracle": "fast",
        "media_summary": "fast",
        "synapse": "fast",
        "dawn_write": "balanced",
        "dossier_media": "balanced",
        "dossier_conversation": "balanced",
        "dossier_library": "balanced",
        "dossier_podcast": "balanced",
        "dossier_contributor": "balanced",
        "dossier_page": "fast",
        "dossier_note": "fast",
        "dossier_idea": "balanced",
        "dossier_idea_resolve": "fast",
    }
