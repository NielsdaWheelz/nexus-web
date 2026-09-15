"""Import-history payload codec and safe-failure-code catalog proof.

Risk: broken provenance and silent history corruption. `media_upload_events` /
`media_processing_events` store only a `payload` JSONB beside their indexed
envelope; the module under proof is the only writer and the only reader, so a
payload that cannot be decoded back into its exact variant, or a real owner
failure code the catalog does not name, is unreadable import history.
Oracle: `docs/cutovers/imports-workspace-hard-cutover.md` (event/payload
contract) and contract D5 (catalog composition), plus the owner modules
themselves for catalog completeness.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, get_args
from uuid import UUID

import pytest

from nexus.schemas.import_history import (
    PROCESSING_EVENTS_TABLE,
    SAFE_FAILURE_CODES,
    UPLOAD_EVENTS_TABLE,
    FailedSourceBaselineOutcome,
    HistoryFacts,
    IndexAccepted,
    IndexExecutionStarted,
    IndexFacts,
    IndexFailed,
    IndexRecoveryAccepted,
    IndexRetryScheduled,
    IndexSucceeded,
    IndexSuperseded,
    InFlightSourceBaselineOutcome,
    RepairSourceRecovery,
    RetrySourceRecovery,
    SourceAccepted,
    SourceExecutionStarted,
    SourceFacts,
    SourceFailed,
    SourceFailureProgress,
    SourceHistoryBaseline,
    SourceRecoveryAccepted,
    SourceRetryScheduled,
    SourceStageChanged,
    SourceSucceeded,
    SourceSuperseded,
    SucceededSourceBaselineOutcome,
    UploadAccepted,
    UploadExecutionStarted,
    UploadFacts,
    UploadFailed,
    UploadHistoryBaseline,
    UploadPublished,
    UploadRecoveryAccepted,
    assume_safe_failure_code,
    history_event_type,
    history_facts,
    history_payload,
    queue_failure_code,
)
from nexus.schemas.presence import absent, present
from nexus.schemas.upload_failures import (
    UploadTransportHttpRejectedFailure,
    UploadVerificationFailureCode,
)
from nexus.services.capabilities import _SAME_SOURCE_TERMINAL_ERROR_CODES
from nexus.services.media_source_ingest import _TERMINAL_SOURCE_FAILURE_CODES

_ATTEMPT_ID = UUID("018f0000-0000-7000-8000-000000000001")
_EXECUTION_ID = UUID("018f0000-0000-7000-8000-000000000002")
_MEDIA_ID = UUID("018f0000-0000-7000-8000-000000000003")
_JOB_ID = UUID("018f0000-0000-7000-8000-000000000004")
_AT = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)

_UPLOAD_SAMPLES: tuple[UploadFacts, ...] = (
    UploadAccepted(generation=1),
    UploadExecutionStarted(generation=1),
    UploadFailed(generation=2, transport=present(UploadTransportHttpRejectedFailure(status=503))),
    UploadFailed(generation=2, transport=absent()),
    UploadRecoveryAccepted(generation=3),
    UploadPublished(generation=3, media_id=_MEDIA_ID, source_attempt_id=_ATTEMPT_ID),
    UploadHistoryBaseline(generation=4),
)

_SOURCE_SAMPLES: tuple[SourceFacts, ...] = (
    SourceAccepted(source_attempt_id=_ATTEMPT_ID, attempt_no=2),
    SourceExecutionStarted(source_attempt_id=_ATTEMPT_ID, execution_id=_EXECUTION_ID),
    SourceStageChanged(source_attempt_id=_ATTEMPT_ID, execution_id=_EXECUTION_ID),
    SourceRetryScheduled(
        source_attempt_id=_ATTEMPT_ID, execution_id=present(_EXECUTION_ID), next_attempt_at=_AT
    ),
    SourceFailed(
        source_attempt_id=_ATTEMPT_ID,
        execution_id=absent(),
        origin="Domain",
        terminal=True,
        progress=present(
            SourceFailureProgress(completed=3, total=present(9), unit=present("page"))
        ),
    ),
    SourceRecoveryAccepted(
        source_attempt_id=_ATTEMPT_ID,
        recovery=RetrySourceRecovery(new_source_attempt_id=_ATTEMPT_ID),
    ),
    SourceRecoveryAccepted(
        source_attempt_id=_ATTEMPT_ID, recovery=RepairSourceRecovery(job_id=_JOB_ID)
    ),
    SourceSucceeded(source_attempt_id=_ATTEMPT_ID, execution_id=absent()),
    SourceSuperseded(source_attempt_id=_ATTEMPT_ID, winner_media_id=_MEDIA_ID),
    SourceHistoryBaseline(
        source_attempt_id=_ATTEMPT_ID, attempt_no=1, outcome=SucceededSourceBaselineOutcome()
    ),
    SourceHistoryBaseline(
        source_attempt_id=_ATTEMPT_ID,
        attempt_no=1,
        outcome=FailedSourceBaselineOutcome(failure_code="E_SOURCE_INTEGRITY"),
    ),
    SourceHistoryBaseline(
        source_attempt_id=_ATTEMPT_ID, attempt_no=1, outcome=InFlightSourceBaselineOutcome()
    ),
)

_INDEX_SAMPLES: tuple[IndexFacts, ...] = (
    IndexAccepted(revision=7, job_id=_JOB_ID),
    IndexExecutionStarted(revision=7, job_id=_JOB_ID, execution_id=_EXECUTION_ID),
    IndexRetryScheduled(revision=7, job_id=_JOB_ID, execution_id=absent(), next_attempt_at=_AT),
    IndexFailed(
        revision=7,
        job_id=_JOB_ID,
        execution_id=present(_EXECUTION_ID),
        origin="Execution",
        terminal=False,
    ),
    IndexRecoveryAccepted(revision=8, job_id=_JOB_ID),
    IndexSucceeded(revision=8, job_id=_JOB_ID, execution_id=_EXECUTION_ID),
    IndexSuperseded(revision=8, job_id=_JOB_ID, execution_id=_EXECUTION_ID),
)

_D5_OWNER_MODULES = (
    "nexus/services/media_source_ingest.py",
    "nexus/services/web_article_ingest.py",
    "nexus/services/remote_file_client.py",
    "nexus/services/x_ingest.py",
    "nexus/services/youtube_video_ingest.py",
    "nexus/services/pdf_ingest.py",
    "nexus/services/epub_ingest.py",
    "nexus/services/node_ingest.py",
    "nexus/services/email_ingest_service.py",
    "nexus/services/podcasts/transcription.py",
    "nexus/services/podcasts/transcription_failure.py",
    "nexus/services/podcasts/provider.py",
    "nexus/services/content_indexing.py",
    "nexus/storage/client.py",
)
"""Every module that writes a failure code the catalog must name (contract D5).

`x_client.py` is not among them: it raises `XProviderErrorCode`, and
`x_ingest.py` is where those become the `E_X_PROVIDER_*` codes a reader sees.
"""


def _variants(alias: Any) -> set[type]:
    """The concrete models of a `Field(discriminator=...)`-annotated union alias."""
    return set(get_args(get_args(alias)[0]))


def _samples() -> list[tuple[str, HistoryFacts]]:
    return [
        *((UPLOAD_EVENTS_TABLE, facts) for facts in _UPLOAD_SAMPLES),
        *((PROCESSING_EVENTS_TABLE, facts) for facts in _SOURCE_SAMPLES),
        *((PROCESSING_EVENTS_TABLE, facts) for facts in _INDEX_SAMPLES),
    ]


def test_every_history_variant_round_trips_through_its_stored_payload() -> None:
    covered = {type(facts) for _table, facts in _samples()}
    assert covered == _variants(HistoryFacts), (
        "every history variant needs a stored-payload sample: missing="
        f"{sorted(model.__name__ for model in _variants(HistoryFacts) - covered)} "
        f"unexpected={sorted(model.__name__ for model in covered - _variants(HistoryFacts))}"
    )

    for table, facts in _samples():
        event_type = history_event_type(facts)
        payload = history_payload(facts)
        decoded = history_facts(table=table, event_type=event_type, payload=payload)
        assert "kind" not in payload, (
            f"{facts.kind} payload must not duplicate the envelope discriminator: {payload!r}"
        )
        assert decoded == facts, (
            f"{facts.kind} did not survive storage: stored=({table!r}, {event_type!r}, "
            f"{payload!r}) decoded={decoded!r}"
        )


def test_historical_provider_rejection_survives_the_failed_baseline() -> None:
    facts = SourceHistoryBaseline(
        source_attempt_id=_ATTEMPT_ID,
        attempt_no=1,
        outcome=FailedSourceBaselineOutcome(
            failure_code=assume_safe_failure_code("E_LLM_BAD_REQUEST")
        ),
    )

    payload = history_payload(facts)

    assert payload["outcome"] == {"kind": "Failed", "failure_code": "E_LLM_BAD_REQUEST"}
    assert (
        history_facts(table=PROCESSING_EVENTS_TABLE, event_type="HistoryBaseline", payload=payload)
        == facts
    )


def test_a_stored_payload_with_an_unknown_field_is_rejected() -> None:
    payload = {**history_payload(_SOURCE_SAMPLES[0]), "note": "hand edited"}

    with pytest.raises(ValueError) as rejection:
        history_facts(table=PROCESSING_EVENTS_TABLE, event_type="Accepted", payload=payload)

    assert "note" in str(rejection.value), (
        f"a foreign payload key must be named in the rejection: {rejection.value}"
    )


def test_an_event_type_the_branch_does_not_own_is_a_defect_naming_it() -> None:
    """A stored type the owning branch never writes is corruption, not an unknown
    variant to decode; the defect names the value so the row can be found."""
    with pytest.raises(AssertionError, match="'Superseded'"):
        history_facts(
            table=UPLOAD_EVENTS_TABLE,
            event_type="Superseded",
            payload={"generation": 1},
        )


def test_safe_failure_code_catalog_names_every_owner_failure_code() -> None:
    """The scan reads bare `E_` tokens, not only `ApiErrorCode.` attribute access:
    an owner may write a code the enum does not carry as a plain string, and such a
    write reaches `media.last_error_code` and `media_source_attempts.error_code`
    exactly like any other."""
    python_root = Path(__file__).parents[2]
    referenced = {
        module: set(re.findall(r"\bE_[A-Z0-9_]{3,}\b", (python_root / module).read_text()))
        for module in _D5_OWNER_MODULES
    }

    missing = {
        module: sorted(codes - SAFE_FAILURE_CODES)
        for module, codes in referenced.items()
        if codes - SAFE_FAILURE_CODES
    }

    assert all(referenced.values()), (
        "a scanned module that yields no code cannot fail this proof: "
        f"{sorted(module for module, codes in referenced.items() if not codes)}"
    )
    assert not missing, f"SafeFailureCode does not name every owner failure code: {missing}"
    assert {code.value for code in _TERMINAL_SOURCE_FAILURE_CODES} <= SAFE_FAILURE_CODES, (
        "terminal source failure codes must all be safe history codes"
    )
    assert set(get_args(UploadVerificationFailureCode)) <= SAFE_FAILURE_CODES, (
        "upload verification codes must all be safe history codes"
    )


def test_browser_failure_code_catalog_mirrors_the_python_catalog() -> None:
    """Contract D18: the browser narrows `failure_code` to its own `as const`
    mirror of this catalog, so a code one side does not know reaches a reader as
    a decode defect or an unexplained token. The two lists are compared as sets,
    read from the repository root so neither side can drift silently."""
    repository_root = Path(__file__).parents[3]
    browser_source = (repository_root / "apps/web/src/lib/imports/importRef.ts").read_text()
    literal = re.search(
        r"export const SAFE_FAILURE_CODES = \[(?P<codes>.*?)\] as const;", browser_source, re.DOTALL
    )
    assert literal is not None, (
        "importRef.ts no longer declares SAFE_FAILURE_CODES as an array literal"
    )
    browser_codes = re.findall(r'"(E_[A-Z0-9_]+)"', literal.group("codes"))

    assert len(browser_codes) == len(set(browser_codes)), (
        f"the browser catalog repeats a code: {sorted(browser_codes)}"
    )
    assert set(browser_codes) == SAFE_FAILURE_CODES, (
        "browser and Python failure-code catalogs differ: browser-only="
        f"{sorted(set(browser_codes) - SAFE_FAILURE_CODES)} python-only="
        f"{sorted(SAFE_FAILURE_CODES - set(browser_codes))}"
    )


def test_browser_copy_never_offers_the_same_source_for_an_owner_terminal_code() -> None:
    """`lib/status/imports.ts` guarantees in its own doc comment that `recovery`
    never says `SameSource` for a code the policy owner lists as same-source
    terminal, so the record and the policy can never offer a reader two different
    answers. Read from the repository root, like the D18 mirror above, so a code
    added to the owner frozenset cannot leave the guarantee unproved."""
    repository_root = Path(__file__).parents[3]
    copy_source = (repository_root / "apps/web/src/lib/status/imports.ts").read_text()
    catalog = re.search(
        r"export const IMPORT_FAILURE_COPY\b.*?= \{(?P<records>.*?)\n\};", copy_source, re.DOTALL
    )
    assert catalog is not None, (
        "imports.ts no longer declares IMPORT_FAILURE_COPY as one object literal"
    )
    recovery_by_code = dict(
        re.findall(r'(E_[A-Z0-9_]+): \{[^{}]*?recovery: "([A-Za-z]+)"', catalog.group("records"))
    )

    assert set(recovery_by_code) == SAFE_FAILURE_CODES, (
        "the parsed copy records are not the failure-code catalog: copy-only="
        f"{sorted(set(recovery_by_code) - SAFE_FAILURE_CODES)} catalog-only="
        f"{sorted(SAFE_FAILURE_CODES - set(recovery_by_code))}"
    )
    assert _SAME_SOURCE_TERMINAL_ERROR_CODES <= set(recovery_by_code), (
        "the copy owner has no record for a same-source-terminal code: "
        f"{sorted(_SAME_SOURCE_TERMINAL_ERROR_CODES - set(recovery_by_code))}"
    )
    offenders = sorted(
        code for code in _SAME_SOURCE_TERMINAL_ERROR_CODES if recovery_by_code[code] == "SameSource"
    )

    assert not offenders, (
        f"the copy owner offers the same source for codes the policy always refuses: {offenders}"
    )


def test_queue_failure_code_is_total_and_assume_defects_on_an_uncatalogued_code() -> None:
    assert queue_failure_code("E_WORKER_INTERRUPTED") == "E_WORKER_INTERRUPTED"
    assert queue_failure_code("E_WORKER_CHILD_DEFECT") == "E_WORKER_HANDLER_FAILED", (
        "an execution code outside the catalog must not abort a queue transition"
    )
    assert assume_safe_failure_code("E_SOURCE_INTEGRITY") == "E_SOURCE_INTEGRITY"

    with pytest.raises(AssertionError) as defect:
        assume_safe_failure_code("E_WORKER_CHILD_DEFECT")

    assert "E_WORKER_CHILD_DEFECT" in str(defect.value), (
        f"a trusted-column defect must name the code it read: {defect.value}"
    )
