"""The persisted research purpose reaches Web Article materialization."""

from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID

import pytest

from nexus.db.models import MediaSourceAttempt
from nexus.services import media_source_ingest

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("source_payload", "expected_extract_embeds"),
    [
        ({"ingest_purpose": "artifact_research"}, False),
        ({}, True),
    ],
)
def test_generic_web_article_derives_embed_policy_from_persisted_purpose(
    monkeypatch,
    source_payload: dict[str, object],
    expected_extract_embeds: bool,
) -> None:
    observed: dict[str, object] = {}

    monkeypatch.setattr(
        media_source_ingest,
        "run_source_publication_phase",
        lambda **_kwargs: None,
    )

    def materialize(*_args: object, **kwargs: object) -> dict[str, object]:
        observed.update(kwargs)
        return {"status": "success"}

    monkeypatch.setattr(
        media_source_ingest,
        "materialize_web_article_source",
        materialize,
    )
    attempt = cast(
        "MediaSourceAttempt",
        cast(
            "Any",
            SimpleNamespace(
                id=UUID("11111111-1111-4111-8111-111111111111"),
                source_payload=source_payload,
            ),
        ),
    )

    result = media_source_ingest._run_generic_web_article(
        cast("Any", object()),
        UUID("22222222-2222-4222-8222-222222222222"),
        attempt,
        UUID("33333333-3333-4333-8333-333333333333"),
        "request",
        cast("Any", object()),
    )

    assert result == {"status": "success"}
    assert observed["extract_embeds"] is expected_extract_embeds
