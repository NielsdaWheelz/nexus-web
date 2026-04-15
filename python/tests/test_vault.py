from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import (
    Annotation,
    DefaultLibraryIntrinsic,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    LibraryMedia,
    Media,
    MediaKind,
    Page,
    ProcessingStatus,
)
from nexus.services.vault import export_vault, sync_vault
from tests.factories import create_pdf_media_with_text, get_user_default_library

pytestmark = pytest.mark.integration


def test_vault_exports_and_syncs_existing_highlight_note_and_color(
    db_session: Session, bootstrapped_user: UUID, tmp_path
) -> None:
    media_id, fragment_id, highlight_id = _seed_article_highlight(db_session, bootstrapped_user)

    export_vault(db_session, bootstrapped_user, tmp_path)

    media_handle = f"med_{media_id.hex}"
    highlight_handle = f"hl_{highlight_id.hex}"
    assert (
        (tmp_path / "Sources" / media_handle / "article.md")
        .read_text(encoding="utf-8")
        .startswith("# Local Article")
    )

    highlight_path = tmp_path / "Highlights" / f"{highlight_handle}.md"
    text = highlight_path.read_text(encoding="utf-8")
    assert "Original note" in text
    text = text.replace('color: "yellow"', 'color: "green"')
    text = text.replace("Original note", "Edited note")
    highlight_path.write_text(text, encoding="utf-8")

    sync_vault(db_session, bootstrapped_user, tmp_path)

    db_session.expire_all()
    highlight = db_session.get(Highlight, highlight_id)
    assert highlight is not None
    assert highlight.color == "green"
    assert highlight.annotation is not None
    assert highlight.annotation.body == "Edited note"


def test_vault_creates_fragment_highlight_from_text_quote(
    db_session: Session, bootstrapped_user: UUID, tmp_path
) -> None:
    media_id, _fragment_id, _highlight_id = _seed_article_highlight(db_session, bootstrapped_user)
    export_vault(db_session, bootstrapped_user, tmp_path)

    (tmp_path / "Highlights" / "new-local.md").write_text(
        f"""---
nexus_type: "highlight"
media_handle: "med_{media_id.hex}"
selector_kind: "text_quote"
color: "blue"
deleted: false
exact: "second sentence"
prefix: "This is the "
suffix: " for local sync."
---
New note from Codex.
""",
        encoding="utf-8",
    )

    sync_vault(db_session, bootstrapped_user, tmp_path)

    created = (
        db_session.query(Highlight)
        .filter(Highlight.user_id == bootstrapped_user, Highlight.color == "blue")
        .one()
    )
    assert created.exact == "second sentence"
    assert created.annotation is not None
    assert created.annotation.body == "New note from Codex."
    assert (tmp_path / "Highlights" / f"hl_{created.id.hex}.md").exists()


def test_vault_creates_pdf_text_highlight(
    db_session: Session, bootstrapped_user: UUID, tmp_path
) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_pdf_media_with_text(
        db_session,
        bootstrapped_user,
        library_id,
        title="Local PDF",
        plain_text="Page one has a unique quote. Page two is different.",
        page_count=2,
        page_spans=[(0, 28), (28, 51)],
    )
    export_vault(db_session, bootstrapped_user, tmp_path)

    (tmp_path / "Highlights" / "new-pdf.md").write_text(
        f"""---
nexus_type: "highlight"
media_handle: "med_{media_id.hex}"
selector_kind: "pdf_text_quote"
page: 1
color: "purple"
deleted: false
exact: "unique quote"
---
PDF note.
""",
        encoding="utf-8",
    )

    sync_vault(db_session, bootstrapped_user, tmp_path)

    created = (
        db_session.query(Highlight)
        .filter(Highlight.user_id == bootstrapped_user, Highlight.color == "purple")
        .one()
    )
    assert created.anchor_kind == "pdf_text_quote"
    assert created.pdf_text_anchor is not None
    assert created.pdf_text_anchor.page_number == 1
    assert created.annotation is not None
    assert created.annotation.body == "PDF note."


def test_vault_creates_updates_and_deletes_pages(
    db_session: Session, bootstrapped_user: UUID, tmp_path
) -> None:
    (tmp_path / "Pages").mkdir()
    page_path = tmp_path / "Pages" / "scratch.md"
    page_path.write_text(
        """---
nexus_type: "page"
title: "Scratch"
deleted: false
---
First body.
""",
        encoding="utf-8",
    )

    sync_vault(db_session, bootstrapped_user, tmp_path)

    page = db_session.query(Page).filter(Page.user_id == bootstrapped_user).one()
    assert page.title == "Scratch"
    assert page.body.strip() == "First body."

    exported_path = next((tmp_path / "Pages").glob(f"*--page_{page.id.hex}.md"))
    exported = exported_path.read_text(encoding="utf-8")
    exported_path.write_text(
        exported.replace('title: "Scratch"', 'title: "Scratch Updated"').replace(
            "First body.", "Second body."
        ),
        encoding="utf-8",
    )
    sync_vault(db_session, bootstrapped_user, tmp_path)

    db_session.expire_all()
    page = db_session.get(Page, page.id)
    assert page is not None
    assert page.title == "Scratch Updated"
    assert page.body.strip() == "Second body."

    exported_path = next((tmp_path / "Pages").glob(f"*--page_{page.id.hex}.md"))
    exported_path.write_text(
        exported_path.read_text(encoding="utf-8").replace("deleted: false", "deleted: true"),
        encoding="utf-8",
    )
    sync_vault(db_session, bootstrapped_user, tmp_path)

    assert db_session.get(Page, page.id) is None


def _seed_article_highlight(
    session: Session,
    user_id: UUID,
) -> tuple[UUID, UUID, UUID]:
    library_id = get_user_default_library(session, user_id)
    assert library_id is not None

    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title="Local Article",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    session.add(media)
    session.flush()
    session.add(LibraryMedia(library_id=library_id, media_id=media.id))
    session.add(DefaultLibraryIntrinsic(default_library_id=library_id, media_id=media.id))

    canonical_text = "This is the first sentence. This is the second sentence for local sync."
    fragment = Fragment(
        id=uuid4(),
        media_id=media.id,
        idx=0,
        html_sanitized=f"<p>{canonical_text}</p>",
        canonical_text=canonical_text,
    )
    session.add(fragment)
    session.flush()

    start = canonical_text.index("first sentence")
    end = start + len("first sentence")
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        fragment_id=fragment.id,
        start_offset=start,
        end_offset=end,
        anchor_kind="fragment_offsets",
        anchor_media_id=media.id,
        color="yellow",
        exact="first sentence",
        prefix=canonical_text[:start],
        suffix=canonical_text[end:],
    )
    session.add(highlight)
    session.flush()
    session.add(
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment.id,
            start_offset=start,
            end_offset=end,
        )
    )
    session.add(Annotation(highlight_id=highlight.id, body="Original note"))
    session.commit()
    return media.id, fragment.id, highlight.id
