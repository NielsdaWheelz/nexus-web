"""Deterministic reader oversize answers 422, never the 503 admission code.

Risk: `E_READ_CAPACITY` is 503 retryable availability and `retryPolicy.ts`
retries every non-defect 5xx three times. A permanently oversized read wearing
that code therefore costs three admitted reads and three full serializations of
the payload the admission owner exists to prevent, and then reports an outage
the reader can never clear. Oracle: `docs/cutovers/bounded-workspace-implementation.md`
sections 0/a and b (one admission owner, `E_READ_CAPACITY` retryable
availability, "an oversized supported request must be redesigned or provisioned
correctly") and `docs/rules/errors.md` (no synthetic middle-ground availability
errors; classify where the condition is detected).
"""

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.errors import ERROR_CODE_TO_STATUS, ApiErrorCode, ReaderContentTooLargeError
from nexus.schemas.import_history import SAFE_FAILURE_CODES
from nexus.services.capabilities import is_same_source_terminal_error
from nexus.services.media_source_ingest import _TERMINAL_SOURCE_FAILURE_CODES
from tests.testkit.auth import UserRecord
from tests.testkit.reader_publication import seed_retained_text

_FIND_BODY = {
    "query": "abc",
    "match_case": True,
    "whole_word": False,
    "scope": {"kind": "EntireResource"},
    "after": None,
}


def test_an_unservable_reader_read_answers_422_and_names_the_limit_it_broke(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same request answers 200 under the run profile and 422 under a profile
    whose index page cannot hold one occurrence, so the refusal is the bound and
    not the fixture. 422 is what makes the browser retry owner stop at one
    attempt without any client-side predicate."""
    media_id, _fragment_id = seed_retained_text(
        db_session, test_user, ("",) * 8 + ("a", "b", "c", "yyyy"), ()
    )
    path = f"/media/{media_id}/reader-publications/1/find"

    served = authenticated_client.post(path, json=_FIND_BODY)
    assert served.status_code == 200, served.text
    assert served.json()["data"]["occurrences"], "the fixture must produce a match to refuse"

    monkeypatch.setenv(
        "READER_PUBLICATION_LIMITS",
        json.dumps(
            {
                "unit_bytes": 1100,
                "unit_codepoints": 160,
                "unit_dom_nodes": 20,
                "index_bytes": 64,
                "descriptor_bytes": 1000,
            }
        ),
    )
    clear_settings_cache()
    try:
        refused = authenticated_client.post(path, json=_FIND_BODY)
    finally:
        monkeypatch.undo()
        clear_settings_cache()

    assert refused.status_code == 422, refused.text
    error = refused.json()["error"]
    assert error["code"] == "E_READER_CONTENT_TOO_LARGE", (
        "a permanent oversize must not wear the admission owner's retryable code"
    )
    assert "retry-after" not in refused.headers, (
        "retry guidance for a refusal that is identical on every attempt"
    )
    assert error["details"]["limit"] == "index_bytes"
    assert error["details"]["limit_value"] == 64
    assert error["details"]["measured"] > 64, (
        f"the refusal must report the size it actually measured: {error['details']}"
    )


def test_the_oversize_carrier_reports_only_what_it_measured() -> None:
    """`measured` is the size the content reached. A site that refuses content
    without producing one number — a split search that admits no unit at all —
    omits the key rather than publishing an invented figure."""
    measured = ReaderContentTooLargeError(
        "Reader unit exceeds qualified capacity",
        limit="unit_bytes",
        limit_value=1100,
        measured=1360,
    )
    unsplittable = ReaderContentTooLargeError(
        "Reader element exceeds qualified unit capacity",
        limit="unit_bytes",
        limit_value=1100,
        measured=None,
    )

    assert measured.status_code == 422
    assert measured.retry_after_seconds is None
    assert measured.details == {"limit": "unit_bytes", "limit_value": 1100, "measured": 1360}
    assert unsplittable.details == {"limit": "unit_bytes", "limit_value": 1100}


def test_preparation_oversize_is_terminal_for_ingest_history_and_capability() -> None:
    """Publication preparation raises this code inside a source attempt, so the
    attempt must fail terminally, history must be able to name the code, and the
    capability owner must never offer the same source again: retrying an import
    of content the qualified profile cannot serve produces the same failure."""
    assert ApiErrorCode.E_READER_CONTENT_TOO_LARGE in _TERMINAL_SOURCE_FAILURE_CODES, (
        "an oversize raised during preparation would otherwise be retried as transient"
    )
    assert ApiErrorCode.E_READER_CONTENT_TOO_LARGE.value in SAFE_FAILURE_CODES, (
        "a failure code history cannot name reaches the reader as an unexplained token"
    )
    assert is_same_source_terminal_error(ApiErrorCode.E_READER_CONTENT_TOO_LARGE.value)
    assert ERROR_CODE_TO_STATUS[ApiErrorCode.E_READER_CONTENT_TOO_LARGE] == 422
