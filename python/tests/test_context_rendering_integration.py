"""Integration coverage for context rendering behavior."""

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentChunk,
    ContentIndexRun,
    Contributor,
    Conversation,
    Fragment,
    Highlight,
    HighlightPdfAnchor,
    HighlightPdfQuad,
    Message,
    Podcast,
    SourceSnapshot,
)
from nexus.schemas.conversation import MessageContextRef
from nexus.services.content_indexing import (
    rebuild_fragment_content_index,
    repair_ready_media_content_index_now,
)
from nexus.services.context_rendering import render_context_blocks
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.pdf_quote_match import MatchStatus
from tests.factories import (
    create_pdf_media_with_text,
    create_test_fragment,
    create_test_highlight,
    create_test_media,
    get_user_default_library,
)

pytestmark = pytest.mark.integration

_EXACT = "quoted-text"
_AMBIGUOUS_TEXT = f"alpha {_EXACT} beta {_EXACT} omega"
_AMBIGUOUS_SECOND_START = _AMBIGUOUS_TEXT.rindex(_EXACT)
_AMBIGUOUS_SECOND_END = _AMBIGUOUS_SECOND_START + len(_EXACT)
_OUTSIDE_PAGE_TEXT = f"intro {_EXACT} tail"
_OUTSIDE_PAGE_START = _OUTSIDE_PAGE_TEXT.index(_EXACT)
_OUTSIDE_PAGE_END = _OUTSIDE_PAGE_START + len(_EXACT)


def _active_media_source_version(db_session: Session, media_id: UUID) -> str:
    source_version = db_session.execute(
        text(
            """
            SELECT active_run.source_version
            FROM media_content_index_states mcis
            JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
            WHERE mcis.media_id = :media_id
              AND active_run.state = 'ready'
              AND active_run.deactivated_at IS NULL
              AND NULLIF(btrim(active_run.source_version), '') IS NOT NULL
            """
        ),
        {"media_id": media_id},
    ).scalar_one()
    assert isinstance(source_version, str)
    return source_version


def _index_fragment_media(db_session: Session, media_id: UUID, fragment_id: UUID) -> str:
    fragment = db_session.get(Fragment, fragment_id)
    assert fragment is not None
    insert_fragment_blocks(db_session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
    rebuild_fragment_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        artifact_ref=f"fragments:{fragment.id}",
        fragments=[fragment],
        reason="test_context_rendering",
    )
    source_version = _active_media_source_version(db_session, media_id)
    db_session.commit()
    return source_version


def _index_pdf_media(db_session: Session, media_id: UUID) -> str:
    index_result = repair_ready_media_content_index_now(
        db_session,
        media_id=media_id,
        reason="test_context_rendering",
    )
    assert index_result is not None
    source_version = _active_media_source_version(db_session, media_id)
    db_session.commit()
    return source_version


def _highlight_context_ref(highlight_id: UUID, source_version: str) -> MessageContextRef:
    return MessageContextRef(
        kind="object_ref",
        type="highlight",
        id=highlight_id,
        source_version=source_version,
    )


def test_fragment_highlight_rendering_uses_typed_anchor_context(
    db_session: Session,
    bootstrapped_user: UUID,
):
    canonical_text = f"{_EXACT} with nearby context"
    media_id = create_test_media(db_session, title="Fragment Context Source")
    fragment_id = create_test_fragment(db_session, media_id, canonical_text)
    source_version = _index_fragment_media(db_session, media_id, fragment_id)
    highlight_id = create_test_highlight(
        db_session,
        bootstrapped_user,
        fragment_id,
        exact=_EXACT,
    )

    rendered, total_chars = render_context_blocks(
        db_session,
        [_highlight_context_ref(highlight_id, source_version)],
    )

    assert total_chars > 0
    assert "<highlight>" in rendered
    assert "<source>Fragment Context Source</source>" in rendered
    assert f"<quote>{_EXACT}</quote>" in rendered
    assert f"<surrounding>{canonical_text}</surrounding>" in rendered
    assert '"type":"web_text_offsets"' in rendered
    assert f'"fragment_id":"{fragment_id}"' in rendered
    assert f"<source_version>{source_version}</source_version>" in rendered


def test_fragment_highlight_rendering_uses_context_source_version(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_test_media(db_session, title="Captured Source Version Article")
    fragment_id = create_test_fragment(db_session, media_id, f"{_EXACT} with stale-safe context")
    highlight_id = create_test_highlight(
        db_session,
        bootstrapped_user,
        fragment_id,
        exact=_EXACT,
    )

    rendered, total_chars = render_context_blocks(
        db_session,
        [
            MessageContextRef(
                kind="object_ref",
                type="highlight",
                id=highlight_id,
                source_version="captured-source:v1",
            )
        ],
    )

    assert total_chars > 0
    assert "<source_version>captured-source:v1</source_version>" in rendered


def test_fragment_highlight_without_source_version_is_not_rendered(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_test_media(db_session, title="Indexed Fragment Context Source")
    fragment_id = create_test_fragment(db_session, media_id, f"{_EXACT} without source version")
    _index_fragment_media(db_session, media_id, fragment_id)
    highlight_id = create_test_highlight(
        db_session,
        bootstrapped_user,
        fragment_id,
        exact=_EXACT,
    )

    rendered, total_chars = render_context_blocks(
        db_session,
        [MessageContextRef(kind="object_ref", type="highlight", id=highlight_id)],
    )

    assert rendered == ""
    assert total_chars == 0


def test_object_context_rendering_supports_core_context_types(
    db_session: Session,
    bootstrapped_user: UUID,
):
    conversation = Conversation(
        id=uuid4(),
        owner_user_id=bootstrapped_user,
        title="Research chat",
        sharing="private",
    )
    podcast = Podcast(
        id=uuid4(),
        provider="test",
        provider_podcast_id=f"podcast-{uuid4()}",
        title="Podcast title",
        feed_url=f"https://example.com/{uuid4()}.xml",
    )
    contributor = Contributor(
        id=uuid4(),
        handle=f"writer-{uuid4()}",
        display_name="Writer Name",
        sort_name="Name, Writer",
        kind="person",
        status="verified",
    )
    media_id = create_test_media(db_session, title="Chunk source")
    db_session.add_all([conversation, podcast, contributor])
    db_session.flush()

    message = Message(
        id=uuid4(),
        conversation_id=conversation.id,
        seq=3,
        role="user",
        content="Message body",
        status="complete",
    )
    index_run = ContentIndexRun(
        id=uuid4(),
        media_id=media_id,
        state="ready",
        source_version="content-index:v1",
        extractor_version="test",
        chunker_version="test",
        embedding_provider="test",
        embedding_model="test",
        embedding_version="test",
        embedding_config_hash="test",
        started_at=datetime.now(UTC),
        activated_at=datetime.now(UTC),
    )
    db_session.add_all([message, index_run])
    db_session.flush()

    source_snapshot = SourceSnapshot(
        id=uuid4(),
        media_id=media_id,
        index_run_id=index_run.id,
        source_kind="web_article",
        artifact_kind="fragment",
        artifact_ref="fragment:test",
        content_type="text/plain",
        byte_length=10,
        source_fingerprint="fingerprint",
        source_version="content-index:v1",
        extractor_version="test",
        content_sha256="b" * 64,
        snapshot_metadata={},
    )
    db_session.add(source_snapshot)
    db_session.flush()

    chunk = ContentChunk(
        id=uuid4(),
        media_id=media_id,
        index_run_id=index_run.id,
        source_snapshot_id=source_snapshot.id,
        chunk_idx=0,
        source_kind="web_article",
        chunk_text="Chunk body",
        chunk_sha256="a" * 64,
        chunker_version="test",
        token_count=2,
        heading_path=["Intro"],
        summary_locator={},
    )
    db_session.add(chunk)
    db_session.commit()

    rendered, total_chars = render_context_blocks(
        db_session,
        [
            MessageContextRef(type="conversation", id=conversation.id),
            MessageContextRef(type="message", id=message.id),
            MessageContextRef(type="podcast", id=podcast.id),
            MessageContextRef(type="content_chunk", id=chunk.id),
            MessageContextRef(type="contributor", id=contributor.id),
        ],
    )

    assert total_chars == sum(len(block) for block in rendered.split("\n\n"))
    assert "<title>Research chat</title>" in rendered
    assert "<content>Message body</content>" in rendered
    assert "<source>Podcast title</source>" in rendered
    assert "<source>Chunk source</source>" in rendered
    assert "<content>Chunk body</content>" in rendered
    assert "<display_name>Writer Name</display_name>" in rendered


def _create_pdf_highlight(
    db_session: Session,
    *,
    user_id: UUID,
    media_id: UUID,
    exact: str,
    prefix: str,
    suffix: str,
    match_status: MatchStatus,
    match_version: int | None,
    start_offset: int | None,
    end_offset: int | None,
) -> UUID:
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="pdf_page_geometry",
        anchor_media_id=media_id,
        color="yellow",
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )
    db_session.add(highlight)
    db_session.flush()

    db_session.add(
        HighlightPdfAnchor(
            highlight_id=highlight.id,
            media_id=media_id,
            page_number=1,
            geometry_version=1,
            geometry_fingerprint="test-fingerprint",
            sort_top=Decimal("0"),
            sort_left=Decimal("0"),
            plain_text_match_status=match_status.value,
            plain_text_match_version=match_version,
            plain_text_start_offset=start_offset,
            plain_text_end_offset=end_offset,
            rect_count=1,
        )
    )
    db_session.add(
        HighlightPdfQuad(
            highlight_id=highlight.id,
            quad_idx=0,
            x1=Decimal("10"),
            y1=Decimal("20"),
            x2=Decimal("30"),
            y2=Decimal("20"),
            x3=Decimal("30"),
            y3=Decimal("40"),
            x4=Decimal("10"),
            y4=Decimal("40"),
        )
    )
    db_session.flush()
    return highlight.id


def test_pdf_highlight_rendering_uses_persisted_unique_offsets_for_ambiguous_quote(
    db_session: Session,
    bootstrapped_user: UUID,
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_pdf_media_with_text(
        db_session,
        bootstrapped_user,
        library_id,
        plain_text=_AMBIGUOUS_TEXT,
        page_count=1,
        page_spans=[(0, len(_AMBIGUOUS_TEXT))],
    )
    source_version = _index_pdf_media(db_session, media_id)
    highlight_id = _create_pdf_highlight(
        db_session,
        user_id=bootstrapped_user,
        media_id=media_id,
        exact=_EXACT,
        prefix="beta ",
        suffix=" omega",
        match_status=MatchStatus.unique,
        match_version=1,
        start_offset=_AMBIGUOUS_SECOND_START,
        end_offset=_AMBIGUOUS_SECOND_END,
    )

    rendered, total_chars = render_context_blocks(
        db_session,
        [_highlight_context_ref(highlight_id, source_version)],
    )

    assert total_chars > 0
    assert "<highlight>" in rendered
    assert f"<quote>{_EXACT}</quote>" in rendered
    assert f"<surrounding>{_AMBIGUOUS_TEXT}</surrounding>" in rendered
    assert '"type":"pdf_page_geometry"' in rendered
    assert f"<source_version>{source_version}</source_version>" in rendered


def test_pdf_highlight_empty_exact_unique_metadata_renders_without_surrounding_context(
    db_session: Session,
    bootstrapped_user: UUID,
):
    plain_text = f"prefix {_EXACT} suffix"
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_pdf_media_with_text(
        db_session,
        bootstrapped_user,
        library_id,
        title="Empty Exact PDF",
        plain_text=plain_text,
        page_count=1,
        page_spans=[(0, len(plain_text))],
    )
    source_version = _index_pdf_media(db_session, media_id)
    highlight_id = _create_pdf_highlight(
        db_session,
        user_id=bootstrapped_user,
        media_id=media_id,
        exact="",
        prefix="",
        suffix="",
        match_status=MatchStatus.unique,
        match_version=1,
        start_offset=0,
        end_offset=1,
    )

    rendered, total_chars = render_context_blocks(
        db_session,
        [_highlight_context_ref(highlight_id, source_version)],
    )

    assert total_chars > 0
    assert "<highlight>" in rendered
    assert "<source>Empty Exact PDF</source>" in rendered
    assert "<quote></quote>" in rendered
    assert "<surrounding>" not in rendered
    assert '"type":"pdf_page_geometry"' in rendered
    assert f"<source_version>{source_version}</source_version>" in rendered


@pytest.mark.parametrize(
    (
        "case_name",
        "plain_text",
        "page_spans",
        "match_version",
        "start_offset",
        "end_offset",
    ),
    [
        pytest.param(
            "unsupported_match_version",
            _AMBIGUOUS_TEXT,
            [(0, len(_AMBIGUOUS_TEXT))],
            2,
            _AMBIGUOUS_SECOND_START,
            _AMBIGUOUS_SECOND_END,
            id="unsupported-match-version",
        ),
        pytest.param(
            "status_offsets_inconsistent",
            _AMBIGUOUS_TEXT,
            [(0, len(_AMBIGUOUS_TEXT))],
            1,
            None,
            None,
            id="status-offsets-inconsistent",
        ),
        pytest.param(
            "offsets_out_of_range",
            _AMBIGUOUS_TEXT,
            [(0, len(_AMBIGUOUS_TEXT))],
            1,
            len(_AMBIGUOUS_TEXT) + 1,
            len(_AMBIGUOUS_TEXT) + 2,
            id="offsets-out-of-range",
        ),
        pytest.param(
            "offsets_outside_page_span",
            _OUTSIDE_PAGE_TEXT,
            [(0, len("intro"))],
            1,
            _OUTSIDE_PAGE_START,
            _OUTSIDE_PAGE_END,
            id="offsets-outside-page-span",
        ),
        pytest.param(
            "offset_substring_mismatch_exact",
            _AMBIGUOUS_TEXT,
            [(0, len(_AMBIGUOUS_TEXT))],
            1,
            0,
            len("alpha"),
            id="offset-substring-mismatch-exact",
        ),
    ],
)
def test_pdf_highlight_incoherent_unique_metadata_renders_without_surrounding_context(
    db_session: Session,
    bootstrapped_user: UUID,
    case_name: str,
    plain_text: str,
    page_spans: list[tuple[int, int]],
    match_version: int,
    start_offset: int | None,
    end_offset: int | None,
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_pdf_media_with_text(
        db_session,
        bootstrapped_user,
        library_id,
        title=f"Incoherent {case_name} PDF",
        plain_text=plain_text,
        page_count=1,
        page_spans=page_spans,
    )
    source_version = _index_pdf_media(db_session, media_id)
    highlight_id = _create_pdf_highlight(
        db_session,
        user_id=bootstrapped_user,
        media_id=media_id,
        exact=_EXACT,
        prefix="",
        suffix="",
        match_status=MatchStatus.unique,
        match_version=match_version,
        start_offset=start_offset,
        end_offset=end_offset,
    )

    rendered, total_chars = render_context_blocks(
        db_session,
        [_highlight_context_ref(highlight_id, source_version)],
    )

    assert total_chars > 0
    assert "<highlight>" in rendered
    assert f"<source>Incoherent {case_name} PDF</source>" in rendered
    assert f"<quote>{_EXACT}</quote>" in rendered
    assert "<surrounding>" not in rendered
    assert '"type":"pdf_page_geometry"' in rendered
    assert f"<source_version>{source_version}</source_version>" in rendered


def test_pdf_highlight_pending_matcher_anomaly_renders_without_surrounding_context(
    db_session: Session,
    bootstrapped_user: UUID,
):
    plain_text = f"prefix {_EXACT} suffix"
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_pdf_media_with_text(
        db_session,
        bootstrapped_user,
        library_id,
        title="Broken Span PDF",
        plain_text=plain_text,
        page_count=1,
        page_spans=[(0, len(plain_text) + 1)],
    )
    source_version = "captured-pdf-source:v1"
    highlight_id = _create_pdf_highlight(
        db_session,
        user_id=bootstrapped_user,
        media_id=media_id,
        exact=_EXACT,
        prefix="prefix ",
        suffix=" suffix",
        match_status=MatchStatus.pending,
        match_version=None,
        start_offset=None,
        end_offset=None,
    )

    rendered, total_chars = render_context_blocks(
        db_session,
        [
            MessageContextRef(
                kind="object_ref",
                type="highlight",
                id=highlight_id,
                source_version=source_version,
            )
        ],
    )

    assert total_chars > 0
    assert "<highlight>" in rendered
    assert "<source>Broken Span PDF</source>" in rendered
    assert f"<quote>{_EXACT}</quote>" in rendered
    assert "<surrounding>" not in rendered
    assert '"type":"pdf_page_geometry"' in rendered
    assert f"<source_version>{source_version}</source_version>" in rendered
