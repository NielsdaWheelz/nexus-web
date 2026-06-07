from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from nexus.schemas.conversation import MessageRetrievalOut
from nexus.schemas.media import MediaEvidenceResponse
from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.schemas.search import SearchResultOut

pytestmark = pytest.mark.unit

SEARCH_RESULT_ADAPTER = TypeAdapter(SearchResultOut)


def test_media_evidence_response_accepts_current_resolver_payload():
    media_id = str(uuid4())
    evidence_span_id = str(uuid4())
    fragment_id = str(uuid4())

    response = MediaEvidenceResponse.model_validate(
        {
            "data": {
                "evidence_span_id": evidence_span_id,
                "media_id": media_id,
                "citation_label": "Source",
                "span_text": "Exact evidence",
                "resolver": {
                    "kind": "web",
                    "route": f"/media/{media_id}",
                    "params": {
                        "evidence": evidence_span_id,
                        "fragment": fragment_id,
                    },
                    "status": "resolved",
                    "selector": {
                        "kind": "fragment_offsets",
                        "fragment_id": fragment_id,
                        "start_offset": 0,
                        "end_offset": 14,
                        "text_quote": {
                            "exact": "Exact evidence",
                            "prefix": "",
                            "suffix": "",
                        },
                    },
                    "highlight": {
                        "kind": "web_text",
                        "evidence_span_id": evidence_span_id,
                        "fragment_id": fragment_id,
                        "start_offset": 0,
                        "end_offset": 14,
                        "text_quote": {
                            "exact": "Exact evidence",
                            "prefix": "",
                            "suffix": "",
                        },
                    },
                },
            }
        }
    )

    assert str(response.data.evidence_span_id) == evidence_span_id


def test_media_evidence_response_rejects_extra_response_keys():
    media_id = str(uuid4())
    evidence_span_id = str(uuid4())

    with pytest.raises(ValidationError):
        MediaEvidenceResponse.model_validate(
            {
                "data": {
                    "evidence_span_id": evidence_span_id,
                    "media_id": media_id,
                    "citation_label": "Source",
                    "span_text": "Exact evidence",
                    "source_version": "test-source:v1",
                    "unexpected_response_key": {},
                    "resolver": {
                        "kind": "web",
                        "route": f"/media/{media_id}",
                        "params": {"evidence": evidence_span_id},
                        "status": "unresolved",
                        "selector": {},
                        "highlight": None,
                    },
                }
            }
        )


def _web_offsets_locator(media_id: str | None = None) -> dict[str, object]:
    return {
        "type": "web_text_offsets",
        "media_id": media_id or str(uuid4()),
        "fragment_id": str(uuid4()),
        "start_offset": 1,
        "end_offset": 12,
    }


def _note_block_locator() -> dict[str, object]:
    return {
        "type": "note_block_offsets",
        "page_id": str(uuid4()),
        "block_id": str(uuid4()),
        "start_offset": 1,
        "end_offset": 12,
    }


def _message_locator() -> dict[str, object]:
    return {
        "type": "message_offsets",
        "conversation_id": str(uuid4()),
        "message_id": str(uuid4()),
        "start_offset": 1,
        "end_offset": 12,
    }


def _external_url_locator() -> dict[str, object]:
    return {
        "type": "external_url",
        "url": "https://example.test/source",
        "title": "External source",
    }


def _pdf_locator() -> dict[str, object]:
    return {
        "type": "pdf_page_geometry",
        "media_id": str(uuid4()),
        "page_number": 1,
        "quads": [
            {
                "x1": 1.0,
                "y1": 1.0,
                "x2": 2.0,
                "y2": 1.0,
                "x3": 2.0,
                "y3": 2.0,
                "x4": 1.0,
                "y4": 2.0,
            }
        ],
        "exact": "PDF quote",
    }


def _app_result_ref(
    result_type: str, locator: dict[str, object] | None = None
) -> dict[str, object]:
    result_id = str(uuid4())
    payload: dict[str, object] = {
        "type": result_type,
        "id": result_id,
        "result_type": result_type,
        "source_id": result_id,
        "title": "Strict result",
        "snippet": "Exact evidence",
        "deep_link": "/source",
        "context_ref": {"type": result_type, "id": result_id},
        "score": 0.8,
        "selected": True,
    }
    if result_type in {"episode", "video"}:
        payload["context_ref"] = {"type": "media", "id": result_id}
        payload["media_id"] = result_id
        payload["media_kind"] = "podcast_episode" if result_type == "episode" else "video"
    if result_type == "media":
        payload["media_id"] = result_id
        payload["media_kind"] = "web_article"
    if result_type == "content_chunk":
        payload.update(
            {
                "source_kind": "web_article",
                "citation_label": "p. 1",
                "locator": locator or _web_offsets_locator(),
            }
        )
    if result_type == "fragment":
        payload.update(
            {
                "locator": locator or _web_offsets_locator(),
            }
        )
    if result_type == "contributor":
        payload["contributor_handle"] = "ada-lovelace"
    if result_type == "note_block":
        payload.update(
            {
                "page_id": str(uuid4()),
                "page_title": "Page",
                "body_text": "Note body",
                "locator": locator or _note_block_locator(),
            }
        )
    if result_type == "highlight":
        payload.update(
            {
                "color": "yellow",
                "exact": "Exact highlighted quote",
                "locator": locator or _web_offsets_locator(),
            }
        )
    if result_type == "message":
        payload.update(
            {
                "conversation_id": str(uuid4()),
                "seq": 1,
                "locator": locator or _message_locator(),
            }
        )
    return payload


def test_retrieval_locator_json_accepts_documented_variants_and_rejects_unknown():
    assert (
        retrieval_locator_json(
            {
                "type": "external_url",
                "url": "https://example.test/source",
                "title": "External source",
            }
        )["type"]
        == "external_url"
    )
    assert (
        retrieval_locator_json(
            {
                "type": "web_text_offsets",
                "media_id": str(uuid4()),
                "fragment_id": str(uuid4()),
                "start_offset": 4,
                "end_offset": 12,
            }
        )["type"]
        == "web_text_offsets"
    )
    assert (
        retrieval_locator_json(
            {
                "type": "note_block_offsets",
                "page_id": str(uuid4()),
                "block_id": str(uuid4()),
                "start_offset": 0,
                "end_offset": 5,
            }
        )["type"]
        == "note_block_offsets"
    )
    assert (
        retrieval_locator_json(
            {
                "type": "message_offsets",
                "conversation_id": str(uuid4()),
                "message_id": str(uuid4()),
                "start_offset": 1,
                "end_offset": 9,
            }
        )["type"]
        == "message_offsets"
    )
    assert (
        retrieval_locator_json(
            {
                "type": "audio_time_range",
                "media_id": str(uuid4()),
                "t_start_ms": 100,
                "t_end_ms": 200,
            }
        )["type"]
        == "audio_time_range"
    )
    assert (
        retrieval_locator_json(
            {
                "type": "video_time_range",
                "media_id": str(uuid4()),
                "t_start_ms": 100,
                "t_end_ms": 200,
            }
        )["type"]
        == "video_time_range"
    )
    assert (
        retrieval_locator_json(
            {
                "type": "transcript_time_range",
                "media_id": str(uuid4()),
                "t_start_ms": 100,
                "t_end_ms": 200,
            }
        )["type"]
        == "transcript_time_range"
    )
    assert retrieval_locator_json(_pdf_locator())["type"] == "pdf_page_geometry"
    with pytest.raises(ValidationError):
        retrieval_locator_json({"type": "totally_unknown", "id": "x"})
    with pytest.raises(ValidationError):
        retrieval_locator_json({"type": "web_fragment", "fragment_id": "fragment-1"})
    with pytest.raises(ValidationError):
        retrieval_locator_json({"type": "web_url", "url": "https://example.test"})
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "kind": "web",
                "route": "/media/example",
                "params": {},
                "status": "resolved",
                "selector": {},
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "type": "external_url",
                "url": "https://example.test",
                "fragment_id": "not-part-of-external-url",
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "type": "audio_time_range",
                "media_id": str(uuid4()),
                "t_start_ms": 100,
                "t_end_ms": 200,
                "text_quote_selector": {"exact": "not part of audio locators"},
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "type": "transcript_time_range",
                "media_id": str(uuid4()),
                "transcript_version_id": str(uuid4()),
                "t_start_ms": 100,
                "t_end_ms": 200,
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "type": "audio_time_range",
                "media_id": str(uuid4()),
                "transcript_version_id": str(uuid4()),
                "t_start_ms": 100,
                "t_end_ms": 200,
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "type": "video_time_range",
                "media_id": str(uuid4()),
                "transcript_version_id": str(uuid4()),
                "t_start_ms": 100,
                "t_end_ms": 200,
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "type": "transcript_time_range",
                "media_id": str(uuid4()),
                "t_start_ms": 200,
                "t_end_ms": 100,
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json(
            {
                "type": "web_text_offsets",
                "media_id": str(uuid4()),
                "fragment_id": str(uuid4()),
                "start_offset": 12,
                "end_offset": 4,
            }
        )
    with pytest.raises(ValidationError):
        retrieval_locator_json({**_pdf_locator(), "quads": []})
    with pytest.raises(ValidationError):
        retrieval_locator_json({**_pdf_locator(), "quads": [{"x1": 1.0}]})


def test_retrieval_ref_json_rejects_unknown_variant():
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({"type": "totally_unknown", "id": "x"})


@pytest.mark.parametrize(
    ("result_type", "locator"),
    [
        ("content_chunk", _web_offsets_locator()),
        ("fragment", _web_offsets_locator()),
        ("highlight", _web_offsets_locator()),
        ("note_block", _note_block_locator()),
        ("message", _message_locator()),
    ],
)
def test_retrieval_ref_json_requires_locatable_app_refs_to_carry_locator(
    result_type: str,
    locator: dict[str, object],
):
    valid_ref = _app_result_ref(result_type, locator)

    assert "source_version" not in retrieval_result_ref_json(valid_ref)
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({**valid_ref, "source_version": "legacy:v1"})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {key: value for key, value in valid_ref.items() if key != "locator"}
        )


@pytest.mark.parametrize(
    ("result_type", "valid_locator", "invalid_locator"),
    [
        ("content_chunk", _web_offsets_locator(), _note_block_locator()),
        ("fragment", _web_offsets_locator(), _note_block_locator()),
        ("highlight", _web_offsets_locator(), _message_locator()),
        ("note_block", _note_block_locator(), _web_offsets_locator()),
        ("message", _message_locator(), _web_offsets_locator()),
    ],
)
def test_retrieval_ref_json_rejects_locator_type_drift(
    result_type: str,
    valid_locator: dict[str, object],
    invalid_locator: dict[str, object],
):
    valid_ref = _app_result_ref(result_type, valid_locator)

    assert retrieval_result_ref_json(valid_ref)["locator"]["type"] == valid_locator["type"]
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({**valid_ref, "locator": invalid_locator})


def test_retrieval_ref_json_rejects_cross_variant_app_fields():
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({**_app_result_ref("media"), "page_id": str(uuid4())})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {**_app_result_ref("contributor"), "locator": _web_offsets_locator()}
        )
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({**_app_result_ref("note_block"), "media_id": str(uuid4())})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {key: value for key, value in _app_result_ref("message").items() if key != "locator"}
        )
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {key: value for key, value in _app_result_ref("page").items() if key != "result_type"}
        )


def test_retrieval_ref_json_rejects_page_source_version():
    page_id = str(uuid4())
    valid_ref = {
        "type": "page",
        "id": page_id,
        "result_type": "page",
        "source_id": page_id,
        "title": "Page",
        "snippet": "Page body",
        "deep_link": f"/notes/pages/{page_id}",
        "context_ref": {"type": "page", "id": page_id},
    }

    assert "source_version" not in retrieval_result_ref_json(valid_ref)
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({**valid_ref, "source_version": "page:v1"})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({**valid_ref, "locator": _web_offsets_locator()})


def test_retrieval_ref_json_rejects_web_result_source_version():
    result_id = "web:example"
    valid_ref = {
        "type": "web_result",
        "id": result_id,
        "result_type": "web_result",
        "source_id": result_id,
        "result_ref": result_id,
        "title": "External source",
        "url": "https://example.test/source",
        "snippet": "External source snippet",
        "deep_link": "https://example.test/source",
        "context_ref": {"type": "web_result", "id": result_id},
        "locator": _external_url_locator(),
        "score": 0.8,
        "selected": True,
    }

    serialized = retrieval_result_ref_json(valid_ref)

    assert serialized["type"] == "web_result"
    assert "source_version" not in serialized
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({**valid_ref, "source_version": "web:v1"})


def test_retrieval_ref_json_requires_media_context_for_episode_and_video_results():
    media_id = str(uuid4())
    episode_ref = retrieval_result_ref_json(
        {
            "type": "episode",
            "id": media_id,
            "result_type": "episode",
            "source_id": media_id,
            "title": "Episode",
            "snippet": "Transcript match",
            "deep_link": f"/media/{media_id}",
            "context_ref": {"type": "media", "id": media_id},
        }
    )

    assert episode_ref["context_ref"] == {"type": "media", "id": media_id}
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {
                **episode_ref,
                "context_ref": {"type": "episode", "id": media_id},
            }
        )


def test_retrieval_ref_json_rejects_resolver_payload_field():
    media_id = str(uuid4())
    chunk_id = str(uuid4())

    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {
                "type": "content_chunk",
                "id": chunk_id,
                "result_type": "content_chunk",
                "source_id": chunk_id,
                "title": "Chunk",
                "snippet": "Exact evidence",
                "deep_link": f"/media/{media_id}",
                "context_ref": {"type": "content_chunk", "id": chunk_id},
                "source_version": "test-source:v1",
                "media_id": media_id,
                "resolver": {
                    "kind": "web",
                    "route": f"/media/{media_id}",
                    "params": {},
                    "status": "resolved",
                    "selector": {},
                },
            }
        )


def test_retrieval_ref_json_rejects_status_variant():
    with pytest.raises(ValidationError):
        retrieval_context_ref_json({"type": "status", "id": "no_results"})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {
                "type": "status",
                "id": "no_results",
                "status": "no_results",
                "source_version": "app_search_status:v1",
            }
        )


def test_message_retrieval_out_rejects_extra_keys_and_ref_drift():
    result_ref = _app_result_ref("message")
    payload = {
        "id": str(uuid4()),
        "tool_call_id": str(uuid4()),
        "ordinal": 0,
        "result_type": "message",
        "source_id": result_ref["source_id"],
        "scope": "all",
        "context_ref": result_ref["context_ref"],
        "result_ref": result_ref,
        "deep_link": result_ref["deep_link"],
        "score": 0.8,
        "selected": True,
        "locator": result_ref["locator"],
        "created_at": "2026-01-01T00:00:00Z",
    }

    assert not hasattr(MessageRetrievalOut.model_validate(payload), "source_version")
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate({**payload, "unexpected_field": {}})
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate({**payload, "source_version": "message:v1"})
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate({**payload, "locator": None})
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate(
            {
                **payload,
                "result_type": "media",
                "context_ref": {"type": "media", "id": str(uuid4())},
            }
        )


def test_search_result_out_rejects_unknown_variant():
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python({"type": "totally_unknown", "id": "x"})


def _search_base(result_type: str) -> dict[str, object]:
    result_id = str(uuid4())
    return {
        "type": result_type,
        "id": result_id,
        "score": 0.8,
        "snippet": "Exact match",
        "title": "Result",
        "deep_link": "/source",
        "context_ref": {"type": result_type, "id": result_id},
    }


def _search_source(media_id: str | None = None) -> dict[str, object]:
    return {
        "media_id": media_id or str(uuid4()),
        "media_kind": "web_article",
        "title": "Source",
        "contributors": [],
    }


@pytest.mark.parametrize(
    "payload",
    [
        {
            **_search_base("content_chunk"),
            "source_kind": "web_article",
            "evidence_span_ids": [str(uuid4())],
            "source": _search_source(),
            "citation_label": "p. 1",
            "locator": _web_offsets_locator(),
        },
        {
            **_search_base("fragment"),
            "source": _search_source(),
            "locator": _web_offsets_locator(),
        },
        {
            **_search_base("highlight"),
            "color": "yellow",
            "exact": "Exact highlighted quote",
            "source": _search_source(),
            "locator": _web_offsets_locator(),
        },
        {
            **_search_base("note_block"),
            "page_id": str(uuid4()),
            "page_title": "Page",
            "body_text": "Note body",
            "locator": _note_block_locator(),
        },
        {
            **_search_base("message"),
            "conversation_id": str(uuid4()),
            "seq": 1,
            "locator": _message_locator(),
        },
    ],
)
def test_search_result_out_requires_locator_for_locatable_rows(
    payload: dict[str, object],
):
    result = SEARCH_RESULT_ADAPTER.validate_python(payload)
    assert result.type == payload["type"]
    assert "source_version" not in result.model_dump(mode="json")
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python({**payload, "source_version": "legacy:v1"})
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python(
            {key: value for key, value in payload.items() if key != "locator"}
        )


@pytest.mark.parametrize(
    ("payload", "invalid_locator"),
    [
        (
            {
                **_search_base("content_chunk"),
                "source_kind": "web_article",
                "source": _search_source(),
                "citation_label": "p. 1",
                "locator": _web_offsets_locator(),
            },
            _note_block_locator(),
        ),
        (
            {
                **_search_base("note_block"),
                "page_id": str(uuid4()),
                "page_title": "Page",
                "body_text": "Note body",
                "locator": _note_block_locator(),
            },
            _web_offsets_locator(),
        ),
        (
            {
                **_search_base("message"),
                "conversation_id": str(uuid4()),
                "seq": 1,
                "locator": _message_locator(),
            },
            _web_offsets_locator(),
        ),
    ],
)
def test_search_result_out_rejects_locator_type_drift(
    payload: dict[str, object],
    invalid_locator: dict[str, object],
):
    assert SEARCH_RESULT_ADAPTER.validate_python(payload).type == payload["type"]
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python({**payload, "locator": invalid_locator})


def test_search_result_out_rejects_page_source_version():
    payload = {
        **_search_base("page"),
        "description": "Page description",
    }

    result = SEARCH_RESULT_ADAPTER.validate_python(payload)
    assert result.type == "page"
    assert "source_version" not in result.model_dump(mode="json")
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python({**payload, "source_version": "page:v1"})


def test_search_result_out_requires_web_result_context_and_external_url_locator():
    payload = {
        **_search_base("web_result"),
        "id": str(uuid4()),
        "result_type": "web_result",
        "source_id": "web:example",
        "result_ref": "web:example",
        "title": "External source",
        "url": "https://example.test/source",
        "locator": {
            "type": "external_url",
            "url": "https://example.test/source",
            "title": "External source",
        },
        "media_id": None,
        "media_kind": None,
        "selected": True,
        "deep_link": "https://example.test/source",
        "context_ref": {"type": "web_result", "id": "web:example"},
    }

    result = SEARCH_RESULT_ADAPTER.validate_python(payload)
    assert result.type == "web_result"
    assert "source_version" not in result.model_dump(mode="json")
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python(
            {**payload, "context_ref": {"type": "message", "id": "message-1"}}
        )
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python({**payload, "locator": _web_offsets_locator()})
    with pytest.raises(ValidationError):
        SEARCH_RESULT_ADAPTER.validate_python({**payload, "source_version": "web:v1"})
