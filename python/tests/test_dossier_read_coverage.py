"""Typed binding-derived coverage on current and historical Dossier reads."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from nexus.api.routes.dossiers import _revision_out, _revision_summary_out
from nexus.schemas.presence import present
from nexus.services.artifacts.manifests import (
    ContributorInputManifestV1,
    ConversationComplete,
    ConversationInputManifestV1,
    EvidenceOmission,
    LibraryInputManifestV1,
    MediaDisposition,
    MediaInputManifestV1,
    MediaManifestEntry,
    NoteInputManifestV1,
    PageInputManifestV1,
    PodcastInputManifestV1,
)
from nexus.services.artifacts.revisions import RevisionSummary, RevisionView

pytestmark = pytest.mark.unit


def _manifest_cases():
    included = MediaManifestEntry(
        media_ref="media:included",
        content_fingerprint="fingerprint-included",
        disposition=MediaDisposition.Included,
    )
    omitted = MediaManifestEntry(
        media_ref="media:omitted",
        content_fingerprint="fingerprint-omitted",
        disposition=MediaDisposition.OmittedBudget,
    )
    return [
        (
            "media",
            MediaInputManifestV1(
                media_ref="media:m1",
                content_fingerprint="fingerprint",
                offered_claim_count=3,
                omitted_evidence=[EvidenceOmission(evidence_ref="evidence_span:e1")],
            ),
            {
                "kind": "media",
                "offered_claim_count": 3,
                "omitted_evidence_refs": ["evidence_span:e1"],
            },
        ),
        (
            "conversation",
            ConversationInputManifestV1(
                conversation_ref="conversation:c1",
                message_refs=["message:m1", "message:m2"],
                context_refs=["media:m1"],
                topology_fingerprint=present("topology"),
                completeness=ConversationComplete(),
            ),
            {
                "kind": "conversation",
                "message_refs": ["message:m1", "message:m2"],
                "context_refs": ["media:m1"],
            },
        ),
        (
            "library",
            LibraryInputManifestV1(
                library_ref="library:l1",
                media=[included, omitted],
            ),
            {
                "kind": "library",
                "included": ["media:included"],
                "omitted": [["media:omitted", "OmittedBudget"]],
            },
        ),
        (
            "podcast",
            PodcastInputManifestV1(
                podcast_ref="podcast:p1",
                episodes=[included, omitted],
            ),
            {
                "kind": "podcast",
                "included": ["media:included"],
                "omitted": [["media:omitted", "OmittedBudget"]],
            },
        ),
        (
            "contributor",
            ContributorInputManifestV1(
                contributor_handle="ursula-k-le-guin",
                works=[included, omitted],
            ),
            {
                "kind": "contributor",
                "included": ["media:included"],
                "omitted": [["media:omitted", "OmittedBudget"]],
            },
        ),
        (
            "page",
            PageInputManifestV1(
                page_ref="page:p1",
                input_fingerprint="page-input",
                block_refs=["note_block:n1"],
                connection_refs=["media:m1"],
            ),
            {
                "kind": "page",
                "block_refs": ["note_block:n1"],
                "connection_refs": ["media:m1"],
            },
        ),
        (
            "note_block",
            NoteInputManifestV1(
                note_ref="note_block:n1",
                input_fingerprint="note-input",
                body_fingerprint=present("body"),
                connection_refs=["page:p1"],
            ),
            {
                "kind": "note",
                "body_present": True,
                "connection_refs": ["page:p1"],
            },
        ),
    ]


@pytest.mark.parametrize(("subject_scheme", "manifest", "expected"), _manifest_cases())
def test_current_and_historical_revision_reads_share_binding_coverage(
    subject_scheme, manifest, expected
) -> None:
    artifact_id = uuid4()
    revision_id = uuid4()
    now = datetime.now(UTC)
    manifest_wire = manifest.model_dump(mode="json")

    current = _revision_out(
        RevisionView(
            artifact_id=artifact_id,
            subject_scheme=subject_scheme,
            revision_id=revision_id,
            content_md="# Dossier",
            created_at=now,
            promoted_at=now,
            is_current=True,
            citations=[],
            input_manifest=manifest_wire,
            instruction=None,
            creator_user_id=None,
            model_provider=None,
            model_name=None,
            total_tokens=None,
        )
    )
    historical = _revision_summary_out(
        RevisionSummary(
            artifact_id=artifact_id,
            subject_scheme=subject_scheme,
            revision_id=revision_id,
            created_at=now,
            promoted_at=now,
            is_current=True,
            citation_count=0,
            input_manifest=manifest_wire,
            instruction=None,
            creator_user_id=None,
            model_provider=None,
            model_name=None,
            total_tokens=None,
        )
    )

    assert current.coverage.model_dump(mode="json") == expected
    assert historical.coverage.model_dump(mode="json") == expected
