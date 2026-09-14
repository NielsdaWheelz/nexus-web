from uuid import UUID

from nexus.schemas.browse import ExternalOnlyResolution, InNexusResolution, PreviewResolution
from nexus.schemas.search import (
    SearchResponse,
    SearchResultContextRefOut,
    SearchResultPageOut,
    SearchResultSourceOut,
)
from nexus.services import contributors
from nexus.services.browse import nexus as nexus_browse
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import projection, results

MEDIA_ID = UUID("11111111-1111-4111-8111-111111111111")
OTHER_ID = UUID("22222222-2222-4222-8222-222222222222")
THIRD_ID = UUID("33333333-3333-4333-8333-333333333333")
MEDIA_REF = f"media:{MEDIA_ID}"


def _source() -> SearchResultSourceOut:
    return SearchResultSourceOut(
        media_id=MEDIA_ID,
        media_kind="web_article",
        title="Field Notes",
        contributors=[],
    )


def _score() -> results._SearchScore:
    return results._SearchScore(raw=1.0)


def test_search_serializes_one_camel_subject_key_without_changing_activation_case() -> None:
    row = SearchResultPageOut(
        type="page",
        id=OTHER_ID,
        score=1.0,
        snippet="Field notes",
        title="Field Notes",
        source_label="page",
        media_id=None,
        media_kind=None,
        resource_ref=f"page:{OTHER_ID}",
        owner_resource_ref=f"page:{OTHER_ID}",
        action_subject_ref=f"page:{OTHER_ID}",
        activation={
            "resource_ref": f"page:{OTHER_ID}",
            "kind": "route",
            "href": f"/pages/{OTHER_ID}",
            "unresolved_reason": None,
        },
        citation_target=f"page:{OTHER_ID}",
        context_ref=SearchResultContextRefOut(type="page", id=OTHER_ID),
    )

    wire = row.model_dump(mode="json", by_alias=True)

    assert wire["actionSubjectRef"] == f"page:{OTHER_ID}"
    assert "action_subject_ref" not in wire
    assert wire["activation"] == {
        "resource_ref": f"page:{OTHER_ID}",
        "kind": "route",
        "href": f"/pages/{OTHER_ID}",
        "unresolved_reason": None,
    }


def test_search_response_accepts_its_camel_subject_wire_key() -> None:
    row = SearchResultPageOut(
        type="page",
        id=OTHER_ID,
        score=1.0,
        snippet="Field notes",
        title="Field Notes",
        source_label="page",
        media_id=None,
        media_kind=None,
        resource_ref=f"page:{OTHER_ID}",
        owner_resource_ref=f"page:{OTHER_ID}",
        action_subject_ref=f"page:{OTHER_ID}",
        activation={
            "resource_ref": f"page:{OTHER_ID}",
            "kind": "route",
            "href": f"/pages/{OTHER_ID}",
            "unresolved_reason": None,
        },
        citation_target=f"page:{OTHER_ID}",
        context_ref=SearchResultContextRefOut(type="page", id=OTHER_ID),
    )

    SearchResponse.model_validate(
        {
            "results": [row.model_dump(mode="json", by_alias=True)],
            "page": {},
        }
    )


def test_search_publisher_separates_occurrence_owner_and_exact_resource_subject() -> None:
    chunk = results._RankedContentChunkResult(
        id=OTHER_ID,
        snippet="Field notes",
        source_kind="document",
        evidence_span_ids=[THIRD_ID],
        citation_label="Field Notes",
        locator={},
        resolver={},
        source=_source(),
        score=_score(),
    )
    evidence = results._RankedEvidenceSpanResult(
        id=OTHER_ID,
        snippet="Field notes",
        citation_label="Field Notes",
        locator={},
        source=_source(),
        score=_score(),
        owner_ref=ResourceRef(scheme="note_block", id=THIRD_ID),
    )
    highlight = results._RankedHighlightResult(
        id=OTHER_ID,
        snippet="Field notes",
        exact="Field notes",
        color="yellow",
        source=_source(),
        score=_score(),
    )
    message = results._RankedMessageResult(
        id=OTHER_ID,
        snippet="Field notes",
        conversation_id=THIRD_ID,
        seq=1,
        score=_score(),
    )
    artifact = results._RankedArtifactResult(
        id=OTHER_ID,
        revision_id=THIRD_ID,
        snippet="Field notes",
        score=_score(),
    )

    assert projection.search_action_subject_ref(chunk).uri == MEDIA_REF
    assert projection.search_action_subject_ref(evidence).uri == f"note_block:{THIRD_ID}"
    assert projection.search_action_subject_ref(highlight).uri == f"highlight:{OTHER_ID}"
    assert projection.search_action_subject_ref(message).uri == f"message:{OTHER_ID}"
    assert projection.search_action_subject_ref(artifact).uri == f"artifact_revision:{THIRD_ID}"


def test_browse_publishers_identify_only_owned_candidates() -> None:
    candidate = nexus_browse._candidate(
        {
            "id": MEDIA_ID,
            "kind": "web_article",
            "title": "Field Notes",
            "description": None,
            "requested_url": "https://example.test/field-notes",
            "canonical_source_url": None,
            "provider": None,
            "provider_id": None,
            "page_count": None,
        },
        contributors=[],
    )

    assert candidate.resolution.model_dump(mode="json", by_alias=True) == {
        "kind": "InNexus",
        "href": f"/media/{MEDIA_ID}",
        "actionSubjectRef": MEDIA_REF,
    }
    signed = "ndt1.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    assert PreviewResolution(target=signed).model_dump(mode="json", by_alias=True) == {
        "kind": "Preview",
        "target": signed,
    }
    assert ExternalOnlyResolution(source_href="https://example.test").model_dump(
        mode="json", by_alias=True
    ) == {
        "kind": "ExternalOnly",
        "sourceHref": "https://example.test",
    }


def test_contributor_work_publisher_uses_null_for_external_occurrences() -> None:
    media = contributors._contributor_work_action_subject(
        media_id=MEDIA_ID,
        podcast_id=None,
        gutenberg_ebook_id=None,
    )
    podcast = contributors._contributor_work_action_subject(
        media_id=None,
        podcast_id=OTHER_ID,
        gutenberg_ebook_id=None,
    )
    external = contributors._contributor_work_action_subject(
        media_id=None,
        podcast_id=None,
        gutenberg_ebook_id=123,
    )

    assert media is not None and media.model_dump() == {"ref": MEDIA_REF}
    assert podcast is not None and podcast.model_dump() == {"ref": f"podcast:{OTHER_ID}"}
    assert external is None


def test_in_nexus_schema_has_no_legacy_standing_target_shape() -> None:
    resolution = InNexusResolution(
        href=f"/media/{MEDIA_ID}",
        action_subject_ref=MEDIA_REF,
    )

    assert resolution.model_dump(mode="json", by_alias=True) == {
        "kind": "InNexus",
        "href": f"/media/{MEDIA_ID}",
        "actionSubjectRef": MEDIA_REF,
    }
