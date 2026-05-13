"""Unit tests for PDF quote helper branches in context_rendering."""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from nexus.db.models import (
    ContentChunk,
    Contributor,
    Conversation,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    HighlightPdfAnchor,
    Media,
    Message,
    NoteBlock,
    Page,
    Podcast,
)
from nexus.errors import ApiErrorCode
from nexus.schemas.conversation import MessageContextRef, ReaderSelectionContext
from nexus.schemas.notes import ObjectRef
from nexus.services import context_rendering, object_refs
from nexus.services.pdf_quote_match import (
    MatcherAnomaly,
    MatcherAnomalyKind,
    MatchResult,
    MatchStatus,
)
from nexus.services.pdf_quote_match_policy import (
    CoherenceAnomalyKind,
    CoherenceFallbackAction,
    PdfQuoteMatchInternalError,
)
from nexus.services.quote_context_errors import QuoteContextBlockingError

pytestmark = pytest.mark.unit


def _make_media(plain_text: str) -> Media:
    return Media(id=uuid4(), kind="pdf", title="Test PDF", plain_text=plain_text)


def _make_highlight(exact: str) -> Highlight:
    return Highlight(
        id=uuid4(),
        user_id=uuid4(),
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )


def _make_fragment_highlight(exact: str = "quoted-text") -> tuple[Highlight, Fragment, Media]:
    media = Media(
        id=uuid4(),
        kind="web_article",
        title="Test Article",
        canonical_source_url="https://example.com",
    )
    fragment = Fragment(
        id=uuid4(),
        media_id=media.id,
        idx=0,
        canonical_text=f"prefix {exact} suffix",
        media=media,
    )
    highlight = Highlight(
        id=uuid4(),
        user_id=uuid4(),
        anchor_kind="fragment_offsets",
        anchor_media_id=media.id,
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )
    highlight.fragment_anchor = HighlightFragmentAnchor(
        highlight_id=highlight.id,
        fragment_id=fragment.id,
        start_offset=7,
        end_offset=7 + len(exact),
        fragment=fragment,
    )
    return highlight, fragment, media


def _make_pdf_anchor(
    *,
    media_id,
    status: str,
    match_version: int | None,
    start_offset: int | None,
    end_offset: int | None,
    page_number: int = 1,
) -> HighlightPdfAnchor:
    return HighlightPdfAnchor(
        highlight_id=uuid4(),
        media_id=media_id,
        page_number=page_number,
        geometry_version=1,
        geometry_fingerprint="fp",
        sort_top=Decimal("0"),
        sort_left=Decimal("0"),
        plain_text_match_status=status,
        plain_text_match_version=match_version,
        plain_text_start_offset=start_offset,
        plain_text_end_offset=end_offset,
        rect_count=1,
    )


class TestValidateUniquePdfOffsets:
    def test_returns_offsets_for_coherent_metadata(self):
        plain_text = "prefix quoted-text suffix"
        highlight = _make_highlight("quoted-text")
        media = _make_media(plain_text)
        start = plain_text.index(highlight.exact)
        end = start + len(highlight.exact)
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=1,
            start_offset=start,
            end_offset=end,
        )

        with patch(
            "nexus.services.context_rendering._load_pdf_page_span",
            return_value=SimpleNamespace(start_offset=0, end_offset=len(plain_text)),
        ):
            offsets = context_rendering._validate_unique_pdf_offsets(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert offsets == (start, end)

    def test_unsupported_match_version_routes_through_coherence_policy(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=2,
            start_offset=7,
            end_offset=18,
        )

        with patch(
            "nexus.services.context_rendering.handle_recoverable_coherence_anomaly",
            return_value=CoherenceFallbackAction.retry_as_pending,
        ) as mock_handle:
            offsets = context_rendering._validate_unique_pdf_offsets(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert offsets is None
        mock_handle.assert_called_once()
        assert mock_handle.call_args.args[0] == CoherenceAnomalyKind.unsupported_match_version


class TestTypedAnchorRendering:
    def test_render_fragment_highlight_context_uses_typed_anchor(self):
        highlight, fragment, media = _make_fragment_highlight()
        db = MagicMock()
        db.get.side_effect = [highlight, media]

        with patch(
            "nexus.services.context_rendering.get_context_window",
            return_value=SimpleNamespace(text=f"prefix {highlight.exact} suffix"),
        ):
            rendered = context_rendering._render_highlight_context(db, highlight.id)

        assert rendered is not None
        assert "<highlight>" in rendered
        assert "<quote>quoted-text</quote>" in rendered

    def test_render_note_block_context(self):
        page_id = uuid4()
        block = NoteBlock(
            id=uuid4(),
            user_id=uuid4(),
            page_id=page_id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="note",
            body_text="note",
            collapsed=False,
        )
        child = NoteBlock(
            id=uuid4(),
            user_id=block.user_id,
            page_id=page_id,
            parent_block_id=block.id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="child",
            body_text="child",
            collapsed=False,
        )
        db = MagicMock()
        db.get.return_value = block
        db.scalars.return_value = [block, child]

        rendered = context_rendering._render_note_context(db, "note_block", block.id)

        assert rendered is not None
        assert "<note_block>" in rendered
        assert "<content>- note\n  - child</content>" in rendered

    def test_render_page_context_preserves_outline_hierarchy(self):
        page_id = uuid4()
        user_id = uuid4()
        page = Page(id=page_id, user_id=user_id, title="Outline Page")
        parent = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="parent",
            body_text="parent",
            collapsed=False,
        )
        sibling = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            order_key="0000000002",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="sibling",
            body_text="sibling",
            collapsed=False,
        )
        child = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            parent_block_id=parent.id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="child",
            body_text="child",
            collapsed=False,
        )
        db = MagicMock()
        db.get.return_value = page
        db.scalars.return_value = [parent, sibling, child]

        rendered = context_rendering._render_note_context(db, "page", page_id)

        assert rendered is not None
        assert "<content>- parent\n  - child\n- sibling</content>" in rendered

    def test_object_ref_page_context_preserves_outline_hierarchy(self):
        page_id = uuid4()
        user_id = uuid4()
        page = Page(id=page_id, user_id=user_id, title="Lookup Page")
        parent = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            order_key="0000000001",
            block_kind="heading",
            body_pm_json={"type": "paragraph"},
            body_markdown="Section",
            body_text="Section",
            collapsed=False,
        )
        child = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            page_id=page_id,
            parent_block_id=parent.id,
            order_key="0000000001",
            block_kind="bullet",
            body_pm_json={"type": "paragraph"},
            body_markdown="child",
            body_text="child",
            collapsed=False,
        )
        db = MagicMock()
        db.get.return_value = page
        db.scalars.return_value = [parent, child]

        rendered = object_refs.render_object_context(
            db,
            user_id,
            ObjectRef(object_type="page", object_id=page_id),
        )

        assert '<context_lookup_result type="page">' in rendered
        assert "<content># Section\n  - child</content>" in rendered

    def test_render_context_blocks_handles_accepted_object_context_types(self):
        conversation = Conversation(
            id=uuid4(),
            owner_user_id=uuid4(),
            title="Research chat",
            sharing="private",
            scope_type="general",
        )
        message = Message(
            id=uuid4(),
            conversation_id=conversation.id,
            seq=3,
            role="user",
            content="Message body",
            status="complete",
        )
        message.conversation = conversation
        podcast = Podcast(
            id=uuid4(),
            provider="test",
            provider_podcast_id="podcast-1",
            title="Podcast title",
            feed_url="https://example.com/feed.xml",
        )
        contributor = Contributor(
            id=uuid4(),
            handle="writer-123",
            display_name="Writer Name",
            sort_name="Name, Writer",
            kind="person",
            status="verified",
        )
        media = Media(id=uuid4(), kind="web_article", title="Chunk source")
        chunk = ContentChunk(
            id=uuid4(),
            media_id=media.id,
            index_run_id=uuid4(),
            source_snapshot_id=uuid4(),
            chunk_idx=0,
            source_kind="web_article",
            chunk_text="Chunk body",
            chunk_sha256="a" * 64,
            chunker_version="test",
            token_count=2,
            heading_path=["Intro"],
            summary_locator={},
        )

        rows = {
            (Conversation, conversation.id): conversation,
            (Message, message.id): message,
            (Podcast, podcast.id): podcast,
            (Contributor, contributor.id): contributor,
            (ContentChunk, chunk.id): chunk,
            (Media, media.id): media,
        }
        db = MagicMock()
        db.get.side_effect = lambda model, row_id: rows.get((model, row_id))

        with patch(
            "nexus.services.context_rendering.load_contributor_credits_for_podcasts",
            return_value={podcast.id: []},
        ):
            rendered, total_chars = context_rendering.render_context_blocks(
                db,
                [
                    MessageContextRef(type="conversation", id=conversation.id),
                    MessageContextRef(type="message", id=message.id),
                    MessageContextRef(type="podcast", id=podcast.id),
                    MessageContextRef(type="content_chunk", id=chunk.id),
                    MessageContextRef(type="contributor", id=contributor.id),
                ],
            )

        assert total_chars > 0
        assert "<conversation>" in rendered
        assert "<message>" in rendered
        assert "<podcast>" in rendered
        assert "<content_chunk>" in rendered
        assert "<contributor>" in rendered

    def test_render_reader_selection_context_includes_quote_surrounding_and_locator(self):
        media_id = uuid4()
        rendered, total_chars = context_rendering.render_context_blocks(
            MagicMock(),
            [
                ReaderSelectionContext(
                    kind="reader_selection",
                    client_context_id=uuid4(),
                    media_id=media_id,
                    media_kind="web_article",
                    media_title="Reader Source",
                    exact="selected quote",
                    prefix="before ",
                    suffix=" after",
                    locator={
                        "kind": "fragment_offsets",
                        "fragment_id": str(uuid4()),
                        "start_offset": 7,
                        "end_offset": 21,
                    },
                )
            ],
        )

        assert total_chars > 0
        assert "<reader_selection>" in rendered
        assert "<source>Reader Source</source>" in rendered
        assert "<quote>selected quote</quote>" in rendered
        assert "<surrounding>before selected quote after</surrounding>" in rendered
        assert "<source_locator>" in rendered


class TestResolvePdfNearbyContext:
    def test_unique_status_uses_persisted_offsets_without_recompute(self):
        plain_text = "prefix quoted-text suffix"
        highlight = _make_highlight("quoted-text")
        media = _make_media(plain_text)
        start = plain_text.index(highlight.exact)
        end = start + len(highlight.exact)
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=1,
            start_offset=start,
            end_offset=end,
        )

        with (
            patch(
                "nexus.services.context_rendering._validate_unique_pdf_offsets",
                return_value=(start, end),
            ),
            patch("nexus.services.context_rendering.compute_match") as mock_compute,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is not None
        assert highlight.exact in context
        mock_compute.assert_not_called()

    def test_unknown_status_uses_coherence_mapping_and_omits_context(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status="legacy_status",
            match_version=1,
            start_offset=None,
            end_offset=None,
        )

        with (
            patch(
                "nexus.services.context_rendering.handle_recoverable_coherence_anomaly",
                return_value=CoherenceFallbackAction.omit_nearby_context,
            ) as mock_handle,
            patch("nexus.services.context_rendering.compute_match") as mock_compute,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is None
        mock_compute.assert_not_called()
        mock_handle.assert_called_once()
        assert mock_handle.call_args.args[0] == CoherenceAnomalyKind.unknown_match_status

    def test_unknown_status_retry_action_falls_through_to_pending_recompute(self):
        plain_text = "prefix quoted-text suffix"
        highlight = _make_highlight("quoted-text")
        media = _make_media(plain_text)
        start = plain_text.index(highlight.exact)
        end = start + len(highlight.exact)
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status="legacy_status",
            match_version=1,
            start_offset=None,
            end_offset=None,
        )

        with (
            patch(
                "nexus.services.context_rendering.handle_recoverable_coherence_anomaly",
                return_value=CoherenceFallbackAction.retry_as_pending,
            ),
            patch("nexus.services.context_rendering._load_pdf_page_span", return_value=None),
            patch(
                "nexus.services.context_rendering.compute_match",
                return_value=MatchResult(
                    status=MatchStatus.unique,
                    match_version=1,
                    start_offset=start,
                    end_offset=end,
                    prefix="",
                    suffix="",
                ),
            ) as mock_compute,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is not None
        assert highlight.exact in context
        mock_compute.assert_called_once()

    def test_pending_matcher_anomaly_degrades_without_blocking(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.pending.value,
            match_version=None,
            start_offset=None,
            end_offset=None,
        )
        anomaly = MatcherAnomaly(MatcherAnomalyKind.page_span_inconsistent, "bad span")

        with (
            patch("nexus.services.context_rendering._load_pdf_page_span", return_value=None),
            patch("nexus.services.context_rendering.compute_match", side_effect=anomaly),
            patch("nexus.services.context_rendering.handle_recoverable_anomaly") as mock_handle,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is None
        mock_handle.assert_called_once()

    def test_pending_unclassified_matcher_exception_blocks_with_internal_error(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.pending.value,
            match_version=None,
            start_offset=None,
            end_offset=None,
        )

        with (
            patch("nexus.services.context_rendering._load_pdf_page_span", return_value=None),
            patch(
                "nexus.services.context_rendering.compute_match", side_effect=RuntimeError("boom")
            ),
            patch(
                "nexus.services.context_rendering.handle_unclassified_exception",
                side_effect=PdfQuoteMatchInternalError("internal"),
            ) as mock_handle,
        ):
            with pytest.raises(QuoteContextBlockingError) as exc_info:
                context_rendering._resolve_pdf_nearby_context(
                    MagicMock(), highlight, media, pdf_anchor
                )

        assert exc_info.value.error_code == ApiErrorCode.E_INTERNAL
        mock_handle.assert_called_once()

    def test_unique_validator_exception_blocks_with_internal_error(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=1,
            start_offset=7,
            end_offset=18,
        )

        with (
            patch(
                "nexus.services.context_rendering._validate_unique_pdf_offsets",
                side_effect=RuntimeError("validator crashed"),
            ),
            patch(
                "nexus.services.context_rendering.handle_coherence_unclassified_exception",
                side_effect=PdfQuoteMatchInternalError("internal"),
            ) as mock_handle,
        ):
            with pytest.raises(QuoteContextBlockingError) as exc_info:
                context_rendering._resolve_pdf_nearby_context(
                    MagicMock(), highlight, media, pdf_anchor
                )

        assert exc_info.value.error_code == ApiErrorCode.E_INTERNAL
        mock_handle.assert_called_once()
