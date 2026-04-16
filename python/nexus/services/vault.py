"""Local Markdown vault export and sync.

The vault is an editable projection. Media text and source files are rewritten
from the server; highlight/page Markdown bodies are the local editing surface.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from uuid import UUID

from sqlalchemy import delete, func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    Annotation,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    HighlightPdfTextAnchor,
    Media,
    Page,
    PdfPageTextSpan,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.highlights import (
    derive_exact_prefix_suffix,
    map_integrity_error,
    validate_offsets_or_400,
)
from nexus.services.pdf_quote_match import MatchStatus, compute_match
from nexus.services.search import visible_media_ids_cte_sql
from nexus.storage import get_file_extension, get_storage_client
from nexus.storage.client import StorageClientBase


def export_vault(
    db: Session,
    viewer_id: UUID,
    vault_dir: Path,
    *,
    storage_client: StorageClientBase | None = None,
) -> None:
    vault_dir.mkdir(parents=True, exist_ok=True)
    (vault_dir / "Media").mkdir(exist_ok=True)
    (vault_dir / "Sources").mkdir(exist_ok=True)
    (vault_dir / "Highlights").mkdir(exist_ok=True)
    (vault_dir / "Pages").mkdir(exist_ok=True)

    for file in export_vault_files(db, viewer_id):
        target = vault_dir / file["path"]
        if target.parent.name in {"Media", "Pages"}:
            match = re.search(r"--((?:med|page)_[0-9a-f]{32})\.md$", target.name)
            if match:
                _remove_old_handle_files(target.parent, target.name, match.group(1))
        _write_text(target, file["content"])

    if storage_client is not None:
        _write_source_files(db, viewer_id, vault_dir, storage_client)


def sync_vault(
    db: Session,
    viewer_id: UUID,
    vault_dir: Path,
    *,
    storage_client: StorageClientBase | None = None,
) -> None:
    (vault_dir / "Highlights").mkdir(parents=True, exist_ok=True)
    (vault_dir / "Pages").mkdir(parents=True, exist_ok=True)
    files: list[dict[str, str]] = []
    for directory_name in ("Highlights", "Pages"):
        for path in sorted((vault_dir / directory_name).glob("*.md")):
            if path.name.endswith(".conflict.md"):
                continue
            files.append(
                {
                    "path": path.relative_to(vault_dir).as_posix(),
                    "content": path.read_text(encoding="utf-8"),
                }
            )

    result = sync_vault_files(db, viewer_id, files)
    for delete_path in result["delete_paths"]:
        path = vault_dir / delete_path
        if path.exists():
            path.unlink()

    for file in result["files"]:
        target = vault_dir / file["path"]
        if target.parent.name in {"Media", "Pages"}:
            match = re.search(r"--((?:med|page)_[0-9a-f]{32})\.md$", target.name)
            if match:
                _remove_old_handle_files(target.parent, target.name, match.group(1))
        _write_text(target, file["content"])

    for conflict in result["conflicts"]:
        _write_text(vault_dir / conflict["path"], conflict["content"])

    if storage_client is not None:
        _write_source_files(db, viewer_id, vault_dir, storage_client)


def export_vault_files(db: Session, viewer_id: UUID) -> list[dict[str, str]]:
    files = _vault_file_map(db, viewer_id)
    return [{"path": path, "content": files[path]} for path in sorted(files)]


def sync_vault_files(
    db: Session,
    viewer_id: UUID,
    local_files: list[dict[str, str]],
) -> dict[str, list[dict[str, str]] | list[str]]:
    delete_paths: list[str] = []
    conflicts: list[dict[str, str]] = []

    for local_file in sorted(local_files, key=lambda item: str(item.get("path", ""))):
        path = _editable_vault_path(str(local_file.get("path", "")))
        content = str(local_file.get("content", ""))
        if len(content.encode("utf-8")) > 1_000_000:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Vault file is too large")

        metadata, body = _read_frontmatter(content)
        if path.startswith("Highlights/") and metadata.get("nexus_type") == "highlight":
            changed, conflict_reason = _sync_highlight_content(db, viewer_id, metadata, body)
        elif path.startswith("Pages/") and metadata.get("nexus_type") == "page":
            changed, conflict_reason = _sync_page_content(
                db, viewer_id, metadata, body, fallback_title=Path(path).stem
            )
        else:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Vault uploads must be highlight or page Markdown files",
            )

        if conflict_reason is not None:
            conflicts.append(
                {
                    "path": _conflict_path(path),
                    "message": conflict_reason,
                    "content": _conflict_markdown(content, conflict_reason),
                }
            )
        elif changed:
            delete_paths.append(path)

    return {
        "files": export_vault_files(db, viewer_id),
        "delete_paths": delete_paths,
        "conflicts": conflicts,
    }


def watch_vault(
    db: Session,
    viewer_id: UUID,
    vault_dir: Path,
    *,
    interval_seconds: float,
    storage_client: StorageClientBase | None = None,
) -> None:
    while True:
        sync_vault(db, viewer_id, vault_dir, storage_client=storage_client)
        time.sleep(interval_seconds)


def _vault_file_map(db: Session, viewer_id: UUID) -> dict[str, str]:
    files: dict[str, str] = {}

    media_rows = (
        db.execute(
            text(f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            )
            SELECT m.id, m.kind, m.title, m.canonical_source_url, m.processing_status,
                   m.file_sha256, m.plain_text, m.page_count, mf.storage_path, mf.content_type
            FROM media m
            JOIN visible_media vm ON vm.media_id = m.id
            LEFT JOIN media_file mf ON mf.media_id = m.id
            WHERE m.kind IN ('web_article', 'epub', 'pdf')
            ORDER BY lower(m.title), m.id
        """),
            {"viewer_id": viewer_id},
        )
        .mappings()
        .all()
    )

    library_lines = ["# Library", ""]
    highlight_rows = _load_vault_highlights(db, viewer_id)
    highlights_by_media: dict[UUID, list[Highlight]] = {}
    for highlight in highlight_rows:
        media_id = _highlight_media_id(highlight)
        if media_id is not None:
            highlights_by_media.setdefault(media_id, []).append(highlight)

    for row in media_rows:
        media_id = UUID(str(row["id"]))
        media_handle = _media_handle(media_id)
        media_title = str(row["title"])
        media_slug = _slug(media_title)
        media_path = f"Media/{media_slug}--{media_handle}.md"

        fragments = _load_fragments(db, media_id)
        if row["kind"] == "web_article":
            files[f"Sources/{media_handle}/article.md"] = _web_article_markdown(
                media_title, fragments
            )
            files[f"Sources/{media_handle}/article.html"] = _joined_fragment_html(fragments)
            files[f"Sources/{media_handle}/canonical.txt"] = _joined_fragment_text(fragments)
            source_link = f"../Sources/{media_handle}/article.md"
        elif row["kind"] == "epub":
            files[f"Sources/{media_handle}/text.md"] = _fragment_text_markdown(
                media_title, fragments
            )
            source_link = f"../Sources/{media_handle}/text.md"
        elif row["kind"] == "pdf":
            files[f"Sources/{media_handle}/text.md"] = _pdf_markdown(
                db, media_title, media_id, str(row["plain_text"] or "")
            )
            source_link = f"../Sources/{media_handle}/text.md"
        else:
            continue

        media_highlights = sorted(
            highlights_by_media.get(media_id, []),
            key=lambda h: (_highlight_sort_key(h), str(h.id)),
        )
        files[media_path] = _media_markdown(row, media_handle, source_link, media_highlights)
        library_lines.append(f"- [[Media/{media_path[6:-3]}]]")

    files["Library.md"] = "\n".join(library_lines).rstrip() + "\n"

    for highlight in highlight_rows:
        media_id = _highlight_media_id(highlight)
        if media_id is not None and can_read_media(db, viewer_id, media_id):
            path, content = _highlight_file(highlight)
            files[path] = content

    for page in (
        db.query(Page).filter(Page.user_id == viewer_id).order_by(Page.title.asc(), Page.id.asc())
    ):
        path, content = _page_file(page)
        files[path] = content

    return files


def _sync_highlight_file(
    db: Session,
    viewer_id: UUID,
    path: Path,
    text_content: str,
    metadata: dict[str, object],
    body: str,
) -> None:
    changed, conflict_reason = _sync_highlight_content(db, viewer_id, metadata, body)
    if conflict_reason is not None:
        _write_conflict(path, text_content, conflict_reason)
    elif changed and not str(metadata.get("highlight_handle") or "") and path.exists():
        path.unlink()


def _sync_highlight_content(
    db: Session,
    viewer_id: UUID,
    metadata: dict[str, object],
    body: str,
) -> tuple[bool, str | None]:
    highlight_handle = str(metadata.get("highlight_handle") or "")
    if not highlight_handle:
        try:
            _create_highlight_from_file(db, viewer_id, metadata, body)
            return True, None
        except ApiError as exc:
            db.rollback()
            return False, exc.message

    try:
        highlight_id = _parse_handle(highlight_handle, "hl")
    except ApiError as exc:
        return False, exc.message
    highlight = db.get(Highlight, highlight_id)
    if highlight is None or highlight.user_id != viewer_id:
        return False, "Highlight does not exist or is not owned by this user"

    local_hash = _highlight_hash(metadata, body)
    if local_hash == metadata.get("last_synced_sha256"):
        return False, None

    server_updated_at = _highlight_server_updated_at(highlight)
    if str(metadata.get("server_updated_at") or "") != server_updated_at:
        return False, "Server highlight changed since this file was exported"

    if _as_bool(metadata.get("deleted")):
        try:
            _delete_highlight(db, highlight)
            db.commit()
            return True, None
        except ApiError as exc:
            db.rollback()
            return False, exc.message

    try:
        _apply_highlight_changes(db, viewer_id, highlight, metadata, body)
        db.commit()
        return True, None
    except ApiError as exc:
        db.rollback()
        return False, exc.message


def _create_highlight_from_file(
    db: Session, viewer_id: UUID, metadata: dict[str, object], body: str
) -> None:
    media_handle = str(metadata.get("media_handle") or "")
    media_id = _parse_handle(media_handle, "med")
    media = db.get(Media, media_id)
    if media is None or not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if _processing_status_value(media.processing_status) not in {
        "ready_for_reading",
        "embedding",
        "ready",
    }:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media not ready")

    selector_kind = str(metadata.get("selector_kind") or "")
    color = str(metadata.get("color") or "yellow")
    if media.kind == "pdf":
        if selector_kind != "pdf_text_quote":
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "PDF highlights require pdf_text_quote")
        highlight = _create_pdf_text_highlight(db, viewer_id, media, metadata, color)
    else:
        highlight = _create_fragment_highlight(db, viewer_id, media, metadata, color)

    note = body.strip()
    if note:
        db.add(Annotation(highlight_id=highlight.id, body=note))
    db.flush()
    db.commit()


def _apply_highlight_changes(
    db: Session,
    viewer_id: UUID,
    highlight: Highlight,
    metadata: dict[str, object],
    body: str,
) -> None:
    if str(metadata.get("color") or highlight.color) != highlight.color:
        highlight.color = str(metadata.get("color"))
        highlight.updated_at = func.now()

    note = body.strip()
    annotation = db.query(Annotation).filter(Annotation.highlight_id == highlight.id).first()
    if note:
        if annotation is None:
            db.add(Annotation(highlight_id=highlight.id, body=note))
        elif annotation.body != note:
            annotation.body = note
            annotation.updated_at = func.now()
    elif annotation is not None:
        db.delete(annotation)

    selector_kind = str(metadata.get("selector_kind") or "")
    if highlight.anchor_kind == "fragment_offsets":
        if selector_kind in {"text_quote", "text_position"}:
            fragment_id, start_offset, end_offset = _resolve_fragment_selector(
                db, _highlight_media_id_required(highlight), metadata
            )
            if (
                highlight.fragment_id != fragment_id
                or highlight.start_offset != start_offset
                or highlight.end_offset != end_offset
            ):
                fragment = db.get(Fragment, fragment_id)
                if fragment is None:
                    raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")
                validate_offsets_or_400(fragment.canonical_text, start_offset, end_offset)
                exact, prefix, suffix = derive_exact_prefix_suffix(
                    fragment.canonical_text, start_offset, end_offset
                )
                highlight.fragment_id = fragment_id
                highlight.start_offset = start_offset
                highlight.end_offset = end_offset
                highlight.anchor_media_id = fragment.media_id
                highlight.exact = exact
                highlight.prefix = prefix
                highlight.suffix = suffix
                highlight.updated_at = func.now()
                anchor = highlight.fragment_anchor
                if anchor is None:
                    db.add(
                        HighlightFragmentAnchor(
                            highlight_id=highlight.id,
                            fragment_id=fragment_id,
                            start_offset=start_offset,
                            end_offset=end_offset,
                        )
                    )
                else:
                    anchor.fragment_id = fragment_id
                    anchor.start_offset = start_offset
                    anchor.end_offset = end_offset
    elif highlight.anchor_kind == "pdf_text_quote":
        page_number, start_offset, end_offset, exact, prefix, suffix = _resolve_pdf_text_selector(
            db, _highlight_media_id_required(highlight), metadata
        )
        anchor = highlight.pdf_text_anchor
        if anchor is None:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "PDF text anchor is missing")
        if (
            anchor.page_number != page_number
            or anchor.plain_text_start_offset != start_offset
            or anchor.plain_text_end_offset != end_offset
        ):
            anchor.page_number = page_number
            anchor.plain_text_start_offset = start_offset
            anchor.plain_text_end_offset = end_offset
            highlight.exact = exact
            highlight.prefix = prefix
            highlight.suffix = suffix
            highlight.updated_at = func.now()
    elif highlight.anchor_kind == "pdf_page_geometry":
        exported = _highlight_hash(_metadata_for_highlight(highlight), body)
        local = _highlight_hash(metadata, body)
        if exported != local and str(metadata.get("exact") or "") != highlight.exact:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "PDF geometry highlight selectors must be edited in the reader",
            )
    db.flush()


def _create_fragment_highlight(
    db: Session, viewer_id: UUID, media: Media, metadata: dict[str, object], color: str
) -> Highlight:
    fragment_id, start_offset, end_offset = _resolve_fragment_selector(db, media.id, metadata)
    fragment = db.get(Fragment, fragment_id)
    if fragment is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")
    validate_offsets_or_400(fragment.canonical_text, start_offset, end_offset)
    exact, prefix, suffix = derive_exact_prefix_suffix(
        fragment.canonical_text, start_offset, end_offset
    )
    highlight = Highlight(
        user_id=viewer_id,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
        anchor_kind="fragment_offsets",
        anchor_media_id=media.id,
        color=color,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )
    db.add(highlight)
    try:
        db.flush()
        db.add(
            HighlightFragmentAnchor(
                highlight_id=highlight.id,
                fragment_id=fragment_id,
                start_offset=start_offset,
                end_offset=end_offset,
            )
        )
        db.flush()
    except IntegrityError as exc:
        raise map_integrity_error(exc) from exc
    return highlight


def _create_pdf_text_highlight(
    db: Session, viewer_id: UUID, media: Media, metadata: dict[str, object], color: str
) -> Highlight:
    page_number, start_offset, end_offset, exact, prefix, suffix = _resolve_pdf_text_selector(
        db, media.id, metadata
    )
    highlight = Highlight(
        user_id=viewer_id,
        fragment_id=None,
        start_offset=None,
        end_offset=None,
        anchor_kind="pdf_text_quote",
        anchor_media_id=media.id,
        color=color,
        exact=exact,
        prefix=prefix,
        suffix=suffix,
    )
    db.add(highlight)
    db.flush()
    db.add(
        HighlightPdfTextAnchor(
            highlight_id=highlight.id,
            media_id=media.id,
            page_number=page_number,
            plain_text_start_offset=start_offset,
            plain_text_end_offset=end_offset,
        )
    )
    db.flush()
    return highlight


def _sync_page_file(
    db: Session,
    viewer_id: UUID,
    path: Path,
    text_content: str,
    metadata: dict[str, object],
    body: str,
) -> None:
    changed, conflict_reason = _sync_page_content(
        db, viewer_id, metadata, body, fallback_title=path.stem
    )
    if conflict_reason is not None:
        _write_conflict(path, text_content, conflict_reason)
    elif changed and not str(metadata.get("page_handle") or "") and path.exists():
        path.unlink()


def _sync_page_content(
    db: Session,
    viewer_id: UUID,
    metadata: dict[str, object],
    body: str,
    *,
    fallback_title: str,
) -> tuple[bool, str | None]:
    page_handle = str(metadata.get("page_handle") or "")
    title = str(metadata.get("title") or fallback_title).strip()
    if not title:
        return False, "Page title is required"

    if not page_handle:
        db.add(Page(user_id=viewer_id, title=title[:200], body=body))
        db.commit()
        return True, None

    try:
        page_id = _parse_handle(page_handle, "page")
    except ApiError as exc:
        return False, exc.message
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        return False, "Page does not exist or is not owned by this user"

    local_hash = _page_hash(metadata, body)
    if local_hash == metadata.get("last_synced_sha256"):
        return False, None
    if str(metadata.get("server_updated_at") or "") != page.updated_at.isoformat():
        return False, "Server page changed since this file was exported"
    if _as_bool(metadata.get("deleted")):
        db.delete(page)
    else:
        page.title = title[:200]
        page.body = body
        page.updated_at = func.now()
    db.commit()
    return True, None


def _load_vault_highlights(db: Session, viewer_id: UUID) -> list[Highlight]:
    return (
        db.query(Highlight)
        .filter(Highlight.user_id == viewer_id)
        .order_by(Highlight.created_at.asc(), Highlight.id.asc())
        .all()
    )


def _load_fragments(db: Session, media_id: UUID) -> list[Fragment]:
    return (
        db.query(Fragment).filter(Fragment.media_id == media_id).order_by(Fragment.idx.asc()).all()
    )


def _write_highlight_file(vault_dir: Path, highlight: Highlight) -> None:
    path, content = _highlight_file(highlight)
    _write_text(vault_dir / path, content)


def _highlight_file(highlight: Highlight) -> tuple[str, str]:
    metadata = _metadata_for_highlight(highlight)
    body = highlight.annotation.body if highlight.annotation else ""
    metadata["last_synced_sha256"] = _highlight_hash(metadata, body)
    return f"Highlights/{_highlight_handle(highlight.id)}.md", _write_frontmatter(metadata, body)


def _write_page_file(vault_dir: Path, page: Page) -> None:
    path, content = _page_file(page)
    target = vault_dir / path
    _remove_old_handle_files(target.parent, target.name, _page_handle(page.id))
    _write_text(target, content)


def _page_file(page: Page) -> tuple[str, str]:
    page_handle = _page_handle(page.id)
    slug = _slug(page.title)
    metadata: dict[str, object] = {
        "nexus_type": "page",
        "page_handle": page_handle,
        "title": page.title,
        "server_updated_at": page.updated_at.isoformat(),
        "deleted": False,
    }
    metadata["last_synced_sha256"] = _page_hash(metadata, page.body)
    return f"Pages/{slug}--{page_handle}.md", _write_frontmatter(metadata, page.body)


def _metadata_for_highlight(highlight: Highlight) -> dict[str, object]:
    media_id = _highlight_media_id_required(highlight)
    metadata: dict[str, object] = {
        "nexus_type": "highlight",
        "highlight_handle": _highlight_handle(highlight.id),
        "media_handle": _media_handle(media_id),
        "color": highlight.color,
        "server_updated_at": _highlight_server_updated_at(highlight),
        "deleted": False,
        "exact": highlight.exact,
        "prefix": highlight.prefix,
        "suffix": highlight.suffix,
    }
    if highlight.anchor_kind == "pdf_page_geometry":
        metadata["selector_kind"] = "pdf_page_geometry"
        metadata["page"] = highlight.pdf_anchor.page_number if highlight.pdf_anchor else 0
    elif highlight.anchor_kind == "pdf_text_quote":
        metadata["selector_kind"] = "pdf_text_quote"
        metadata["page"] = highlight.pdf_text_anchor.page_number if highlight.pdf_text_anchor else 0
    else:
        metadata["selector_kind"] = "text_position"
        metadata["fragment_handle"] = _fragment_handle(highlight.fragment_id)
        metadata["start_offset"] = int(highlight.start_offset or 0)
        metadata["end_offset"] = int(highlight.end_offset or 0)
    return metadata


def _resolve_fragment_selector(
    db: Session, media_id: UUID, metadata: dict[str, object]
) -> tuple[UUID, int, int]:
    selector_kind = str(metadata.get("selector_kind") or "")
    if selector_kind == "text_position":
        fragment_handle = str(metadata.get("fragment_handle") or "")
        fragment_id = _parse_handle(fragment_handle, "frag")
        fragment = db.get(Fragment, fragment_id)
        if fragment is None or fragment.media_id != media_id:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")
        return fragment_id, int(metadata["start_offset"]), int(metadata["end_offset"])

    exact = str(metadata.get("exact") or "")
    if not exact:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE, "Highlight exact text is required")
    prefix = str(metadata.get("prefix") or "")
    suffix = str(metadata.get("suffix") or "")
    matches: list[tuple[UUID, int, int]] = []
    for fragment in _load_fragments(db, media_id):
        start = 0
        while True:
            idx = fragment.canonical_text.find(exact, start)
            if idx == -1:
                break
            end = idx + len(exact)
            if (not prefix or fragment.canonical_text[:idx].endswith(prefix)) and (
                not suffix or fragment.canonical_text[end:].startswith(suffix)
            ):
                matches.append((fragment.id, idx, end))
            start = idx + 1
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE, "Highlight quote was not found")
    raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight quote matched multiple places")


def _resolve_pdf_text_selector(
    db: Session, media_id: UUID, metadata: dict[str, object]
) -> tuple[int, int, int, str, str, str]:
    page_number = int(metadata.get("page") or 0)
    exact = str(metadata.get("exact") or "")
    if not exact:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE, "Highlight exact text is required")
    media = db.get(Media, media_id)
    if media is None or media.plain_text is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "PDF text is not ready")
    page_span = (
        db.query(PdfPageTextSpan)
        .filter(PdfPageTextSpan.media_id == media_id, PdfPageTextSpan.page_number == page_number)
        .first()
    )
    if page_span is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "PDF page text is not available")
    result = compute_match(
        exact=exact,
        page_number=page_number,
        plain_text=media.plain_text,
        page_span_start=page_span.start_offset,
        page_span_end=page_span.end_offset,
    )
    if result.status != MatchStatus.unique:
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, f"PDF quote match is {result.status}")
    return (
        page_number,
        int(result.start_offset),
        int(result.end_offset),
        exact,
        result.prefix,
        result.suffix,
    )


def _delete_highlight(db: Session, highlight: Highlight) -> None:
    db.execute(delete(Annotation).where(Annotation.highlight_id == highlight.id))
    db.execute(
        delete(HighlightPdfTextAnchor).where(HighlightPdfTextAnchor.highlight_id == highlight.id)
    )
    db.execute(delete(Highlight).where(Highlight.id == highlight.id))


def _highlight_media_id(highlight: Highlight) -> UUID | None:
    if highlight.anchor_media_id is not None:
        return highlight.anchor_media_id
    if highlight.fragment is not None:
        return highlight.fragment.media_id
    return None


def _highlight_media_id_required(highlight: Highlight) -> UUID:
    media_id = _highlight_media_id(highlight)
    if media_id is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Highlight is missing media anchor")
    return media_id


def _highlight_server_updated_at(highlight: Highlight) -> str:
    updated_at = highlight.updated_at
    if highlight.annotation is not None and highlight.annotation.updated_at > updated_at:
        updated_at = highlight.annotation.updated_at
    return updated_at.isoformat()


def _highlight_sort_key(highlight: Highlight) -> tuple[int, int, int]:
    if highlight.pdf_anchor is not None:
        return (highlight.pdf_anchor.page_number, int(highlight.pdf_anchor.sort_top), 0)
    if highlight.pdf_text_anchor is not None:
        return (
            highlight.pdf_text_anchor.page_number,
            highlight.pdf_text_anchor.plain_text_start_offset,
            0,
        )
    return (0, int(highlight.start_offset or 0), int(highlight.end_offset or 0))


def _write_source_file(
    row: dict,
    source_dir: Path,
    storage_client: StorageClientBase | None,
) -> None:
    storage_path = row.get("storage_path")
    if not storage_path:
        return
    client = storage_client or get_storage_client()
    ext = get_file_extension(str(row["kind"]))
    path = source_dir / f"source.{ext}"
    chunks = list(client.stream_object(str(storage_path)))
    _write_bytes(path, b"".join(chunks), read_only=True)


def _media_markdown(
    row: dict,
    media_handle: str,
    source_link: str,
    highlights: list[Highlight],
) -> str:
    metadata = {
        "nexus_type": "media",
        "media_handle": media_handle,
        "kind": str(row["kind"]),
        "title": str(row["title"]),
        "source_sha256": str(row["file_sha256"] or ""),
        "immutable_source": True,
    }
    lines = [
        _write_frontmatter(metadata, f"# {row['title']}\n"),
        f"Source: [{Path(source_link).name}]({source_link})",
        "",
        "## Highlights",
        "",
    ]
    for highlight in highlights:
        lines.append(f"![[../Highlights/{_highlight_handle(highlight.id)}]]")
    return "\n".join(lines).rstrip() + "\n"


def _web_article_markdown(title: str, fragments: list[Fragment]) -> str:
    return f"# {title}\n\n{_joined_fragment_text(fragments).strip()}\n"


def _fragment_text_markdown(title: str, fragments: list[Fragment]) -> str:
    lines = [f"# {title}", ""]
    for fragment in fragments:
        lines.extend([f"## Chapter {fragment.idx + 1}", "", fragment.canonical_text.strip(), ""])
    return "\n".join(lines).rstrip() + "\n"


def _pdf_markdown(db: Session, title: str, media_id: UUID, plain_text: str) -> str:
    spans = (
        db.query(PdfPageTextSpan)
        .filter(PdfPageTextSpan.media_id == media_id)
        .order_by(PdfPageTextSpan.page_number.asc())
        .all()
    )
    if not spans:
        return f"# {title}\n\n{plain_text.strip()}\n"
    lines = [f"# {title}", ""]
    for span in spans:
        lines.extend(
            [
                f"## Page {span.page_number}",
                "",
                plain_text[span.start_offset : span.end_offset].strip(),
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def _joined_fragment_text(fragments: list[Fragment]) -> str:
    return "\n\n".join(fragment.canonical_text for fragment in fragments)


def _joined_fragment_html(fragments: list[Fragment]) -> str:
    return "\n".join(fragment.html_sanitized for fragment in fragments)


def _highlight_hash(metadata: dict[str, object], body: str) -> str:
    return _stable_hash(
        {
            key: metadata.get(key)
            for key in (
                "media_handle",
                "selector_kind",
                "fragment_handle",
                "page",
                "start_offset",
                "end_offset",
                "color",
                "deleted",
                "exact",
                "prefix",
                "suffix",
            )
        },
        body,
    )


def _page_hash(metadata: dict[str, object], body: str) -> str:
    return _stable_hash(
        {
            "title": metadata.get("title"),
            "deleted": metadata.get("deleted"),
        },
        body,
    )


def _stable_hash(metadata: dict[str, object], body: str) -> str:
    return hashlib.sha256(
        (json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n" + body).encode("utf-8")
    ).hexdigest()


def _read_frontmatter(text_content: str) -> tuple[dict[str, object], str]:
    if not text_content.startswith("---\n"):
        return {}, text_content
    end = text_content.find("\n---\n", 4)
    if end == -1:
        return {}, text_content
    metadata: dict[str, object] = {}
    lines = text_content[4:end].splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip():
            continue
        key, raw_value = line.split(":", 1)
        value = raw_value.strip()
        if value == "|":
            block_lines = []
            while i < len(lines) and (lines[i].startswith("  ") or not lines[i].strip()):
                block_lines.append(lines[i][2:] if lines[i].startswith("  ") else "")
                i += 1
            metadata[key] = "\n".join(block_lines).rstrip("\n")
        elif value in {"true", "false"}:
            metadata[key] = value == "true"
        elif value.startswith('"'):
            metadata[key] = json.loads(value)
        elif re.fullmatch(r"-?\d+", value):
            metadata[key] = int(value)
        else:
            metadata[key] = value
    return metadata, text_content[end + 5 :]


def _write_frontmatter(metadata: dict[str, object], body: str) -> str:
    lines = ["---"]
    for key, value in metadata.items():
        if isinstance(value, bool):
            lines.append(f"{key}: {'true' if value else 'false'}")
        elif isinstance(value, int):
            lines.append(f"{key}: {value}")
        elif isinstance(value, str) and ("\n" in value or len(value) > 80):
            lines.append(f"{key}: |")
            if value:
                for block_line in value.splitlines():
                    lines.append(f"  {block_line}")
            else:
                lines.append("  ")
        else:
            lines.append(f"{key}: {json.dumps(str(value))}")
    lines.extend(["---", body.rstrip(), ""])
    return "\n".join(lines)


def _write_conflict(path: Path, text_content: str, reason: str) -> None:
    conflict_path = path.with_name(path.name.removesuffix(".md") + ".conflict.md")
    _write_text(conflict_path, _conflict_markdown(text_content, reason))


def _editable_vault_path(raw_path: str) -> str:
    path = raw_path.replace("\\", "/").strip()
    if (
        path.startswith("/")
        or path.endswith(".conflict.md")
        or not re.fullmatch(r"(Highlights|Pages)/[^/]+\.md", path)
        or ".." in path.split("/")
    ):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Editable vault uploads must be Markdown files under Highlights/ or Pages/",
        )
    return path


def _conflict_path(path: str) -> str:
    return path.removesuffix(".md") + ".conflict.md"


def _conflict_markdown(text_content: str, reason: str) -> str:
    return (
        f"# Nexus Sync Conflict\n\nReason: {reason}\n\n## Local File\n\n"
        f"```markdown\n{text_content}\n```\n"
    )


def _write_source_files(
    db: Session,
    viewer_id: UUID,
    vault_dir: Path,
    storage_client: StorageClientBase,
) -> None:
    rows = (
        db.execute(
            text(f"""
            WITH visible_media AS (
                {visible_media_ids_cte_sql()}
            )
            SELECT m.id, m.kind, mf.storage_path, mf.content_type
            FROM media m
            JOIN visible_media vm ON vm.media_id = m.id
            JOIN media_file mf ON mf.media_id = m.id
            WHERE m.kind IN ('epub', 'pdf')
            ORDER BY lower(m.title), m.id
        """),
            {"viewer_id": viewer_id},
        )
        .mappings()
        .all()
    )
    for row in rows:
        media_handle = _media_handle(UUID(str(row["id"])))
        _write_source_file(row, vault_dir / "Sources" / media_handle, storage_client)


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return
    if path.exists():
        os.chmod(path, 0o644)
    path.write_text(content, encoding="utf-8")


def _write_bytes(path: Path, content: bytes, *, read_only: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        os.chmod(path, 0o644)
        if path.read_bytes() == content:
            if read_only:
                os.chmod(path, 0o444)
            return
    path.write_bytes(content)
    if read_only:
        os.chmod(path, 0o444)


def _remove_old_handle_files(directory: Path, target_name: str, handle: str) -> None:
    for existing in directory.glob(f"*--{handle}.md"):
        if existing.name != target_name:
            existing.unlink()


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:80].strip("-") or "untitled"


def _media_handle(media_id: UUID) -> str:
    return f"med_{media_id.hex}"


def _highlight_handle(highlight_id: UUID) -> str:
    return f"hl_{highlight_id.hex}"


def _fragment_handle(fragment_id: UUID | None) -> str:
    if fragment_id is None:
        return ""
    return f"frag_{fragment_id.hex}"


def _page_handle(page_id: UUID) -> str:
    return f"page_{page_id.hex}"


def _parse_handle(handle: str, prefix: str) -> UUID:
    expected = f"{prefix}_"
    if not handle.startswith(expected):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid {prefix} handle")
    return UUID(hex=handle[len(expected) :])


def _processing_status_value(value: object) -> str:
    return str(getattr(value, "value", value))


def _as_bool(value: object) -> bool:
    return value is True or value == "true"
