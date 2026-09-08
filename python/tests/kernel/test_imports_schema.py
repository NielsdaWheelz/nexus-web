"""Strict wire contract for the Imports workspace ingress and identity types.

Three risks live here and nowhere else: an import ref that round-trips to a
different row, a filter combination a view cannot correlate silently widening
the query, and one replay key whose two spellings become two memo rows.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.imports import (
    Capabilities,
    ImportItem,
    ImportListQuery,
    ImportPage,
    ImportStageGroup,
    ImportStateActive,
    InvalidImportRef,
    MediaImportRef,
    RepairSearchOffer,
    UploadImportRef,
    format_import_ref,
    parse_import_ref,
)
from nexus.schemas.media import SourceCountedProgress, SourceRepairRequest
from nexus.schemas.presence import absent, present

SESSION_HANDLE = "nup1.ERERERERQRGBEREREREREQ.AAECAwQFBgcICQoLDA0ODw"
MEDIA_ID = UUID("2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a")
JOB_ID = UUID("4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d")
CLIENT_MUTATION_ID = "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c"
OBSERVED_AT = datetime(2026, 9, 8, 10, 30, tzinfo=UTC)


def _repair_body(client_mutation_id: str) -> dict[str, object]:
    return {
        "kind": "Source",
        "client_mutation_id": client_mutation_id,
        "expected_attempt_id": str(MEDIA_ID),
        "expected_job_id": str(JOB_ID),
    }


def test_import_ref_round_trips_upload_and_media_identity() -> None:
    upload = UploadImportRef(session_handle=SESSION_HANDLE)
    media = MediaImportRef(media_id=MEDIA_ID)

    assert format_import_ref(upload) == f"upload:{SESSION_HANDLE}"
    assert format_import_ref(media) == f"media:{MEDIA_ID}"
    assert parse_import_ref(format_import_ref(upload)) == upload
    assert parse_import_ref(format_import_ref(media)) == media


@pytest.mark.parametrize(
    ("case", "raw"),
    [
        ("no_owner_prefix", SESSION_HANDLE),
        ("foreign_owner_prefix", f"library:{MEDIA_ID}"),
        ("media_ref_carrying_a_handle", f"media:{SESSION_HANDLE}"),
        ("upload_ref_carrying_a_uuid", f"upload:{MEDIA_ID}"),
        ("handle_of_another_seal_domain", "nus1.ERERERERQRGBEREREREREQ.AAECAwQFBgcICQoLDA0ODw"),
        ("noncanonical_uppercase_media_id", f"media:{str(MEDIA_ID).upper()}"),
        ("media_id_without_dashes", f"media:{MEDIA_ID.hex}"),
        ("empty_ref", ""),
    ],
)
def test_parse_import_ref_refuses_every_ref_that_names_no_owned_row(case: str, raw: str) -> None:
    with pytest.raises(InvalidImportRef) as raised:
        parse_import_ref(raw)

    assert raised.value.code is ApiErrorCode.E_INVALID_REQUEST, case


@pytest.mark.parametrize(
    ("view", "unsupported"),
    [
        ("NeedsAttention", {"state": "Complete"}),
        ("NeedsAttention", {"had_failures": True}),
        ("NeedsAttention", {"had_failures": False}),
        ("NeedsAttention", {"from": "2026-09-01T00:00:00Z"}),
        ("NeedsAttention", {"before": "2026-09-08T00:00:00Z"}),
        ("InProgress", {"state": "Active"}),
        ("InProgress", {"had_failures": True}),
        ("InProgress", {"from": "2026-09-01T00:00:00Z"}),
        ("InProgress", {"before": "2026-09-08T00:00:00Z"}),
        ("InProgress", {"failure_code": "E_INGEST_FAILED"}),
        ("History", {"failure_code": "E_INGEST_FAILED", "had_failures": False}),
    ],
)
def test_import_list_query_refuses_filters_its_view_cannot_correlate(
    view: str,
    unsupported: dict[str, object],
) -> None:
    with pytest.raises(InvalidRequestError) as raised:
        ImportListQuery.model_validate({"view": view, **unsupported})

    assert raised.value.code is ApiErrorCode.E_INVALID_REQUEST, f"{view} with {unsupported}"


@pytest.mark.parametrize(
    ("view", "supported"),
    [
        ("NeedsAttention", {"stage": "Extract", "failure_code": "E_INGEST_FAILED"}),
        ("InProgress", {"stage": "Index", "media_kind": "epub"}),
        (
            "History",
            {
                "stage": "Extract",
                "had_failures": True,
                "state": "Complete",
                "from": "2026-09-01T00:00:00Z",
                "before": "2026-09-08T00:00:00Z",
            },
        ),
    ],
)
def test_import_list_query_accepts_the_filters_its_view_correlates(
    view: str,
    supported: dict[str, object],
) -> None:
    query = ImportListQuery.model_validate({"view": view, **supported})

    assert query.view == view
    assert query.limit == 50


def test_import_list_query_binds_one_cursor_identity_to_one_filter_meaning() -> None:
    plain = ImportListQuery.model_validate(
        {"view": "History", "q": "Bakker", "from": "2026-09-01T00:00:00Z", "limit": 10}
    )
    respelled = ImportListQuery.model_validate(
        {
            "view": "History",
            "q": "  Bakker  ",
            "from": "2026-09-01T02:00:00+02:00",
            "limit": 100,
            "cursor": "opaque",
        }
    )
    other_window = ImportListQuery.model_validate(
        {"view": "History", "q": "Bakker", "from": "2026-09-02T00:00:00Z"}
    )
    blank_search = ImportListQuery.model_validate({"view": "History", "q": "   "})

    assert plain.matched_from == datetime(2026, 9, 1, tzinfo=UTC)
    assert plain.normalized() == respelled.normalized()
    assert plain.normalized() != other_window.normalized()
    assert blank_search.q is None
    assert blank_search.normalized() == ImportListQuery(view="History").normalized()


@pytest.mark.parametrize(
    ("case", "naive_bound"),
    [
        ("from_without_offset", {"from": "2026-09-01T00:00:00"}),
        ("before_without_offset", {"before": "2026-09-08T00:00:00"}),
    ],
)
def test_import_list_query_refuses_a_history_bound_without_an_offset(
    case: str,
    naive_bound: dict[str, str],
) -> None:
    with pytest.raises(InvalidRequestError) as raised:
        ImportListQuery.model_validate({"view": "History", **naive_bound})

    assert raised.value.code is ApiErrorCode.E_INVALID_REQUEST, case


def test_capabilities_never_offer_and_refuse_recovery_at_once() -> None:
    offer = RepairSearchOffer(expected_revision=7, expected_job_id=JOB_ID)

    offered = Capabilities(
        can_open=True,
        can_remove=True,
        recovery=present(offer),
        unavailable_reason=absent(),
    )
    refused = Capabilities(
        can_open=True,
        can_remove=False,
        recovery=absent(),
        unavailable_reason=present("NotOwner"),
    )

    assert offered.model_dump(mode="json")["recovery"] == {
        "kind": "Present",
        "value": {
            "kind": "RepairSearch",
            "expected_revision": 7,
            "expected_job_id": str(JOB_ID),
            "input": "PublishedContent",
        },
    }
    assert refused.model_dump(mode="json")["unavailable_reason"] == {
        "kind": "Present",
        "value": "NotOwner",
    }
    with pytest.raises(ValidationError):
        Capabilities(
            can_open=True,
            can_remove=True,
            recovery=present(offer),
            unavailable_reason=present("NotOwner"),
        )


def test_repair_request_keeps_one_canonical_replay_key_per_intent() -> None:
    request = SourceRepairRequest.model_validate(_repair_body(CLIENT_MUTATION_ID))

    assert request.client_mutation_id == CLIENT_MUTATION_ID
    assert request.expected_job_id == JOB_ID


@pytest.mark.parametrize(
    ("case", "respelled"),
    [
        ("uppercase", CLIENT_MUTATION_ID.upper()),
        ("braced", f"{{{CLIENT_MUTATION_ID}}}"),
        ("urn", f"urn:uuid:{CLIENT_MUTATION_ID}"),
        ("undashed", UUID(CLIENT_MUTATION_ID).hex),
        ("padded", f" {CLIENT_MUTATION_ID} "),
        ("opaque_text", "retry-once"),
    ],
)
def test_repair_request_refuses_a_second_spelling_of_one_replay_key(
    case: str,
    respelled: str,
) -> None:
    with pytest.raises(ValidationError, match="canonical lowercase UUID text"):
        SourceRepairRequest.model_validate(_repair_body(respelled))


def test_import_page_round_trips_the_row_the_pane_renders() -> None:
    page = ImportPage(
        observed_at=OBSERVED_AT,
        matched_count=1,
        groups=[ImportStageGroup(stage="Extract", count=1)],
        items=[
            ImportItem(
                ref=format_import_ref(MediaImportRef(media_id=MEDIA_ID)),
                title="The Darkness That Comes Before",
                media_kind="pdf",
                source_label=present("uploaded file"),
                media_ref=present(MEDIA_ID),
                state=ImportStateActive(
                    status="Processing",
                    stage="Extract",
                    waiting_reason=absent(),
                    progress=present(
                        SourceCountedProgress(
                            completed=80,
                            total=712,
                            unit="Page",
                            run_count=1,
                            updated_at=OBSERVED_AT,
                        )
                    ),
                    next_retry_at=absent(),
                ),
                accepted_at=OBSERVED_AT,
                updated_at=OBSERVED_AT,
                matched_event=absent(),
                capabilities=Capabilities(
                    can_open=False,
                    can_remove=True,
                    recovery=absent(),
                    unavailable_reason=absent(),
                ),
            )
        ],
        next_cursor=absent(),
    )

    dumped = page.model_dump(mode="json")

    assert dumped == {
        "observed_at": "2026-09-08T10:30:00Z",
        "matched_count": 1,
        "groups": [{"stage": "Extract", "count": 1}],
        "items": [
            {
                "ref": f"media:{MEDIA_ID}",
                "title": "The Darkness That Comes Before",
                "media_kind": "pdf",
                "source_label": {"kind": "Present", "value": "uploaded file"},
                "media_ref": {"kind": "Present", "value": str(MEDIA_ID)},
                "state": {
                    "kind": "Active",
                    "status": "Processing",
                    "stage": "Extract",
                    "waiting_reason": {"kind": "Absent"},
                    "progress": {
                        "kind": "Present",
                        "value": {
                            "kind": "Counted",
                            "stage": "Extract",
                            "completed": 80,
                            "total": 712,
                            "unit": "Page",
                            "run_count": 1,
                            "updated_at": "2026-09-08T10:30:00Z",
                        },
                    },
                    "next_retry_at": {"kind": "Absent"},
                },
                "accepted_at": "2026-09-08T10:30:00Z",
                "updated_at": "2026-09-08T10:30:00Z",
                "matched_event": {"kind": "Absent"},
                "capabilities": {
                    "can_open": False,
                    "can_remove": True,
                    "recovery": {"kind": "Absent"},
                    "unavailable_reason": {"kind": "Absent"},
                },
            }
        ],
        "next_cursor": {"kind": "Absent"},
    }
    assert ImportPage.model_validate(dumped).model_dump(mode="json") == dumped
    with pytest.raises(ValidationError):
        ImportPage.model_validate({**dumped, "has_more": False})
    # A blank label or title is not a renderable row: the browser decoder
    # refuses it, so the producer must never emit one in the first place.
    with pytest.raises(ValidationError, match="at least 1 character"):
        ImportPage.model_validate(
            {
                **dumped,
                "items": [{**dumped["items"][0], "source_label": {"kind": "Present", "value": ""}}],
            }
        )
