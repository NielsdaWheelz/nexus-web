from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from nexus.db.models import (
    Annotation,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Media,
    MediaKind,
    Page,
    ProcessingStatus,
)
from nexus.services.vault import export_vault, sync_vault
from tests.factories import (
    add_media_to_library,
    create_pdf_media_with_text,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_vault_api_exports_snapshot(
    auth_client: TestClient, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    bootstrap = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = UUID(bootstrap.json()["data"]["default_library_id"])
    with direct_db.session() as session:
        media_id, _fragment_id, highlight_id = _seed_article_highlight(session, user_id)
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    _register_seed_cleanup(direct_db, media_id, highlight_id)

    response = auth_client.get("/vault", headers=auth_headers(user_id))

    assert response.status_code == 200, response.json()
    data = response.json()["data"]
    paths = {file["path"] for file in data["files"]}
    assert "Library.md" in paths
    assert f"Sources/med_{media_id.hex}/article.md" in paths
    assert f"Highlights/hl_{highlight_id.hex}.md" in paths
    assert data["delete_paths"] == []
    assert data["conflicts"] == []


def test_vault_api_syncs_highlight_file(
    auth_client: TestClient, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    bootstrap = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = UUID(bootstrap.json()["data"]["default_library_id"])
    with direct_db.session() as session:
        media_id, _fragment_id, highlight_id = _seed_article_highlight(session, user_id)
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    _register_seed_cleanup(direct_db, media_id, highlight_id)

    snapshot = auth_client.get("/vault", headers=auth_headers(user_id)).json()["data"]
    highlight_path = f"Highlights/hl_{highlight_id.hex}.md"
    highlight_file = next(file for file in snapshot["files"] if file["path"] == highlight_path)
    edited = (
        highlight_file["content"]
        .replace('color: "yellow"', 'color: "green"')
        .replace("Original note", "Edited through API")
    )

    response = auth_client.post(
        "/vault",
        headers=auth_headers(user_id),
        json={"files": [{"path": highlight_path, "content": edited}]},
    )

    assert response.status_code == 200, response.json()
    data = response.json()["data"]
    assert data["delete_paths"] == [highlight_path]
    assert data["conflicts"] == []
    returned = next(file for file in data["files"] if file["path"] == highlight_path)
    assert 'color: "green"' in returned["content"]
    assert "Edited through API" in returned["content"]

    with direct_db.session() as session:
        highlight = session.get(Highlight, highlight_id)
        assert highlight is not None
        assert highlight.color == "green"
        assert highlight.annotation is not None
        assert highlight.annotation.body == "Edited through API"


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


class TestVaultApiRoutes:
    """Integration tests for GET /vault and POST /vault."""

    def test_get_and_post_vault_snapshot(self, auth_client, direct_db, test_user_id: UUID) -> None:
        bootstrap = auth_client.get("/me", headers=auth_headers(test_user_id))
        assert bootstrap.status_code == 200
        default_library_id = UUID(bootstrap.json()["data"]["default_library_id"])

        direct_db.register_cleanup("users", "id", test_user_id)
        direct_db.register_cleanup("libraries", "id", default_library_id)
        direct_db.register_cleanup("memberships", "library_id", default_library_id)
        direct_db.register_cleanup("pages", "user_id", test_user_id)

        empty = auth_client.get("/vault", headers=auth_headers(test_user_id))
        assert empty.status_code == 200
        empty_data = empty.json()["data"]
        assert empty_data["conflicts"] == []
        assert {file["path"] for file in empty_data["files"]} == {"Library.md"}

        post = auth_client.post(
            "/vault",
            headers=auth_headers(test_user_id),
            json={
                "files": [
                    {
                        "path": "Pages/vault-note.md",
                        "content": """---
nexus_type: "page"
title: "Vault Note"
deleted: false
---
Editable vault body.
""",
                    }
                ]
            },
        )
        assert post.status_code == 200
        post_data = post.json()["data"]
        assert post_data["conflicts"] == []
        page_file = next(file for file in post_data["files"] if file["path"].startswith("Pages/"))
        assert 'title: "Vault Note"' in page_file["content"]
        assert "Editable vault body." in page_file["content"]

        refreshed = auth_client.get("/vault", headers=auth_headers(test_user_id))
        assert refreshed.status_code == 200
        refreshed_data = refreshed.json()["data"]
        refreshed_paths = {file["path"] for file in refreshed_data["files"]}
        assert "Library.md" in refreshed_paths
        assert any(path.startswith("Pages/") for path in refreshed_paths)


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
    add_media_to_library(session, library_id, media.id)

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


def _register_seed_cleanup(
    direct_db: DirectSessionManager,
    media_id: UUID,
    highlight_id: UUID,
) -> None:
    direct_db.register_cleanup("annotations", "highlight_id", highlight_id)
    direct_db.register_cleanup("highlight_fragment_anchors", "highlight_id", highlight_id)
    direct_db.register_cleanup("highlights", "id", highlight_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
