"""Integration tests for ``resource_graph.resolve`` (the per-scheme hydration owner).

Covers one happy-path and one permission/missing-path test per scheme in the
loader dispatch. Assertions go through the service surface (``resolve_refs``)
rather than raw SQL so each scheme's permission and inline-threshold behavior
is part of the contract under test. Ref-grammar rejection lives in the pure
unit tests (``test_resource_graph_refs``).
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Contributor,
    EvidenceSpan,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Media,
    MediaKind,
    Message,
    NoteBlock,
    OracleCorpusSource,
    OraclePassageAnchor,
    OracleReading,
    Page,
    PdfPageTextSpan,
    Podcast,
    PodcastSubscription,
    ProcessingStatus,
    ResourceEdge,
    ResourceExternalSnapshot,
)
from nexus.services import oracle_corpus
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_graph.resolve import (
    INLINE_THRESHOLD_CHARS,
    ResolvedResource,
    resolve_refs,
)
from nexus.services.resource_items.routing import route_for_ref
from tests.factories import (
    add_media_to_library,
    create_test_conversation,
    create_test_library,
    create_test_media_in_library,
    create_test_message,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


def _resolve(db: Session, uri: str, *, viewer_id: UUID) -> ResolvedResource:
    return resolve_refs(db, viewer_id=viewer_id, refs=[assert_resource_ref(uri)])[0]


def _resolve_batch(db: Session, uris: list[str], *, viewer_id: UUID) -> list[ResolvedResource]:
    return resolve_refs(db, viewer_id=viewer_id, refs=[assert_resource_ref(u) for u in uris])


# =============================================================================
# Helpers
# =============================================================================


def _make_span(db: Session, media_id: UUID, text: str = "Inline span body.") -> UUID:
    """Create an evidence_span anchored to a media for resolver tests.

    Wires up the minimum current content block so the span's FKs satisfy the
    schema. Resolver only reads ``span_text``, ``citation_label``, and
    ``owner_id`` via the join.
    """
    from sqlalchemy import text as sql_text

    block_id = db.execute(
        sql_text(
            """
            INSERT INTO content_blocks (
                owner_kind, owner_id, block_idx, block_kind,
                canonical_text, extraction_confidence,
                source_start_offset, source_end_offset,
                heading_path, locator, selector, metadata
            )
            VALUES (
                'media', :media_id, 0, 'paragraph',
                :canonical_text, 1.0, 0, :source_end_offset,
                '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "canonical_text": text,
            "source_end_offset": len(text),
        },
    ).scalar_one()
    span = EvidenceSpan(
        id=uuid4(),
        owner_kind="media",
        owner_id=media_id,
        start_block_id=block_id,
        end_block_id=block_id,
        start_block_offset=0,
        end_block_offset=len(text),
        span_text=text,
        selector={},
        citation_label="excerpt",
        resolver_kind="web",
    )
    db.add(span)
    db.flush()
    db.commit()
    return span.id


def _make_page(db: Session, user_id: UUID, *, title: str = "Test Page") -> UUID:
    page = Page(id=uuid4(), user_id=user_id, title=title)
    db.add(page)
    db.commit()
    return page.id


def _make_note_block(db: Session, user_id: UUID, *, body: str = "Note body.") -> UUID:
    page_id = _make_page(db, user_id)
    block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": body}]},
        body_text=body,
    )
    db.add(block)
    db.flush()
    db.add(
        ResourceEdge(
            user_id=user_id,
            kind="context",
            origin="user",
            source_scheme="page",
            source_id=page_id,
            target_scheme="note_block",
            target_id=block.id,
            source_order_key="0000000001",
        )
    )
    db.commit()
    return block.id


def _make_highlight_with_anchor(
    db: Session,
    user_id: UUID,
    media_id: UUID,
    *,
    exact: str = "some highlighted text",
    prefix: str = "",
    suffix: str = "",
) -> UUID:
    fragment = (
        db.query(Fragment).filter(Fragment.media_id == media_id).order_by(Fragment.idx).first()
    )
    if fragment is None:
        fragment = Fragment(
            id=uuid4(),
            media_id=media_id,
            idx=0,
            canonical_text=exact,
            html_sanitized=f"<p>{exact}</p>",
        )
        db.add(fragment)
        db.flush()
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media_id,
        color="yellow",
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )
    db.add(highlight)
    db.flush()
    db.add(
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment.id,
            start_offset=0,
            end_offset=len(exact),
        )
    )
    db.commit()
    return highlight.id


def _add_fragment(db: Session, media_id: UUID, *, idx: int, text: str) -> UUID:
    fragment = Fragment(
        id=uuid4(),
        media_id=media_id,
        idx=idx,
        canonical_text=text,
        html_sanitized=f"<p>{text}</p>",
    )
    db.add(fragment)
    db.commit()
    return fragment.id


def _make_li_artifact(
    db: Session,
    library_id: UUID,
    user_id: UUID,
    *,
    content_md: str | None = "Synthesis overview.\nMore prose [1].",
) -> UUID:
    """Create an LI artifact head; when ``content_md`` is set, a promoted current revision.

    Resolver only reads the head id, the joined library name, and (LEFT JOIN) the
    current revision's content_md, so this raw insert is sufficient. ``content_md=None``
    leaves ``current_revision_id`` NULL (a head with no promoted revision).
    """
    from sqlalchemy import text as sql_text

    artifact_id = db.execute(
        sql_text(
            """
            INSERT INTO artifacts (subject_scheme, subject_id, kind, user_id)
            VALUES ('library', :library_id, 'library_dossier', :user_id)
            RETURNING id
            """
        ),
        {"library_id": library_id, "user_id": user_id},
    ).scalar_one()
    if content_md is not None:
        revision_id = db.execute(
            sql_text(
                """
                INSERT INTO artifact_revisions (
                    artifact_id, content_md, covered_targets, status, promoted_at
                )
                VALUES (:artifact_id, :content_md, '[]'::jsonb, 'ready', now())
                RETURNING id
                """
            ),
            {"artifact_id": artifact_id, "content_md": content_md},
        ).scalar_one()
        db.execute(
            sql_text("UPDATE artifacts SET current_revision_id = :rev WHERE id = :artifact_id"),
            {"rev": revision_id, "artifact_id": artifact_id},
        )
    db.commit()
    return UUID(str(artifact_id))


def _current_li_revision_id(db: Session, artifact_id: UUID) -> UUID:
    from sqlalchemy import text as sql_text

    revision_id = db.execute(
        sql_text("SELECT current_revision_id FROM artifacts WHERE id = :id"),
        {"id": artifact_id},
    ).scalar_one()
    assert revision_id is not None
    return UUID(str(revision_id))


def _make_pdf(db: Session, library_id: UUID, *, pages: list[str], title: str = "Test PDF") -> UUID:
    """Create a PDF media with plain_text + page spans (offsets into plain_text)."""
    plain_text = ""
    spans: list[tuple[int, int, int]] = []
    for page_number, page in enumerate(pages, start=1):
        start = len(plain_text)
        plain_text += page
        spans.append((page_number, start, len(plain_text)))
    media = Media(
        id=uuid4(),
        kind=MediaKind.pdf.value,
        title=title,
        processing_status=ProcessingStatus.ready_for_reading,
        plain_text=plain_text,
        page_count=len(pages),
    )
    db.add(media)
    db.flush()
    for page_number, start, end in spans:
        db.add(
            PdfPageTextSpan(
                media_id=media.id,
                page_number=page_number,
                start_offset=start,
                end_offset=end,
            )
        )
    add_media_to_library(db, library_id, media.id)
    db.commit()
    return media.id


def _make_oracle_reading(
    db: Session,
    user_id: UUID,
    *,
    question: str = "Where does the path open?",
    motto: str = "Audentes Fortuna Iuvat",
    argument: str = "Of the lamp kept burning through the closed forest.",
    interpretation: str = "I saw a road bending into shadow.",
) -> UUID:
    """Create one completed oracle reading.

    The cutover loader reads question/motto/argument/interpretation_text from the
    reading row and gates on ``user_id == viewer_id``; the per-phase passages now
    live on the reading's citation edges (``oracle_reading_folios``), not in the
    readable body, so this raw reading insert is sufficient.
    """
    from sqlalchemy import text as sql_text

    reading_id = db.execute(
        sql_text(
            """
            INSERT INTO oracle_readings (
                user_id, folio_number, folio_motto, argument_text, question_text,
                status, interpretation_text, completed_at
            )
            VALUES (
                :user_id, 1, :motto, :argument, :question, 'complete', :interpretation, now()
            )
            RETURNING id
            """
        ),
        {
            "user_id": user_id,
            "motto": motto,
            "argument": argument,
            "question": question,
            "interpretation": interpretation,
        },
    ).scalar_one()
    db.commit()
    return UUID(str(reading_id))


def _seed_resolved_oracle_anchor(
    db: Session,
    viewer_id: UUID,
    *,
    quote: str = "The universe is change; our life is what our thoughts make it.",
    title: str = "The Work",
    author_text: str = "A. Author",
    display_label: str = "Work I",
) -> UUID:
    """Seed one corpus source + passage anchor over real indexed media, resolved.

    Mirrors ``test_oracle.py``'s ``_seed_corpus_work``: builds a ready web-article
    media whose content chunk contains the anchor's selector quote verbatim, maps it
    via ``oracle_corpus_sources``, then resolves the anchor so its current evidence
    span / content chunk pointers are set. Returns the anchor id.
    """
    library_id = create_test_library(db, viewer_id, "Oracle Corpus Library")
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=viewer_id,
    )
    db.add(media)
    db.flush()
    fragment = Fragment(
        id=uuid4(),
        media_id=media.id,
        idx=0,
        html_sanitized=f"<p>{quote}</p>",
        canonical_text=quote,
    )
    db.add(fragment)
    db.flush()
    insert_fragment_blocks(db, fragment.id, parse_fragment_blocks(fragment.canonical_text))
    rebuild_fragment_content_index(
        db,
        media_id=media.id,
        source_kind="web_article",
        fragments=[fragment],
        reason="resolve_test",
    )
    add_media_to_library(db, library_id, media.id)
    source = OracleCorpusSource(
        corpus_key="oracle",
        work_key=f"w-{uuid4().hex[:8]}",
        library_id=library_id,
        media_id=media.id,
        title=title,
        author_text=author_text,
        source_repository="test",
        source_url=f"https://ex/{uuid4().hex[:8]}",
        source_download_url=f"https://ex/{uuid4().hex[:8]}.epub",
        source_media_kind="epub",
        display_order=10,
    )
    db.add(source)
    db.flush()
    anchor = OraclePassageAnchor(
        corpus_source_id=source.id,
        passage_key=f"w0-a0-{uuid4().hex[:8]}",
        display_label=display_label,
        selector={"kind": "text_quote", "exact": quote},
        tags=[],
        phase_hints=[],
    )
    db.add(anchor)
    db.flush()
    resolution = oracle_corpus.resolve_oracle_passage_anchors(db)
    assert resolution.failed == 0, f"anchor failed to resolve: {resolution}"
    db.commit()
    db.refresh(anchor)
    assert anchor.resolution_status == "resolved"
    assert (
        anchor.current_evidence_span_id is not None or anchor.current_content_chunk_id is not None
    ), "a resolved anchor must point at a current evidence span or content chunk"
    return anchor.id


# =============================================================================
# Tests
# =============================================================================


def test_resolve_media_returns_label_summary_and_pointer_only_body(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = _make_pdf(
        db_session,
        library_id,
        pages=["first page words. ", "second page text. "],
        title="Dune",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Frank Herbert", "role": "author"}],
        source="manual",
    )
    db_session.commit()

    resolved = _resolve(db_session, f"media:{media_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected resolved media to be visible, got {resolved}"
    assert resolved.uri == f"media:{media_id}", (
        f"Resolver should echo the input URI; got {resolved.uri}"
    )
    assert resolved.label == "Dune by Frank Herbert", (
        f"Expected media title + author in label; got {resolved.label}"
    )
    assert resolved.summary == "pdf · ~6 words · 2 pages", (
        f"Expected kind/word/page summary; got {resolved.summary}"
    )
    assert resolved.inline_body is None, (
        f"Media bodies are always pointer-only; got inline_body={resolved.inline_body!r}"
    )
    assert all(
        name in resolved.fetch_hint for name in ("inspect_resource", "read_resource", "app_search")
    ), (
        f"Media fetch_hint should direct the model to the map/read/search stack; got {resolved.fetch_hint}"
    )


def test_resolve_media_unknown_id_returns_missing(db_session: Session, bootstrapped_user: UUID):
    resolved = _resolve(db_session, f"media:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, (
        f"Unknown media URI must resolve as missing, got missing={resolved.missing}"
    )


def test_resolve_media_no_permission_returns_missing(db_session: Session, bootstrapped_user: UUID):
    """A media row not in any library the viewer can read is `missing` to them."""
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_library_id = create_test_library(db_session, other_user_id, "Other Library")
    private_media_id = create_test_media_in_library(
        db_session, other_user_id, other_library_id, title="Private Doc"
    )

    resolved = _resolve(db_session, f"media:{private_media_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, (
        f"Viewer without media permission must see missing=True; got {resolved}"
    )


def test_resolve_library_member_returns_summary_pointer(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = create_test_library(db_session, bootstrapped_user, "Reading List")

    resolved = _resolve(db_session, f"library:{library_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected member to resolve library, got missing={resolved}"
    assert resolved.label == "Reading List", (
        f"Library label should be the library name; got {resolved.label!r}"
    )
    assert resolved.inline_body is None, "Library bodies are pointer-only"
    assert "app_search" in resolved.fetch_hint, (
        f"Library fetch_hint should direct to app_search; got {resolved.fetch_hint}"
    )


def test_resolve_library_non_member_returns_missing(db_session: Session, bootstrapped_user: UUID):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_library_id = create_test_library(db_session, other_user_id, "Closed Library")

    resolved = _resolve(db_session, f"library:{other_library_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-member must see library as missing"


def test_resolve_li_artifact_promoted_inlines_current_revision(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = create_test_library(db_session, bootstrapped_user, "Synthesis Library")
    artifact_id = _make_li_artifact(
        db_session,
        library_id,
        bootstrapped_user,
        content_md="Overview line.\nThe library covers X and Y [1].",
    )

    resolved = _resolve(db_session, f"artifact:{artifact_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Member should resolve a promoted artifact; got {resolved}"
    assert resolved.label == "Library dossier — Synthesis Library", (
        f"Artifact label should name the library; got {resolved.label!r}"
    )
    assert resolved.summary == "Overview line.", (
        f"Summary should be the first prose line; got {resolved.summary!r}"
    )
    assert resolved.inline_body == "Overview line.\nThe library covers X and Y [1].", (
        f"Short current-revision content should inline; got {resolved.inline_body!r}"
    )
    assert f"library:{library_id}" in resolved.fetch_hint, (
        f"Fetch hint should point at the library scope; got {resolved.fetch_hint}"
    )
    assert "read_resource" in resolved.fetch_hint
    assert resolved.resolved_revision_ref == (
        f"artifact_revision:{_current_li_revision_id(db_session, artifact_id)}"
    )


def test_resolve_li_revision_inlines_exact_revision_after_head_moves(
    db_session: Session, bootstrapped_user: UUID
):
    from sqlalchemy import text as sql_text

    library_id = create_test_library(db_session, bootstrapped_user, "Pinned Synthesis")
    artifact_id = _make_li_artifact(
        db_session,
        library_id,
        bootstrapped_user,
        content_md="Pinned revision prose.",
    )
    pinned_revision_id = _current_li_revision_id(db_session, artifact_id)
    new_revision_id = db_session.execute(
        sql_text(
            """
            INSERT INTO artifact_revisions (
                artifact_id, content_md, covered_targets, status, promoted_at
            )
            VALUES (:artifact_id, 'New head prose.', '[]'::jsonb, 'ready', now())
            RETURNING id
            """
        ),
        {"artifact_id": artifact_id},
    ).scalar_one()
    db_session.execute(
        sql_text("UPDATE artifacts SET current_revision_id = :rev WHERE id = :artifact_id"),
        {"rev": new_revision_id, "artifact_id": artifact_id},
    )
    db_session.commit()

    resolved = _resolve(
        db_session,
        f"artifact_revision:{pinned_revision_id}",
        viewer_id=bootstrapped_user,
    )

    assert not resolved.missing
    assert resolved.label == "Library dossier revision — Pinned Synthesis (ready)"
    assert resolved.inline_body == "Pinned revision prose."
    assert resolved.resolved_revision_ref == f"artifact_revision:{pinned_revision_id}"


def test_resolve_li_artifact_long_body_not_inlined(db_session: Session, bootstrapped_user: UUID):
    library_id = create_test_library(db_session, bootstrapped_user, "Big Synthesis")
    long_content = "First line.\n" + ("x" * (INLINE_THRESHOLD_CHARS + 100))
    artifact_id = _make_li_artifact(
        db_session, library_id, bootstrapped_user, content_md=long_content
    )

    resolved = _resolve(db_session, f"artifact:{artifact_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing
    assert resolved.inline_body is None, (
        f"Content >= {INLINE_THRESHOLD_CHARS} chars must not inline; got len="
        f"{len(resolved.inline_body or '')}"
    )
    assert resolved.summary == "First line."


def test_resolve_li_artifact_no_current_revision_is_present_no_inline(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = create_test_library(db_session, bootstrapped_user, "Ungenerated Library")
    artifact_id = _make_li_artifact(db_session, library_id, bootstrapped_user, content_md=None)

    resolved = _resolve(db_session, f"artifact:{artifact_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, (
        f"A head with current_revision_id NULL must resolve non-missing; got {resolved}"
    )
    assert resolved.inline_body is None, "No current revision -> no inline body"
    assert resolved.label == "Library dossier — Ungenerated Library"


def test_resolve_li_artifact_non_member_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_library_id = create_test_library(db_session, other_user_id, "Closed Synthesis")
    artifact_id = _make_li_artifact(db_session, other_library_id, other_user_id)

    resolved = _resolve(db_session, f"artifact:{artifact_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-member must see the artifact as missing"


def test_resolve_li_artifact_unknown_id_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    resolved = _resolve(db_session, f"artifact:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, "Unknown artifact URI must resolve as missing"


def test_li_artifact_resources_block_reflects_current_revision(
    db_session: Session, bootstrapped_user: UUID
):
    """§6.6: the resource resolves to whatever revision is current at assembly time.

    Promoting a new revision changes the assembled <resource> block on the next
    assembly — without re-referencing (the head URI is stable; resolution is fresh).
    """
    from sqlalchemy import text as sql_text

    from nexus.services import context_assembler
    from tests.factories import add_context_edge

    library_id = create_test_library(db_session, bootstrapped_user, "Fresh-Resolve Library")
    artifact_id = _make_li_artifact(
        db_session, library_id, bootstrapped_user, content_md="First revision prose."
    )
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    add_context_edge(db_session, conversation_id, f"artifact:{artifact_id}")
    db_session.commit()

    first_revision_id = _current_li_revision_id(db_session, artifact_id)
    block, _meta, _citations, revision_refs = context_assembler._build_resources_block(
        db_session, conversation_id=conversation_id, viewer_id=bootstrapped_user
    )
    assert block is not None
    assert "First revision prose." in block.text, (
        f"Block should inline the current revision; got:\n{block.text}"
    )
    assert len(revision_refs) == 1
    assert revision_refs[0]["revision_uri"] == f"artifact_revision:{first_revision_id}"

    # Promote a new revision; the head URI is unchanged.
    new_revision_id = db_session.execute(
        sql_text(
            """
            INSERT INTO artifact_revisions (
                artifact_id, content_md, covered_targets, status, promoted_at
            )
            VALUES (:artifact_id, 'Second revision prose.', '[]'::jsonb, 'ready', now())
            RETURNING id
            """
        ),
        {"artifact_id": artifact_id},
    ).scalar_one()
    db_session.execute(
        sql_text("UPDATE artifacts SET current_revision_id = :rev WHERE id = :artifact_id"),
        {"rev": new_revision_id, "artifact_id": artifact_id},
    )
    db_session.commit()

    block2, _meta2, _citations2, revision_refs2 = context_assembler._build_resources_block(
        db_session, conversation_id=conversation_id, viewer_id=bootstrapped_user
    )
    assert block2 is not None
    assert "Second revision prose." in block2.text, (
        f"Next assembly must reflect the promoted revision; got:\n{block2.text}"
    )
    assert "First revision prose." not in block2.text
    assert len(revision_refs2) == 1
    assert revision_refs2[0]["revision_uri"] == f"artifact_revision:{new_revision_id}"


def test_li_artifact_not_a_citable_attached_resource(db_session: Session, bootstrapped_user: UUID):
    """The artifact carries inline content but is NON-citable: no [N] / no citation.

    Its inline [N] reference the revision's own citations rendered by the LI pane,
    not a get_search_result chip, so the attached-citation materializer skips it.
    """
    from nexus.services import context_assembler
    from tests.factories import add_context_edge

    library_id = create_test_library(db_session, bootstrapped_user, "Noncitable Library")
    artifact_id = _make_li_artifact(
        db_session, library_id, bootstrapped_user, content_md="Inline synthesis [1]."
    )
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    add_context_edge(db_session, conversation_id, f"artifact:{artifact_id}")
    db_session.commit()

    block, _meta, citations, _revision_refs = context_assembler._build_resources_block(
        db_session, conversation_id=conversation_id, viewer_id=bootstrapped_user
    )
    assert block is not None
    assert citations == (), "The artifact must not materialize an attached citation"
    assert ' n="' not in block.text, "A non-citable resource must not be numbered"


def test_li_artifact_in_context_stamps_resolved_revision(
    db_session: Session, bootstrapped_user: UUID
):
    """The prompt ledger records which concrete LI revision the head resolved to."""
    from nexus.services import context_assembler
    from tests.factories import add_context_edge

    library_id = create_test_library(db_session, bootstrapped_user, "Stamp-Slot Library")
    artifact_id = _make_li_artifact(
        db_session, library_id, bootstrapped_user, content_md="Synthesis prose [1]."
    )
    revision_id = _current_li_revision_id(db_session, artifact_id)
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    add_context_edge(db_session, conversation_id, f"artifact:{artifact_id}")
    db_session.commit()

    _block, _meta, _citations, revision_refs = context_assembler._build_resources_block(
        db_session, conversation_id=conversation_id, viewer_id=bootstrapped_user
    )
    assert len(revision_refs) == 1
    assert revision_refs[0]["type"] == "context_ref_resolved_revision"
    assert revision_refs[0]["resource_uri"] == f"artifact:{artifact_id}"
    assert revision_refs[0]["revision_uri"] == f"artifact_revision:{revision_id}"


def test_li_revision_context_stays_pinned_after_head_moves(
    db_session: Session, bootstrapped_user: UUID
):
    from sqlalchemy import text as sql_text

    from nexus.services import context_assembler
    from tests.factories import add_context_edge

    library_id = create_test_library(db_session, bootstrapped_user, "Pinned-Context Library")
    artifact_id = _make_li_artifact(
        db_session, library_id, bootstrapped_user, content_md="Pinned context prose."
    )
    pinned_revision_id = _current_li_revision_id(db_session, artifact_id)
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    add_context_edge(
        db_session,
        conversation_id,
        f"artifact_revision:{pinned_revision_id}",
    )

    new_revision_id = db_session.execute(
        sql_text(
            """
            INSERT INTO artifact_revisions (
                artifact_id, content_md, covered_targets, status, promoted_at
            )
            VALUES (:artifact_id, 'New context head.', '[]'::jsonb, 'ready', now())
            RETURNING id
            """
        ),
        {"artifact_id": artifact_id},
    ).scalar_one()
    db_session.execute(
        sql_text("UPDATE artifacts SET current_revision_id = :rev WHERE id = :artifact_id"),
        {"rev": new_revision_id, "artifact_id": artifact_id},
    )
    db_session.commit()

    block, _meta, _citations, revision_refs = context_assembler._build_resources_block(
        db_session, conversation_id=conversation_id, viewer_id=bootstrapped_user
    )

    assert block is not None
    assert "Pinned context prose." in block.text
    assert "New context head." not in block.text
    assert len(revision_refs) == 1
    assert revision_refs[0]["resource_uri"] == f"artifact_revision:{pinned_revision_id}"
    assert revision_refs[0]["revision_uri"] == f"artifact_revision:{pinned_revision_id}"


# =============================================================================
# oracle_reading scheme
# =============================================================================


def test_resolve_oracle_reading_unknown_id_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    resolved = _resolve(db_session, f"oracle_reading:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, "unknown reading URI must resolve as missing"


def test_resolve_span_inlines_body_under_threshold(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Span Source"
    )
    span_id = _make_span(db_session, media_id, text="A short inline span.")

    resolved = _resolve(db_session, f"evidence_span:{span_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected span visibility, got {resolved}"
    assert resolved.inline_body == "A short inline span.", (
        f"Span body shorter than {INLINE_THRESHOLD_CHARS} chars should be inlined; "
        f"got inline_body={resolved.inline_body!r}"
    )
    assert "Span Source" in resolved.label, (
        f"Span label should include source media title; got {resolved.label}"
    )


def test_resolve_span_unknown_returns_missing(db_session: Session, bootstrapped_user: UUID):
    resolved = _resolve(db_session, f"evidence_span:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, "Unknown span URI must resolve as missing"


def test_resolve_highlight_returns_enriched_quote(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Highlight Source"
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Ada Lovelace", "role": "author"}],
        source="manual",
    )
    exact = "first quote line\nsecond quote line"
    highlight_id = _make_highlight_with_anchor(
        db_session,
        bootstrapped_user,
        media_id,
        exact=exact,
        prefix="before ",
        suffix=" after",
    )

    resolved = _resolve(db_session, f"highlight:{highlight_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected highlight visibility, got {resolved}"
    assert resolved.quote is not None, "Highlights resolve as an enriched <quote>, not bare text"
    assert resolved.quote.exact == exact
    assert resolved.quote.prefix == "before " and resolved.quote.suffix == " after"
    assert resolved.quote.source_label == "“Highlight Source” by Ada Lovelace", (
        f"Quote source should name the parent media; got {resolved.quote.source_label!r}"
    )
    assert resolved.inline_body is None, "Highlight quote replaces the inline <body>"
    assert resolved.summary == exact
    assert "Highlight Source" in resolved.label


def test_resolve_highlight_includes_linked_note(db_session: Session, bootstrapped_user: UUID):
    from nexus.services.notes import set_highlight_note_body_pm_json

    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Noted Source"
    )
    _make_span(db_session, media_id, text="Background span text for highlight.")
    highlight_id = _make_highlight_with_anchor(db_session, bootstrapped_user, media_id)
    set_highlight_note_body_pm_json(
        db_session,
        bootstrapped_user,
        highlight_id=highlight_id,
        block_id=uuid4(),
        body_pm_json={
            "type": "paragraph",
            "content": [{"type": "text", "text": "my annotation"}],
        },
        client_mutation_id=f"highlight-note-resolve-{uuid4()}",
    )

    resolved = _resolve(db_session, f"highlight:{highlight_id}", viewer_id=bootstrapped_user)

    assert resolved.quote is not None
    assert resolved.quote.note == "my annotation", (
        f"Linked note should reach the quote; got note={resolved.quote.note!r}"
    )


def test_resolve_page_owner_inlines_title(db_session: Session, bootstrapped_user: UUID):
    page_id = _make_page(db_session, bootstrapped_user, title="Page title body")
    resolved = _resolve(db_session, f"page:{page_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner-resolved page should be visible; got {resolved}"
    assert resolved.label == "Page title body", (
        f"Page label should be the title; got {resolved.label}"
    )
    assert resolved.inline_body == "Page title body", (
        f"Page prompt body is title-only; got {resolved.inline_body!r}"
    )


def test_resolve_page_non_owner_returns_missing(db_session: Session, bootstrapped_user: UUID):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    page_id = _make_page(db_session, other_user_id, title="Private page")

    resolved = _resolve(db_session, f"page:{page_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-owner viewer must see page as missing"


def test_resolve_note_block_owner_inlines_body(db_session: Session, bootstrapped_user: UUID):
    block_id = _make_note_block(db_session, bootstrapped_user, body="Note block body.")

    resolved = _resolve(db_session, f"note_block:{block_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve note_block; got {resolved}"
    assert resolved.inline_body == "Note block body.", (
        f"Note blocks always inline; got inline_body={resolved.inline_body!r}"
    )


def test_resolve_note_block_non_owner_returns_missing(db_session: Session, bootstrapped_user: UUID):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    block_id = _make_note_block(db_session, other_user_id, body="Private note.")

    resolved = _resolve(db_session, f"note_block:{block_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-owner must see note_block as missing"


def test_resolve_conversation_owner_returns_summary_no_inline(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    create_test_message(db_session, conversation_id, seq=1, content="Hello")

    resolved = _resolve(db_session, f"conversation:{conversation_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve conversation; got {resolved}"
    assert resolved.inline_body is None, (
        "Conversation bodies are pointer-only (no transcript inline)"
    )
    assert "messages" in resolved.summary, (
        f"Conversation summary should mention message_count; got {resolved.summary!r}"
    )


def test_resolve_conversation_non_owner_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    conversation_id = create_test_conversation(db_session, other_user_id)

    resolved = _resolve(db_session, f"conversation:{conversation_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-owner viewer must see conversation as missing"


def test_resolve_message_visible_inlines_short_body(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        content="A short user message.",
    )
    msg = db_session.get(Message, message_id)
    assert msg is not None

    resolved = _resolve(db_session, f"message:{message_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve message; got {resolved}"
    assert resolved.inline_body == "A short user message.", (
        f"Short messages should inline; got {resolved.inline_body!r}"
    )


def test_resolve_oracle_reading_owner_returns_question_label(
    db_session: Session, bootstrapped_user: UUID
):
    reading = OracleReading(
        id=uuid4(),
        user_id=bootstrapped_user,
        folio_number=1,
        question_text="What endures of all this?",
    )
    db_session.add(reading)
    db_session.commit()

    resolved = _resolve(db_session, f"oracle_reading:{reading.id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve their reading; got {resolved}"
    assert "What endures of all this?" in resolved.label, (
        f"Reading label should carry the question; got {resolved.label!r}"
    )
    assert resolved.inline_body is None, "Readings are pointer-only"


def test_resolve_oracle_reading_non_owner_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    reading = OracleReading(
        id=uuid4(), user_id=other_user_id, folio_number=1, question_text="Private question?"
    )
    db_session.add(reading)
    db_session.commit()

    resolved = _resolve(db_session, f"oracle_reading:{reading.id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-owner must see the oracle reading as missing"


def test_resolve_oracle_passage_anchor_is_global(db_session: Session, bootstrapped_user: UUID):
    """A resolved anchor is global: it resolves to the source title, its display
    label as locator, and the current media-evidence span text as a non-empty body."""
    quote = "The universe is change; our life is what our thoughts make it."
    anchor_id = _seed_resolved_oracle_anchor(
        db_session,
        bootstrapped_user,
        quote=quote,
        title="Meditations",
        author_text="Marcus Aurelius",
        display_label="Book IV, 3",
    )

    resolved = _resolve(
        db_session, f"oracle_passage_anchor:{anchor_id}", viewer_id=bootstrapped_user
    )

    assert not resolved.missing, f"Passage anchors are global; got {resolved}"
    assert resolved.label == "Meditations — Book IV, 3", (
        f"Anchor label should be source title + display label; got {resolved.label!r}"
    )
    assert quote in (resolved.summary or ""), (
        f"Resolved anchor body/summary should carry the current span text; got {resolved.summary!r}"
    )

    # A resolved anchor routes into its corpus media's reader through the current pointer.
    href = route_for_ref(
        db_session,
        viewer_id=bootstrapped_user,
        ref=ResourceRef(scheme="oracle_passage_anchor", id=anchor_id),
    )
    assert href is not None and href.startswith("/media/"), (
        f"a resolved anchor must route to the media reader; got {href!r}"
    )


def test_resolve_oracle_passage_anchor_unknown_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    resolved = _resolve(db_session, f"oracle_passage_anchor:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, "Unknown passage anchor must resolve as missing"


def test_resolve_oracle_passage_anchor_unresolved_fails_closed(
    db_session: Session, bootstrapped_user: UUID
):
    anchor_id = _seed_resolved_oracle_anchor(db_session, bootstrapped_user)
    db_session.execute(
        text(
            """
            UPDATE oracle_passage_anchors
            SET resolution_status = 'pending',
                current_evidence_span_id = NULL,
                current_content_chunk_id = NULL,
                resolved_at = NULL
            WHERE id = :anchor_id
            """
        ),
        {"anchor_id": anchor_id},
    )
    db_session.commit()

    resolved = _resolve(
        db_session, f"oracle_passage_anchor:{anchor_id}", viewer_id=bootstrapped_user
    )
    href = route_for_ref(
        db_session,
        viewer_id=bootstrapped_user,
        ref=ResourceRef(scheme="oracle_passage_anchor", id=anchor_id),
    )

    assert resolved.missing, "Unresolved passage anchors must not hydrate with an empty body"
    assert href is None, "Unresolved passage anchors must not route into the reader"


def test_resolve_external_snapshot_owner_returns_title_and_snippet(
    db_session: Session, bootstrapped_user: UUID
):
    snapshot = ResourceExternalSnapshot(
        id=uuid4(),
        user_id=bootstrapped_user,
        provider="brave",
        url="https://example.org/article",
        title="An External Article",
        snippet="The first sentence of the result.",
        source_snapshot={},
    )
    db_session.add(snapshot)
    db_session.commit()

    resolved = _resolve(db_session, f"external_snapshot:{snapshot.id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve their snapshot; got {resolved}"
    assert resolved.label == "An External Article"
    assert resolved.summary == "The first sentence of the result."


def test_resolve_external_snapshot_non_owner_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    snapshot = ResourceExternalSnapshot(
        id=uuid4(),
        user_id=other_user_id,
        provider="brave",
        url="https://example.org/private",
        title="Private Snapshot",
        snippet="Hidden.",
        source_snapshot={},
    )
    db_session.add(snapshot)
    db_session.commit()

    resolved = _resolve(db_session, f"external_snapshot:{snapshot.id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Another user's snapshot must resolve as missing"


def test_resolve_contributor_returns_display_name(db_session: Session, bootstrapped_user: UUID):
    contributor = Contributor(
        id=uuid4(),
        handle=f"ada-lovelace-{uuid4().hex[:8]}",
        display_name="Ada Lovelace",
        sort_name="Lovelace, Ada",
    )
    db_session.add(contributor)
    db_session.commit()

    resolved = _resolve(db_session, f"contributor:{contributor.id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Contributors are global identity rows; got {resolved}"
    assert resolved.label == "Ada Lovelace"


def test_resolve_contributor_unknown_returns_missing(db_session: Session, bootstrapped_user: UUID):
    resolved = _resolve(db_session, f"contributor:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, "Unknown contributor must resolve as missing"


def test_resolve_podcast_subscribed_returns_title(db_session: Session, bootstrapped_user: UUID):
    podcast = Podcast(
        id=uuid4(),
        provider="podcastindex",
        provider_podcast_id=uuid4().hex,
        title="A Subscribed Show",
        feed_url=f"https://example.org/feed-{uuid4().hex[:8]}.xml",
        description="Weekly episodes about things.",
    )
    db_session.add(podcast)
    db_session.flush()
    db_session.add(
        PodcastSubscription(user_id=bootstrapped_user, podcast_id=podcast.id, status="active")
    )
    db_session.commit()

    resolved = _resolve(db_session, f"podcast:{podcast.id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Subscriber should resolve the podcast; got {resolved}"
    assert resolved.label == "A Subscribed Show"
    assert resolved.summary == "Weekly episodes about things."


def test_resolve_podcast_not_visible_returns_missing(db_session: Session, bootstrapped_user: UUID):
    podcast = Podcast(
        id=uuid4(),
        provider="podcastindex",
        provider_podcast_id=uuid4().hex,
        title="An Unrelated Show",
        feed_url=f"https://example.org/feed-{uuid4().hex[:8]}.xml",
    )
    db_session.add(podcast)
    db_session.commit()

    resolved = _resolve(db_session, f"podcast:{podcast.id}", viewer_id=bootstrapped_user)

    assert resolved.missing, (
        "A podcast with no subscription or library entry must resolve as missing"
    )


def test_resolve_batch_groups_by_scheme(db_session: Session, bootstrapped_user: UUID):
    """Batch resolution returns one entry per input URI, preserving input order."""
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Batch Source"
    )
    page_id = _make_page(db_session, bootstrapped_user, title="Batch page")

    uris = [
        f"media:{media_id}",
        f"page:{page_id}",
        f"media:{uuid4()}",  # missing
    ]
    results = _resolve_batch(db_session, uris, viewer_id=bootstrapped_user)

    assert [r.uri for r in results] == uris, (
        f"resolve_batch must preserve input order; got {[r.uri for r in results]}"
    )
    assert results[0].missing is False
    assert results[1].missing is False
    assert results[2].missing is True
