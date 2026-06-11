"""Local Markdown vault export and sync.

The vault is an editable projection. Media text and source files are rewritten
from the server; highlight/page Markdown bodies are the local editing surface.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import time
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, TypedDict, cast
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import (
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Media,
    NoteBlock,
    Page,
    ResourceEdge,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.notes import NOTE_BLOCK_KIND_VALUES, NOTE_BLOCK_KINDS, PatchPageDocumentRequest
from nexus.services import notes as notes_service
from nexus.services.highlights import (
    derive_exact_prefix_suffix,
    map_integrity_error,
    validate_offsets_or_400,
)
from nexus.services.notes import delete_page, pm_doc_from_markdown_projection
from nexus.services.resource_graph import documents as graph_documents
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
from nexus.services.resource_graph.refs import ResourceRef
from nexus.storage.client import StorageClientBase, get_storage_client
from nexus.storage.paths import get_file_extension


class VaultFile(TypedDict):
    path: str
    content: str


class VaultConflict(VaultFile):
    message: str


class VaultSyncResult(TypedDict):
    files: list[VaultFile]
    delete_paths: list[str]
    conflicts: list[VaultConflict]


class _ParsedPageBlock(TypedDict):
    id: UUID
    parent_id: UUID | None
    kind: str
    body: str


_BLOCK_MARKER_RE = re.compile(
    r"^<!-- nexus:block id=\"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\" parent=\"([^\"]*)\" kind=\"([a-z_]+)\" -->$"
)
_HIGHLIGHT_NOTE_MARKER_RE = re.compile(
    r"^<!-- nexus:highlight-note id=\"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\" -->$"
)


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
    files: list[VaultFile] = []
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


def export_vault_files(db: Session, viewer_id: UUID) -> list[VaultFile]:
    files = _vault_file_map(db, viewer_id)
    return [{"path": path, "content": files[path]} for path in sorted(files)]


def export_vault_zip(db: Session, viewer_id: UUID) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in export_vault_files(db, viewer_id):
            info = zipfile.ZipInfo(file["path"], date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, file["content"].encode("utf-8"))
    return buffer.getvalue()


def sync_vault_files(
    db: Session,
    viewer_id: UUID,
    local_files: Sequence[VaultFile],
) -> VaultSyncResult:
    delete_paths: list[str] = []
    conflicts: list[VaultConflict] = []

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
                   m.page_count, mf.storage_path, mf.content_type
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
        content_blocks = _load_content_blocks(db, media_id)
        if row["kind"] == "web_article":
            files[f"Sources/{media_handle}/article.md"] = _web_article_markdown(
                media_title, content_blocks
            )
            files[f"Sources/{media_handle}/article.html"] = _joined_fragment_html(fragments)
            files[f"Sources/{media_handle}/canonical.txt"] = _joined_block_text(content_blocks)
            source_link = f"../Sources/{media_handle}/article.md"
        elif row["kind"] == "epub":
            files[f"Sources/{media_handle}/text.md"] = _fragment_text_markdown(
                media_title, content_blocks
            )
            source_link = f"../Sources/{media_handle}/text.md"
        elif row["kind"] == "pdf":
            files[f"Sources/{media_handle}/text.md"] = _pdf_markdown(media_title, content_blocks)
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
            path, content = _highlight_file(db, highlight)
            files[path] = content

    for page in (
        db.query(Page).filter(Page.user_id == viewer_id).order_by(Page.title.asc(), Page.id.asc())
    ):
        path, content = _page_file(db, page)
        files[path] = content

    return files


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
    if highlight.anchor_kind not in {"fragment_offsets", "pdf_page_geometry"}:
        return False, "Unsupported highlight anchor kind"

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


def _lock_fragment_row_for_highlight_write(db: Session, fragment_id: UUID) -> None:
    locked = db.execute(
        text("SELECT 1 FROM fragments WHERE id = :fragment_id FOR UPDATE"),
        {"fragment_id": fragment_id},
    ).scalar_one_or_none()
    if locked is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")


def _fragment_highlight_span_conflict_exists(
    db: Session,
    *,
    user_id: UUID,
    fragment_id: UUID,
    start_offset: int,
    end_offset: int,
    exclude_highlight_id: UUID | None = None,
) -> bool:
    query = (
        db.query(Highlight.id)
        .join(HighlightFragmentAnchor, Highlight.id == HighlightFragmentAnchor.highlight_id)
        .filter(
            Highlight.user_id == user_id,
            Highlight.anchor_kind == "fragment_offsets",
            HighlightFragmentAnchor.fragment_id == fragment_id,
            HighlightFragmentAnchor.start_offset == start_offset,
            HighlightFragmentAnchor.end_offset == end_offset,
        )
    )
    if exclude_highlight_id is not None:
        query = query.filter(Highlight.id != exclude_highlight_id)
    return query.first() is not None


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

    color = str(metadata.get("color") or "yellow")
    if media.kind == "pdf":
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Vault highlight creation only supports fragment_offsets selectors",
        )
    highlight = _create_fragment_highlight(db, viewer_id, media, metadata, color)

    note = body.strip()
    if note:
        _save_highlight_note_body_from_vault(
            db,
            viewer_id,
            highlight_id=highlight.id,
            block_id=uuid4(),
            body=note,
        )
    else:
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

    selector_kind = str(metadata.get("selector_kind") or "")
    if highlight.anchor_kind == "fragment_offsets":
        if selector_kind != "fragment_offsets":
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Fragment highlights require fragment_offsets selectors",
            )
        anchor = highlight.fragment_anchor
        if anchor is None:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Fragment anchor is missing")
        fragment_id, start_offset, end_offset = _resolve_fragment_selector(
            db, _highlight_media_id_required(highlight), metadata
        )
        if (
            anchor.fragment_id != fragment_id
            or anchor.start_offset != start_offset
            or anchor.end_offset != end_offset
        ):
            fragment = db.get(Fragment, fragment_id)
            if fragment is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")
            _lock_fragment_row_for_highlight_write(db, fragment_id)
            if _fragment_highlight_span_conflict_exists(
                db,
                user_id=viewer_id,
                fragment_id=fragment_id,
                start_offset=start_offset,
                end_offset=end_offset,
                exclude_highlight_id=highlight.id,
            ):
                raise ApiError(
                    ApiErrorCode.E_HIGHLIGHT_CONFLICT,
                    "Highlight already exists at this range",
                )
            validate_offsets_or_400(fragment.canonical_text, start_offset, end_offset)
            exact, prefix, suffix = derive_exact_prefix_suffix(
                fragment.canonical_text, start_offset, end_offset
            )
            highlight.anchor_media_id = fragment.media_id
            highlight.exact = exact
            highlight.prefix = prefix
            highlight.suffix = suffix
            highlight.updated_at = func.now()
            anchor.fragment_id = fragment_id
            anchor.start_offset = start_offset
            anchor.end_offset = end_offset
    elif highlight.anchor_kind == "pdf_page_geometry":
        if selector_kind != "pdf_page_geometry":
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "PDF geometry highlights require pdf_page_geometry selectors",
            )
        server_metadata = _metadata_for_highlight(highlight)
        if str(metadata.get("exact") or "") != highlight.exact or metadata.get(
            "page"
        ) != server_metadata.get("page"):
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "PDF geometry highlight selectors must be edited in the reader",
            )
    else:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported highlight anchor kind")
    note = body.strip()
    _sync_highlight_note_body_from_vault(db, viewer_id, highlight.id, note)
    db.flush()


def _create_fragment_highlight(
    db: Session, viewer_id: UUID, media: Media, metadata: dict[str, object], color: str
) -> Highlight:
    fragment_id, start_offset, end_offset = _resolve_fragment_selector(db, media.id, metadata)
    fragment = db.get(Fragment, fragment_id)
    if fragment is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")
    _lock_fragment_row_for_highlight_write(db, fragment_id)
    validate_offsets_or_400(fragment.canonical_text, start_offset, end_offset)
    if _fragment_highlight_span_conflict_exists(
        db,
        user_id=viewer_id,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
    ):
        raise ApiError(ApiErrorCode.E_HIGHLIGHT_CONFLICT, "Highlight already exists at this range")
    exact, prefix, suffix = derive_exact_prefix_suffix(
        fragment.canonical_text, start_offset, end_offset
    )
    highlight = Highlight(
        user_id=viewer_id,
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
        page = Page(user_id=viewer_id, title=title[:200], description=None)
        db.add(page)
        db.flush()
        body_changed, conflict_reason, blocks, containment = _sync_page_body(
            db, viewer_id, page, body
        )
        if conflict_reason is not None:
            db.rollback()
            return False, conflict_reason
        if body_changed:
            _patch_page_document_from_vault(
                db,
                viewer_id,
                page,
                title=page.title,
                blocks=blocks,
                containment=containment,
            )
        else:
            db.commit()
        return True, None

    try:
        page_id = _parse_handle(page_handle, "page")
    except ApiError as exc:
        return False, exc.message
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        return False, "Page does not exist or is not owned by this user"

    if str(metadata.get("server_updated_at") or "") != page.updated_at.isoformat():
        return False, "Server page changed since this file was exported"
    if _as_bool(metadata.get("deleted")):
        delete_page(db, viewer_id, page.id)
        return True, None

    body_changed, conflict_reason, blocks, containment = _sync_page_body(db, viewer_id, page, body)
    if conflict_reason is not None:
        return False, conflict_reason
    next_title = title[:200]
    title_changed = page.title != next_title
    if body_changed or title_changed:
        _patch_page_document_from_vault(
            db,
            viewer_id,
            page,
            title=next_title,
            blocks=blocks,
            containment=containment,
        )
    else:
        db.commit()
    return True, None


def _load_vault_highlights(db: Session, viewer_id: UUID) -> list[Highlight]:
    return (
        db.query(Highlight)
        .filter(
            Highlight.user_id == viewer_id,
            Highlight.anchor_kind.in_(("fragment_offsets", "pdf_page_geometry")),
        )
        .order_by(Highlight.created_at.asc(), Highlight.id.asc())
        .all()
    )


def _load_fragments(db: Session, media_id: UUID) -> list[Fragment]:
    return (
        db.query(Fragment).filter(Fragment.media_id == media_id).order_by(Fragment.idx.asc()).all()
    )


def _load_content_blocks(db: Session, media_id: UUID) -> list[dict[str, object]]:
    rows = (
        db.execute(
            text(
                """
                SELECT cb.canonical_text, cb.locator
                FROM content_index_states mcis
                JOIN content_blocks cb ON cb.owner_kind = mcis.owner_kind AND cb.owner_id = mcis.owner_id
                WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
                  AND mcis.status = 'ready'
                  AND cb.canonical_text <> ''
                ORDER BY cb.block_idx ASC
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .all()
    )
    return [dict(row) for row in rows]


def _highlight_file(db: Session, highlight: Highlight) -> tuple[str, str]:
    metadata = _metadata_for_highlight(highlight)
    body = _highlight_note_body(db, highlight)
    return f"Highlights/{_highlight_handle(highlight.id)}.md", _write_frontmatter(metadata, body)


def _page_file(db: Session, page: Page) -> tuple[str, str]:
    page_handle = _page_handle(page.id)
    slug = _slug(page.title)
    metadata: dict[str, object] = {
        "nexus_type": "page",
        "page_handle": page_handle,
        "title": page.title,
        "server_updated_at": page.updated_at.isoformat(),
        "deleted": False,
    }
    body = _page_body(db, page)
    return f"Pages/{slug}--{page_handle}.md", _write_frontmatter(metadata, body)


def _sync_page_body(
    db: Session,
    viewer_id: UUID,
    page: Page,
    body: str,
) -> tuple[bool, str | None, list[dict[str, Any]], list[dict[str, Any]]]:
    text_body = body.strip()
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page.id)
    nodes = _editable_page_nodes_from_document(db, viewer_id, document)
    current_body = _page_blocks_markdown(nodes).strip()

    parsed_blocks = _parse_marked_page_blocks(text_body)
    if parsed_blocks:
        return _marked_page_patch_payload(document, nodes, parsed_blocks)

    if not nodes:
        blocks, containment = _document_patch_payload(document)
        if text_body:
            block_id = uuid4()
            blocks.append(
                {
                    "id": block_id,
                    "block_kind": "bullet",
                    "body_pm_json": _vault_body_pm_json(text_body),
                }
            )
            root_ref = ResourceRef(scheme="page", id=page.id)
            containment_by_parent = _containment_by_parent_from_payload(containment)
            root_children = containment_by_parent.setdefault(root_ref, [])
            root_children.append(
                {"block_id": block_id, "source_order_key": "0000000000", "collapsed": False}
            )
            _renumber_child_payload(root_children)
            containment = _containment_payload(containment_by_parent)
        return text_body != current_body, None, blocks, containment

    flat_nodes = _flatten_page_nodes(nodes)
    if len(flat_nodes) == 1:
        body_updates = (
            {flat_nodes[0].block.id: _vault_body_pm_json(text_body)}
            if text_body != current_body
            else {}
        )
        blocks, containment = _document_patch_payload(document, body_updates=body_updates)
        return bool(body_updates), None, blocks, containment

    fallback_blocks = [part.strip() for part in re.split(r"\n{2,}", text_body) if part.strip()]
    if len(fallback_blocks) != len(nodes):
        blocks, containment = _document_patch_payload(document)
        return (
            False,
            "Vault page sync needs exported block markers for this multi-block page",
            blocks,
            containment,
        )
    body_updates = {
        node.block.id: _vault_body_pm_json(block_body)
        for node, block_body in zip(nodes, fallback_blocks, strict=True)
        if block_body != _block_vault_body(node.block).strip()
    }
    blocks, containment = _document_patch_payload(document, body_updates=body_updates)
    return bool(body_updates), None, blocks, containment


def _patch_page_document_from_vault(
    db: Session,
    viewer_id: UUID,
    page: Page,
    *,
    title: str | None,
    blocks: list[dict[str, Any]],
    containment: list[dict[str, Any]],
    deleted_block_ids: list[UUID] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "page_id": page.id,
        "title": title,
        "blocks": blocks,
        "containment": containment,
        "deleted_block_ids": deleted_block_ids or [],
    }
    notes_service.patch_page_document(
        db,
        viewer_id,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id=_vault_mutation_id("page", payload),
            base_document_version=page.document_version,
            title=title,
            blocks=blocks,
            containment=containment,
            deleted_block_ids=deleted_block_ids or [],
        ),
    )


def _document_patch_payload(
    document: graph_documents.PageDocument,
    *,
    body_updates: Mapping[UUID, dict[str, Any]] | None = None,
    kind_updates: Mapping[UUID, NOTE_BLOCK_KINDS] | None = None,
    containment_by_parent: Mapping[ResourceRef, list[dict[str, Any]]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    body_updates = body_updates or {}
    kind_updates = kind_updates or {}
    blocks: list[dict[str, Any]] = []

    def visit(node: graph_documents.DocumentBlock) -> None:
        blocks.append(
            {
                "id": node.block.id,
                "block_kind": kind_updates.get(
                    node.block.id,
                    cast(NOTE_BLOCK_KINDS, node.block.block_kind),
                ),
                "body_pm_json": body_updates.get(node.block.id, node.block.body_pm_json),
            }
        )
        for child in node.children:
            visit(child)

    for root in document.roots:
        visit(root)

    return blocks, _containment_payload(
        containment_by_parent or _containment_by_parent_from_document(document)
    )


def _containment_by_parent_from_document(
    document: graph_documents.PageDocument,
) -> dict[ResourceRef, list[dict[str, Any]]]:
    containment_by_parent: dict[ResourceRef, list[dict[str, Any]]] = {}

    def visit(node: graph_documents.DocumentBlock) -> None:
        containment_by_parent.setdefault(node.parent, []).append(
            {
                "block_id": node.block.id,
                "source_order_key": node.source_order_key,
                "collapsed": node.collapsed,
            }
        )
        for child in node.children:
            visit(child)

    for root in document.roots:
        visit(root)
    return containment_by_parent


def _containment_by_parent_from_payload(
    containment: Sequence[dict[str, Any]],
) -> dict[ResourceRef, list[dict[str, Any]]]:
    out: dict[ResourceRef, list[dict[str, Any]]] = {}
    for group in containment:
        parent_raw = cast(dict[str, Any], group["parent"])
        parent = ResourceRef(
            scheme=cast(str, parent_raw["scheme"]),
            id=cast(UUID, parent_raw["id"]),
        )
        out[parent] = [dict(child) for child in cast(list[dict[str, Any]], group["children"])]
    return out


def _containment_payload(
    containment_by_parent: Mapping[ResourceRef, Sequence[dict[str, Any]]],
) -> list[dict[str, Any]]:
    return [
        {
            "parent": {"scheme": parent.scheme, "id": parent.id},
            "children": list(children),
        }
        for parent, children in containment_by_parent.items()
    ]


def _renumber_child_payload(children: list[dict[str, Any]]) -> None:
    for index, child in enumerate(children):
        child["source_order_key"] = f"{index + 1:010d}"


def _vault_body_pm_json(markdown: str) -> dict[str, Any]:
    return pm_doc_from_markdown_projection(markdown)


def _vault_mutation_id(prefix: str, payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, default=str, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(encoded).hexdigest()[:32]
    return f"vault-{prefix}-{digest}"


def _editable_page_nodes(db: Session, viewer_id: UUID, page_id: UUID) -> list[object]:
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page_id)
    return _editable_page_nodes_from_document(db, viewer_id, document)


def _editable_page_nodes_from_document(
    db: Session,
    viewer_id: UUID,
    document: graph_documents.PageDocument,
) -> list[object]:
    block_ids = document.block_ids
    if not block_ids:
        return []
    highlight_note_ids = set(
        db.scalars(
            select(ResourceEdge.target_id).where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "highlight_note",
                ResourceEdge.target_scheme == "note_block",
                ResourceEdge.target_id.in_(block_ids),
            )
        )
    )

    def keep(nodes: list[graph_documents.DocumentBlock]) -> list[graph_documents.DocumentBlock]:
        out: list[graph_documents.DocumentBlock] = []
        for node in nodes:
            if node.block.id in highlight_note_ids:
                continue
            out.append(
                graph_documents.DocumentBlock(
                    block=node.block,
                    parent=node.parent,
                    source_order_key=node.source_order_key,
                    collapsed=node.collapsed,
                    children=keep(node.children),
                )
            )
        return out

    return keep(document.roots)


def _block_vault_body(block: NoteBlock) -> str:
    return _vault_markdown_from_pm_json(block.body_pm_json) or block.body_text or ""


def _vault_markdown_from_pm_json(value: object) -> str:
    parts: list[str] = []

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type == "text" and isinstance(node.get("text"), str):
            parts.append(node["text"])
            return
        if node_type in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            object_type = attrs.get("objectType")
            object_id = attrs.get("objectId")
            label = attrs.get("label")
            if isinstance(object_type, str) and isinstance(object_id, str):
                suffix = f"|{label}" if isinstance(label, str) and label else ""
                prefix = "!" if node_type == "object_embed" else ""
                parts.append(f"{prefix}[[{object_type}:{object_id}{suffix}]]")
            return
        if node_type == "image" and isinstance(node.get("attrs"), dict):
            src = node["attrs"].get("src")
            alt = node["attrs"].get("alt")
            if isinstance(src, str) and src:
                parts.append(f"![{alt if isinstance(alt, str) else ''}]({src})")
            elif isinstance(alt, str):
                parts.append(alt)
            return
        if node_type == "hard_break":
            parts.append("\n")
            return
        visit(node.get("content"))
        if node_type in {"paragraph", "heading", "blockquote", "code_block"}:
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


def _page_blocks_markdown(nodes: list[object]) -> str:
    sections: list[str] = []

    def visit(node: object) -> None:
        block = node.block
        parent = "" if node.parent.scheme == "page" else str(node.parent.id)
        marker = f'<!-- nexus:block id="{block.id}" parent="{parent}" kind="{block.block_kind}" -->'
        body = _block_vault_body(block).strip()
        sections.append(f"{marker}\n{body}" if body else marker)
        for child in node.children:
            visit(child)

    for root in nodes:
        visit(root)

    return "\n\n".join(sections)


def _flatten_page_nodes(nodes: list[object]) -> list[object]:
    out: list[object] = []

    def visit(node: object) -> None:
        out.append(node)
        for child in node.children:
            visit(child)

    for node in nodes:
        visit(node)
    return out


def _parse_marked_page_blocks(body: str) -> list[_ParsedPageBlock]:
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    parsed_blocks: list[_ParsedPageBlock] = []
    current: dict[str, object] | None = None
    current_body_lines: list[str] = []
    saw_marker = False
    prefix_lines: list[str] = []

    def flush_current() -> None:
        if current is None:
            return
        parsed_blocks.append(
            {
                "id": current["id"],
                "parent_id": current["parent_id"],
                "kind": current["kind"],
                "body": "\n".join(current_body_lines).strip(),
            }
        )
        current_body_lines.clear()

    for line in lines:
        match = _BLOCK_MARKER_RE.match(line.strip())
        if match is None:
            if current is None:
                prefix_lines.append(line)
            else:
                current_body_lines.append(line)
            continue

        saw_marker = True
        if current is None and "\n".join(prefix_lines).strip():
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Vault page block text must appear after a block marker",
            )
        flush_current()
        parent_raw = match.group(2)
        kind = match.group(3)
        if kind not in NOTE_BLOCK_KIND_VALUES:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Vault page block kind is invalid")
        current = {
            "id": UUID(match.group(1)),
            "parent_id": UUID(parent_raw) if parent_raw else None,
            "kind": kind,
        }

    flush_current()
    return parsed_blocks if saw_marker else []


def _marked_page_patch_payload(
    document: graph_documents.PageDocument,
    nodes: list[object],
    parsed_blocks: list[_ParsedPageBlock],
) -> tuple[bool, str | None, list[dict[str, Any]], list[dict[str, Any]]]:
    current_nodes = _flatten_page_nodes(nodes)
    blocks_by_id = {node.block.id: node.block for node in current_nodes}
    parent_by_id = {
        node.block.id: None if node.parent.scheme == "page" else node.parent.id
        for node in current_nodes
    }
    order_by_id = {node.block.id: node.source_order_key for node in current_nodes}
    parsed_ids = [parsed_block["id"] for parsed_block in parsed_blocks]
    if len(set(parsed_ids)) != len(parsed_ids):
        blocks, containment = _document_patch_payload(document)
        return False, "Vault page contains duplicate note block markers", blocks, containment

    if set(parsed_ids) != set(blocks_by_id):
        blocks, containment = _document_patch_payload(document)
        return (
            False,
            "Vault page block markers must match the editable page blocks",
            blocks,
            containment,
        )

    parsed_id_set = set(parsed_ids)
    for parsed_block in parsed_blocks:
        parent_id = parsed_block["parent_id"]
        if (
            parent_id is not None
            and parent_id not in parsed_id_set
            and parent_id not in blocks_by_id
        ):
            blocks, containment = _document_patch_payload(document)
            return (
                False,
                "Vault page contains a note block parent that is not on this page",
                blocks,
                containment,
            )

    body_updates: dict[UUID, dict[str, Any]] = {}
    kind_updates: dict[UUID, NOTE_BLOCK_KINDS] = {}
    desired_by_parent: dict[ResourceRef, list[dict[str, Any]]] = {}
    collapsed_by_id = {node.block.id: node.collapsed for node in current_nodes}
    for parsed_block in parsed_blocks:
        block = blocks_by_id[parsed_block["id"]]
        parent_id = parsed_block["parent_id"]
        parent = (
            ResourceRef(scheme="page", id=document.page.id)
            if parent_id is None
            else ResourceRef(scheme="note_block", id=parent_id)
        )
        body_updates[block.id] = _vault_body_pm_json(parsed_block["body"])
        kind_updates[block.id] = cast(NOTE_BLOCK_KINDS, parsed_block["kind"])
        desired_by_parent.setdefault(parent, []).append(
            {
                "block_id": block.id,
                "source_order_key": "0000000000",
                "collapsed": collapsed_by_id[block.id],
            }
        )

    containment_by_parent = _containment_by_parent_from_document(document)
    for parent in set(containment_by_parent) | set(desired_by_parent):
        desired = desired_by_parent.get(parent, [])
        inserted = False
        next_children: list[dict[str, Any]] = []
        for child in containment_by_parent.get(parent, []):
            if child["block_id"] in parsed_id_set:
                if not inserted and desired:
                    next_children.extend(desired)
                    inserted = True
                continue
            next_children.append(child)
        if desired and not inserted:
            next_children.extend(desired)
        _renumber_child_payload(next_children)
        containment_by_parent[parent] = next_children

    next_parent_by_id: dict[UUID, UUID | None] = {}
    next_order_by_id: dict[UUID, str] = {}
    for parent, children in containment_by_parent.items():
        parent_id = None if parent.scheme == "page" else parent.id
        for child in children:
            block_id = cast(UUID, child["block_id"])
            next_parent_by_id[block_id] = parent_id
            next_order_by_id[block_id] = cast(str, child["source_order_key"])

    changed = any(
        (
            parent_by_id[block_id] != next_parent_by_id.get(block_id)
            or order_by_id[block_id] != next_order_by_id.get(block_id)
            or blocks_by_id[block_id].block_kind != kind_updates[block_id]
            or _block_vault_body(blocks_by_id[block_id]).strip() != parsed_block["body"]
        )
        for parsed_block in parsed_blocks
        for block_id in [parsed_block["id"]]
    )
    blocks, containment = _document_patch_payload(
        document,
        body_updates=body_updates,
        kind_updates=kind_updates,
        containment_by_parent=containment_by_parent,
    )
    return changed, None, blocks, containment


def _page_body(db: Session, page: Page) -> str:
    return _page_blocks_markdown(_editable_page_nodes(db, page.user_id, page.id))


def _highlight_note_body(db: Session, highlight: Highlight) -> str:
    blocks = _highlight_note_blocks(db, highlight.user_id, highlight.id)
    if not blocks:
        return ""
    if len(blocks) == 1:
        return _block_vault_body(blocks[0])

    sections: list[str] = []
    for block in blocks:
        marker = f'<!-- nexus:highlight-note id="{block.id}" -->'
        body = _block_vault_body(block).strip()
        sections.append(f"{marker}\n{body}" if body else marker)
    return "\n\n".join(sections)


def _sync_highlight_note_body_from_vault(
    db: Session,
    viewer_id: UUID,
    highlight_id: UUID,
    body: str,
) -> None:
    blocks = _highlight_note_blocks(db, viewer_id, highlight_id)
    parsed_notes = _parse_marked_highlight_notes(body)
    if parsed_notes:
        blocks_by_id = {block.id: block for block in blocks}
        parsed_ids = [note_id for note_id, _note_body in parsed_notes]
        if len(set(parsed_ids)) != len(parsed_ids):
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Vault highlight contains duplicate note markers",
            )
        if set(parsed_ids) != set(blocks_by_id):
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Vault highlight note markers must match linked notes",
            )
        _patch_existing_note_block_bodies_from_vault(
            db,
            viewer_id,
            {note_id: note_body for note_id, note_body in parsed_notes},
        )
        return

    if len(blocks) > 1:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Vault highlight sync needs exported note markers for this multi-note highlight",
        )
    existing = blocks[0] if blocks else None
    if not body:
        if existing is not None:
            notes_service.delete_highlight_note(
                db,
                viewer_id,
                highlight_id=highlight_id,
                note_block_id=existing.id,
                client_mutation_id=_vault_mutation_id(
                    "highlight-note-delete",
                    {"highlight_id": highlight_id, "note_block_id": existing.id},
                ),
            )
        return
    _save_highlight_note_body_from_vault(
        db,
        viewer_id,
        highlight_id=highlight_id,
        block_id=existing.id if existing is not None else uuid4(),
        body=body,
    )


def _save_highlight_note_body_from_vault(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    block_id: UUID,
    body: str,
) -> None:
    notes_service.set_highlight_note_body_pm_json(
        db,
        viewer_id,
        highlight_id=highlight_id,
        block_id=block_id,
        body_pm_json=_vault_body_pm_json(body),
        client_mutation_id=_vault_mutation_id(
            "highlight-note",
            {"highlight_id": highlight_id, "block_id": block_id, "body": body},
        ),
    )


def _patch_existing_note_block_bodies_from_vault(
    db: Session,
    viewer_id: UUID,
    body_by_block_id: Mapping[UUID, str],
) -> None:
    if not body_by_block_id:
        return
    occurrences = {
        block_id: graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=block_id)
        for block_id in body_by_block_id
    }
    page_ids = {occurrence.page_id for occurrence in occurrences.values()}
    if len(page_ids) != 1:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Vault highlight note markers must live on one page",
        )
    page = db.get(Page, next(iter(page_ids)))
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page.id)
    body_updates = {
        block_id: _vault_body_pm_json(body) for block_id, body in body_by_block_id.items()
    }
    blocks, containment = _document_patch_payload(document, body_updates=body_updates)
    _patch_page_document_from_vault(
        db,
        viewer_id,
        page,
        title=None,
        blocks=blocks,
        containment=containment,
    )


def _parse_marked_highlight_notes(body: str) -> list[tuple[UUID, str]]:
    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    parsed_notes: list[tuple[UUID, str]] = []
    current_id: UUID | None = None
    current_body_lines: list[str] = []
    saw_marker = False
    prefix_lines: list[str] = []

    def flush_current() -> None:
        if current_id is None:
            return
        parsed_notes.append((current_id, "\n".join(current_body_lines).strip()))
        current_body_lines.clear()

    for line in lines:
        match = _HIGHLIGHT_NOTE_MARKER_RE.match(line.strip())
        if match is None:
            if current_id is None:
                prefix_lines.append(line)
            else:
                current_body_lines.append(line)
            continue

        saw_marker = True
        if current_id is None and "\n".join(prefix_lines).strip():
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Vault highlight note text must appear after a note marker",
            )
        flush_current()
        current_id = UUID(match.group(1))

    flush_current()
    return parsed_notes if saw_marker else []


def _highlight_note_blocks(
    db: Session,
    viewer_id: UUID,
    highlight_id: UUID,
) -> list[NoteBlock]:
    return list(
        db.scalars(
            select(NoteBlock)
            .join(
                ResourceEdge,
                (ResourceEdge.target_scheme == "note_block")
                & (ResourceEdge.target_id == NoteBlock.id),
            )
            .where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "highlight_note",
                ResourceEdge.source_scheme == "highlight",
                ResourceEdge.source_id == highlight_id,
                NoteBlock.user_id == viewer_id,
            )
            .order_by(
                ResourceEdge.created_at.asc(),
                ResourceEdge.id.asc(),
                NoteBlock.id.asc(),
            )
        )
    )


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
    else:
        anchor = highlight.fragment_anchor
        if anchor is None:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Fragment anchor is missing")
        metadata["selector_kind"] = "fragment_offsets"
        metadata["fragment_handle"] = _fragment_handle(anchor.fragment_id)
        metadata["start_offset"] = anchor.start_offset
        metadata["end_offset"] = anchor.end_offset
    return metadata


def _resolve_fragment_selector(
    db: Session, media_id: UUID, metadata: dict[str, object]
) -> tuple[UUID, int, int]:
    selector_kind = str(metadata.get("selector_kind") or "")
    if selector_kind != "fragment_offsets":
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Fragment highlights require fragment_offsets selectors",
        )

    fragment_handle = str(metadata.get("fragment_handle") or "")
    fragment_id = _parse_handle(fragment_handle, "frag")
    fragment = db.get(Fragment, fragment_id)
    if fragment is None or fragment.media_id != media_id:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Fragment not found")
    start_offset = metadata.get("start_offset")
    end_offset = metadata.get("end_offset")
    if not isinstance(start_offset, int) or not isinstance(end_offset, int):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Fragment highlights require integer start_offset and end_offset values",
        )
    return fragment_id, start_offset, end_offset


def _delete_highlight(db: Session, highlight: Highlight) -> None:
    delete_edges_for_deleted_resource(db, ref=ResourceRef(scheme="highlight", id=highlight.id))
    db.execute(delete(Highlight).where(Highlight.id == highlight.id))


def _highlight_media_id(highlight: Highlight) -> UUID | None:
    return highlight.anchor_media_id


def _highlight_media_id_required(highlight: Highlight) -> UUID:
    media_id = _highlight_media_id(highlight)
    if media_id is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Highlight is missing media anchor")
    return media_id


def _highlight_server_updated_at(highlight: Highlight) -> str:
    return highlight.updated_at.isoformat()


def _highlight_sort_key(highlight: Highlight) -> tuple[int, int, int]:
    if highlight.pdf_anchor is not None:
        return (highlight.pdf_anchor.page_number, int(highlight.pdf_anchor.sort_top), 0)
    if highlight.fragment_anchor is None:
        return (0, 0, 0)
    return (
        0,
        highlight.fragment_anchor.start_offset,
        highlight.fragment_anchor.end_offset,
    )


def _write_source_file(
    row: Mapping[Any, Any],
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
    row: Mapping[Any, Any],
    media_handle: str,
    source_link: str,
    highlights: list[Highlight],
) -> str:
    metadata = {
        "nexus_type": "media",
        "media_handle": media_handle,
        "kind": str(row["kind"]),
        "title": str(row["title"]),
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


def _web_article_markdown(title: str, content_blocks: list[dict[str, object]]) -> str:
    return f"# {title}\n\n{_joined_block_text(content_blocks).strip()}\n"


def _fragment_text_markdown(title: str, content_blocks: list[dict[str, object]]) -> str:
    lines = [f"# {title}", ""]
    current_section = None
    for block in content_blocks:
        locator = block["locator"] if isinstance(block["locator"], dict) else {}
        section = locator.get("section_id") or locator.get("href_path")
        if section and section != current_section:
            current_section = section
            lines.extend([f"## {section}", ""])
        lines.extend([str(block["canonical_text"]).strip(), ""])
    return "\n".join(lines).rstrip() + "\n"


def _pdf_markdown(title: str, content_blocks: list[dict[str, object]]) -> str:
    lines = [f"# {title}", ""]
    for block in content_blocks:
        locator = block["locator"] if isinstance(block["locator"], dict) else {}
        page_label = locator.get("page_label") or locator.get("page_number")
        if page_label:
            lines.extend([f"## Page {page_label}", ""])
        lines.extend([str(block["canonical_text"]).strip(), ""])
    return "\n".join(lines).rstrip() + "\n"


def _joined_block_text(content_blocks: list[dict[str, object]]) -> str:
    return "\n\n".join(str(block["canonical_text"]) for block in content_blocks)


def _joined_fragment_html(fragments: list[Fragment]) -> str:
    return "\n".join(fragment.html_sanitized for fragment in fragments)


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
