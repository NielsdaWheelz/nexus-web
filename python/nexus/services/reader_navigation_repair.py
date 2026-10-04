"""Inspect and install metadata-only reader navigation repair from retained source."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal
from uuid import UUID

from lxml.html import HtmlElement, fragment_fromstring
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import EpubNavLocation, EpubTocNode, Media, ProcessingStatus, ReaderPublication
from nexus.ids import new_uuid7
from nexus.schemas.presence import Present, nullable_from_presence
from nexus.schemas.reader_apparatus import NoteRegion
from nexus.schemas.source_issues import (
    SOURCE_ISSUES,
    UnresolvedNavigationTarget,
    source_issues_payload,
)
from nexus.services.canonicalize import canonicalize_structure, generate_canonical_text
from nexus.services.content_indexing import request_media_content_reindex
from nexus.services.epub_ingest import (
    EpubNavigationRepairPlan,
    RetainedEpubFragment,
    prepare_epub_navigation_repair,
)
from nexus.services.html_apparatus import (
    accepted_apparatus_spans,
    attach_fragment_locators,
    derive_fragment_note_groups,
    extract_html_apparatus,
    prepare_apparatus_bodies,
)
from nexus.services.parser_temp import parser_attempt_directory, stream_storage_object_to_file
from nexus.services.reader_apparatus import (
    match_apparatus_source_items,
    note_regions_from_publication,
    read_note_regions,
    replace_media_apparatus,
)
from nexus.services.reader_publication import (
    PreserveSourceIssues,
    ReconcileNavigationSourceIssues,
    reconcile_navigation_source_issues,
    replace_reader_publication,
)
from nexus.services.sanitize_html import sanitize_html
from nexus.services.web_article_structure import build_web_article_index_blocks
from nexus.storage.client import StorageClient


@dataclass(frozen=True)
class ReaderNavigationRepairInspection:
    media_id: UUID
    kind: Literal["epub", "web_article"]
    generation: int
    source_sha256: str
    inspection_digest: str
    changed: bool
    sections_before: int
    sections_after: int
    toc_before: int
    toc_after: int
    groups_before: int
    groups_after: int
    section_changes: tuple[dict[str, object], ...]
    toc_changes: tuple[dict[str, object], ...]
    groups_before_values: tuple[dict[str, object], ...]
    groups_after_values: tuple[dict[str, object], ...]
    source_issues_before: tuple[dict[str, object], ...]
    source_issues_after: tuple[dict[str, object], ...]
    item_keys_added: tuple[str, ...]
    item_keys_removed: tuple[str, ...]
    item_keys_changed: tuple[str, ...]
    edge_keys_added: tuple[str, ...]
    edge_keys_removed: tuple[str, ...]
    edge_keys_changed: tuple[str, ...]


@dataclass(frozen=True)
class _Snapshot:
    media_id: UUID
    kind: Literal["epub", "web_article"]
    generation: int
    storage_path: str | None
    source_size_bytes: int | None
    source_sha256: str
    fragments: tuple[RetainedEpubFragment, ...]
    installed: dict[str, Any]


@dataclass(frozen=True)
class _Prepared:
    metadata: dict[str, Any]
    epub: EpubNavigationRepairPlan | None
    corrected_legacy_marker: tuple[str, str] | None = None


def inspect_reader_navigation_repair(
    *,
    session_factory: sessionmaker[Session],
    storage_client: StorageClient,
    media_id: UUID,
) -> ReaderNavigationRepairInspection:
    """Prepare from retained bytes without writing storage or database state."""
    snapshot = _read_snapshot(session_factory, media_id)
    prepared = _prepare(snapshot, storage_client)
    _check_snapshot_current(session_factory, snapshot)
    if prepared.corrected_legacy_marker is not None:
        with session_factory() as db:
            _assert_legacy_marker_unreferenced(
                db, snapshot.media_id, prepared.corrected_legacy_marker[0], lock=False
            )
    return _inspection(snapshot, prepared)


def apply_reader_navigation_repair(
    *,
    session_factory: sessionmaker[Session],
    storage_client: StorageClient,
    media_id: UUID,
    expected_inspection_digest: str,
    expected_generation: int,
) -> Literal["changed", "unchanged"]:
    """Consume exactly one inspected source/generation; stale work writes nothing."""
    snapshot = _read_snapshot(session_factory, media_id)
    if snapshot.generation != expected_generation:
        raise ValueError("Reader repair inspection is stale")
    prepared = _prepare(snapshot, storage_client)
    inspection = _inspection(snapshot, prepared)
    if inspection.inspection_digest != expected_inspection_digest:
        raise ValueError("Reader repair source or proposal differs from inspection")

    with session_factory() as db:
        media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
        publication = db.scalar(
            select(ReaderPublication)
            .where(ReaderPublication.media_id == media_id)
            .with_for_update()
        )
        if (
            media is None
            or publication is None
            or media.kind != snapshot.kind
            or media.processing_status != ProcessingStatus.ready_for_reading
            or int(publication.generation) != snapshot.generation
        ):
            raise ValueError("Reader repair inspection is stale")
        _check_locked_source(db, snapshot)
        if _installed_metadata(db, media_id, snapshot.kind) != snapshot.installed:
            raise ValueError("Reader repair metadata changed after inspection")
        if prepared.corrected_legacy_marker is not None:
            _assert_legacy_marker_unreferenced(
                db, media_id, prepared.corrected_legacy_marker[0], lock=True
            )
        if not inspection.changed:
            return "unchanged"

        def install(_media: Media) -> None:
            if snapshot.kind == "epub":
                assert prepared.epub is not None
                _install_epub_navigation(db, media_id, prepared.epub)
                items = list(prepared.epub.apparatus_items)
                edges = list(prepared.epub.apparatus_edges)
                groups = list(prepared.epub.note_groups)
            else:
                items = list(prepared.metadata["items"])
                edges = list(prepared.metadata["edges"])
                from nexus.schemas.reader_apparatus import NotesGroup

                groups = [NotesGroup.model_validate(group) for group in prepared.metadata["groups"]]
                request_media_content_reindex(db, media_id=media_id, reason="reconciliation")
            replace_media_apparatus(
                db,
                media_id=media_id,
                items=items,
                edges=edges,
                note_groups=groups,
                status="ready" if items else "empty",
            )

        replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind=snapshot.kind,
            replace_projection=install,
            issues=ReconcileNavigationSourceIssues()
            if snapshot.kind == "epub"
            else PreserveSourceIssues(),
        )
        if _installed_metadata(db, media_id, snapshot.kind) != prepared.metadata:
            raise ValueError("Reader repair installation differs from its inspected proposal")
        db.commit()
    return "changed"


def _read_snapshot(session_factory: sessionmaker[Session], media_id: UUID) -> _Snapshot:
    with session_factory() as db:
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        db.execute(text("SET TRANSACTION READ ONLY"))
        row = (
            db.execute(
                text(
                    "SELECT m.kind, m.processing_status, rp.generation, mf.storage_path,"
                    " mf.size_bytes, mf.source_sha256 FROM media m"
                    " JOIN reader_publications rp ON rp.media_id = m.id"
                    " LEFT JOIN media_file mf ON mf.media_id = m.id WHERE m.id = :media_id"
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one_or_none()
        )
        if row is None or row["kind"] not in {"epub", "web_article"}:
            raise ValueError("Reader repair requires a published EPUB or article")
        if row["processing_status"] != "ready_for_reading":
            raise ValueError("Reader repair requires ready media")
        kind: Literal["epub", "web_article"] = row["kind"]
        fragments = tuple(
            RetainedEpubFragment(
                id=item["id"],
                idx=int(item["idx"]),
                package_href=str(item["package_href"] or ""),
                html_sanitized=str(item["html_sanitized"]),
                canonical_text=str(item["canonical_text"]),
            )
            for item in db.execute(
                text(
                    "SELECT f.id, f.idx, f.html_sanitized, f.canonical_text,"
                    " efs.package_href FROM fragments f"
                    " LEFT JOIN epub_fragment_sources efs ON efs.fragment_id = f.id"
                    " WHERE f.media_id = :media_id ORDER BY f.idx"
                ),
                {"media_id": media_id},
            ).mappings()
        )
        if not fragments or tuple(item.idx for item in fragments) != tuple(range(len(fragments))):
            raise ValueError("Reader repair requires contiguous retained fragments")
        if kind == "epub":
            if not row["storage_path"] or not row["source_sha256"]:
                raise ValueError("Reader repair requires retained EPUB source")
            source_sha256 = str(row["source_sha256"])
        else:
            source_sha256 = _article_source_sha256(fragments)
        return _Snapshot(
            media_id=media_id,
            kind=kind,
            generation=int(row["generation"]),
            storage_path=str(row["storage_path"]) if row["storage_path"] else None,
            source_size_bytes=int(row["size_bytes"]) if row["size_bytes"] is not None else None,
            source_sha256=source_sha256,
            fragments=fragments,
            installed=_installed_metadata(db, media_id, kind),
        )


def _align_apparatus_keys(
    installed: Sequence[dict[str, object]],
    proposed_items: Sequence[dict[str, object]],
    proposed_edges: Sequence[dict[str, object]],
) -> tuple[tuple[dict[str, object], ...], tuple[dict[str, object], ...]]:
    """Use stored identities before the repair's no-deletion inspection."""
    matches = match_apparatus_source_items(installed, proposed_items)
    items = tuple(
        {**item, "stable_key": matches.get(str(item["stable_key"]), str(item["stable_key"]))}
        for item in proposed_items
    )
    if len({str(item["stable_key"]) for item in items}) != len(items):
        raise ValueError("Reader repair has ambiguous source item correspondence")
    edges = tuple(
        {
            **edge,
            "from_stable_key": matches.get(
                str(edge["from_stable_key"]), str(edge["from_stable_key"])
            ),
            "to_stable_key": matches.get(str(edge["to_stable_key"]), str(edge["to_stable_key"])),
        }
        for edge in proposed_edges
    )
    for edge in edges:
        edge["stable_key"] = f"{edge['from_stable_key']}->{edge['to_stable_key']}"
    if len({str(edge["stable_key"]) for edge in edges}) != len(edges):
        raise ValueError("Reader repair has ambiguous source edge correspondence")
    return items, edges


def _prepare(snapshot: _Snapshot, storage_client: StorageClient) -> _Prepared:
    if snapshot.kind == "epub":
        assert snapshot.storage_path is not None and snapshot.source_size_bytes is not None
        with parser_attempt_directory(new_uuid7()) as directory:
            source_path = directory / "source.epub"
            stream_storage_object_to_file(
                storage_client,
                storage_path=snapshot.storage_path,
                destination=source_path,
                expected_size_bytes=snapshot.source_size_bytes,
                expected_source_sha256=snapshot.source_sha256,
            )
            plan = prepare_epub_navigation_repair(
                epub_path=source_path,
                media_id=snapshot.media_id,
                storage_path=snapshot.storage_path,
                retained_fragments=snapshot.fragments,
            )
        aligned_items, aligned_edges = _align_apparatus_keys(
            snapshot.installed["items"], plan.apparatus_items, plan.apparatus_edges
        )
        installed_by_key = {str(item["stable_key"]): item for item in snapshot.installed["items"]}
        preserved_items: list[dict[str, object]] = []
        for item in aligned_items:
            installed = installed_by_key.get(str(item["stable_key"]))
            if installed is None or installed.get("locator_status") != "exact":
                preserved_items.append(item)
                continue
            old_source = installed.get("source_ref")
            new_source = item.get("source_ref")
            if (
                installed.get("kind") != item.get("kind")
                or not isinstance(old_source, dict)
                or not isinstance(new_source, dict)
                or any(
                    old_source.get(field) != new_source.get(field)
                    for field in ("format", "package_href", "target_id", "marker_id")
                )
                or (
                    old_source.get("target_href") != new_source.get("target_href")
                    and not (
                        old_source.get("target_href") is None
                        and new_source.get("target_href") == old_source.get("package_href")
                    )
                )
            ):
                raise ValueError("Reader repair existing apparatus source correspondence changed")
            if (
                installed.get("body_text") == item.get("body_text")
                and isinstance(installed.get("body_html_sanitized"), str)
                and isinstance(item.get("body_html_sanitized"), str)
                and generate_canonical_text(str(installed["body_html_sanitized"]))
                == installed["body_text"]
                and generate_canonical_text(str(item["body_html_sanitized"])) == item["body_text"]
                and (old_span := _exact_epub_span(snapshot, installed)) is not None
                and (new_span := _exact_epub_span(snapshot, item)) is not None
                and old_span[:2] == new_span[:2]
            ):
                preserved_items.append(installed)
            elif installed.get("locator") == item.get("locator"):
                preserved_items.append(item)
            elif _exact_epub_label_body_correction(snapshot, installed, item):
                preserved_items.append(
                    {**item, "locator": installed["locator"], "source_ref": old_source}
                )
            else:
                raise ValueError("Reader repair existing apparatus source correspondence changed")
        plan = replace(plan, apparatus_items=tuple(preserved_items), apparatus_edges=aligned_edges)
        fresh_keys = {str(item["stable_key"]) for item in plan.apparatus_items}
        # A fresh import only emits reciprocally proved bodies. Repair also keeps
        # older unlinked body identities when exact retained text lies wholly in
        # a newly proved note collection; it never invents a new body from that rule.
        retained_items = [
            item
            for item in snapshot.installed["items"]
            if str(item["stable_key"]) not in fresh_keys
        ]
        fresh_edge_keys = {str(edge["stable_key"]) for edge in plan.apparatus_edges}
        retained_edges = [
            edge
            for edge in snapshot.installed["edges"]
            if str(edge["stable_key"]) not in fresh_edge_keys
        ]
        legacy_ref = next(
            (
                item
                for item in retained_items
                if str(item["stable_key"]) == "epub:8:ref:000001:fn1_1"
                and snapshot.media_id == UUID("09f34c39-5c2c-481a-a713-9d83f7bbf320")
            ),
            None,
        )
        if legacy_ref is not None:
            if not _verified_0245_legacy_backlink(snapshot, plan, legacy_ref):
                raise ValueError("Stored EPUB legacy backlink no longer matches its source")
            retained_items = [item for item in retained_items if item is not legacy_ref]
        correction = _reciprocal_marker_correction(snapshot, plan, retained_items, retained_edges)
        if correction is None and legacy_ref is not None:
            correction = _specific_0245_bad_target(snapshot, plan, retained_items, retained_edges)
        if correction is not None:
            retained_items = []
            retained_edges = []
        if any(not _preservable_epub_note_body(snapshot, plan, item) for item in retained_items):
            raise ValueError("Stored EPUB apparatus item cannot be preserved as a note body")
        if legacy_ref is not None:
            retained_items.append(legacy_ref)
        plan = replace(
            plan,
            apparatus_items=(*plan.apparatus_items, *retained_items),
            apparatus_edges=(*plan.apparatus_edges, *retained_edges),
        )
        metadata = _epub_metadata(plan)
        metadata["source_issues"] = source_issues_payload(
            reconcile_navigation_source_issues(
                SOURCE_ISSUES.validate_python(snapshot.installed["source_issues"]),
                [
                    issue
                    for issue in plan.source_issues
                    if isinstance(issue, UnresolvedNavigationTarget)
                ],
            )
        )
        return _Prepared(metadata, plan, correction)

    from nexus.schemas.reader_apparatus import NotesGroup

    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    groups: list[NotesGroup] = []
    for fragment in snapshot.fragments:
        marked, extracted_items, extracted_edges = extract_html_apparatus(
            fragment.html_sanitized,
            source_kind=f"web:{fragment.idx}",
            source_ref={"format": "html", "fragment_idx": fragment.idx},
        )
        marked_structure = canonicalize_structure(marked)
        if marked_structure.text != fragment.canonical_text:
            raise ValueError("Stored article HTML disagrees with canonical text")
        marked_spans = accepted_apparatus_spans(marked_structure, fragment.canonical_text)
        stored_structure = canonicalize_structure(fragment.html_sanitized)
        stored_spans = accepted_apparatus_spans(stored_structure, fragment.canonical_text)
        prepare_apparatus_bodies(
            extracted_items,
            sanitize=lambda body: sanitize_html(body, "", document_url=""),
            media_kind="web_article",
        )
        items.extend(
            attach_fragment_locators(
                media_id=snapshot.media_id,
                fragment_id=fragment.id,
                media_kind="web_article",
                canonical_text=fragment.canonical_text,
                items=extracted_items,
                accepted_spans=marked_spans,
                html_sanitized=marked,
            )
        )
        edges.extend(extracted_edges)
        groups.extend(
            derive_fragment_note_groups(
                fragment.html_sanitized,
                fragment.canonical_text,
                fragment.id,
                structure=stored_structure,
                accepted_spans=stored_spans,
            )
        )
    aligned_items, aligned_edges = _align_apparatus_keys(snapshot.installed["items"], items, edges)
    retained_items = {str(item["stable_key"]): item for item in snapshot.installed["items"]}
    retained_items.update({str(item["stable_key"]): item for item in aligned_items})
    retained_edges = {str(edge["stable_key"]): edge for edge in snapshot.installed["edges"]}
    retained_edges.update({str(edge["stable_key"]): edge for edge in aligned_edges})

    derived_groups = groups
    retained_groups = [NotesGroup.model_validate(group) for group in snapshot.installed["groups"]]
    derived_group_keys = {_digest(group.model_dump(mode="json")) for group in derived_groups}
    declared_groups = [group for group in retained_groups if group.provenance == "Declared"]
    groups = [
        group
        for group in retained_groups
        if group.provenance == "Declared"
        or not any(
            declared.range == group.range and declared.heading == group.heading
            for declared in declared_groups
        )
    ]
    if any(
        _digest(group.model_dump(mode="json")) not in derived_group_keys
        for group in groups
        if group.provenance != "Declared"
    ):
        raise ValueError("Stored inferred article note group cannot be proved from retained HTML")
    retained_group_keys = {_digest(group.model_dump(mode="json")) for group in retained_groups}
    for group in derived_groups:
        if _digest(group.model_dump(mode="json")) in retained_group_keys:
            continue
        if any(
            declared.range.start.fragment_id == group.range.start.fragment_id
            and declared.range.start.offset <= group.range.start.offset
            and group.range.end.offset <= declared.range.end.offset
            for declared in declared_groups
        ):
            continue
        groups.append(group)
    items = list(retained_items.values())
    edges = list(retained_edges.values())
    metadata = _apparatus_metadata(items, edges, groups)
    metadata["source_issues"] = snapshot.installed["source_issues"]
    metadata.update(
        _web_navigation_metadata(snapshot.fragments, note_regions_from_publication(items, groups))
    )
    return _Prepared(metadata, None)


def _reciprocal_marker_correction(
    snapshot: _Snapshot,
    plan: EpubNavigationRepairPlan,
    missing_items: list[dict[str, object]],
    missing_edges: list[dict[str, object]],
) -> tuple[str, str] | None:
    """Recognize one historical marker mistaken for a note body."""
    if len(missing_items) != 1 or len(missing_edges) != 1:
        return None
    old_body, old_edge = missing_items[0], missing_edges[0]
    old_key, old_edge_key = str(old_body["stable_key"]), str(old_edge["stable_key"])
    old_items = {str(item["stable_key"]): item for item in snapshot.installed["items"]}
    fresh_items = {str(item["stable_key"]): item for item in plan.apparatus_items}
    old_ref = old_items.get(str(old_edge["from_stable_key"]))
    fresh_ref = fresh_items.get(str(old_edge["from_stable_key"]))
    if (
        old_body.get("kind") != "footnote"
        or old_edge.get("to_stable_key") != old_key
        or old_edge.get("relation") != "points_to_note"
        or old_ref is None
        or old_ref.get("kind") != "footnote_ref"
        or fresh_ref is None
        or any(fresh_ref.get(field) != value for field, value in old_ref.items())
    ):
        return None
    old_ref_span = _exact_epub_span(snapshot, old_ref)
    old_body_span = _exact_epub_span(snapshot, old_body)
    if (
        old_ref_span is None
        or old_body_span is None
        or old_ref_span[0] != old_body_span[0]
        or old_ref_span[2] - old_ref_span[1] != 1
        or old_body_span[2] - old_body_span[1] != 1
    ):
        return None
    other_refs = [
        item
        for item in plan.apparatus_items
        if item.get("kind") == "footnote_ref" and _exact_epub_span(snapshot, item) == old_body_span
    ]
    if len(other_refs) != 1:
        return None
    other_ref = other_refs[0]
    source_a, source_b, old_source = (
        old_ref.get("source_ref"),
        other_ref.get("source_ref"),
        old_body.get("source_ref"),
    )
    if (
        not isinstance(source_a, dict)
        or not isinstance(source_b, dict)
        or not isinstance(old_source, dict)
    ):
        return None
    old_body_locator = old_body.get("locator")
    old_body_quote = (
        old_body_locator.get("text_quote_selector") if isinstance(old_body_locator, dict) else None
    )
    if not isinstance(old_body_quote, dict) or old_body.get("body_text") != old_body_quote.get(
        "exact"
    ):
        return None
    marker_a, target_a = source_a.get("marker_id"), source_a.get("target_id")
    marker_b, target_b = source_b.get("marker_id"), source_b.get("target_id")
    if (
        not all(
            isinstance(value, str) and value for value in (marker_a, target_a, marker_b, target_b)
        )
        or marker_a == marker_b
        or target_a != marker_b
        or target_b != marker_a
        or old_source.get("target_id") != target_a
    ):
        return None
    fragment = next((part for part in snapshot.fragments if part.id == old_ref_span[0]), None)
    if fragment is None:
        return None
    root = fragment_fromstring(fragment.html_sanitized, create_parent=True)
    for marker_id, target_id in ((marker_a, target_a), (marker_b, target_b)):
        anchors = root.xpath(".//a[@id=$value or @name=$value]", value=marker_id)
        if len(anchors) != 1:
            return None
        anchor = anchors[0]
        if (
            not isinstance(anchor, HtmlElement)
            or anchor.get("href") != f"#{target_id}"
            or anchor.getparent() is None
            or anchor.getparent().tag != "sup"
            or any(anchor.get(name) for name in ("class", "role", "epub:type"))
        ):
            return None
    bodies: list[tuple[UUID, int, int]] = []
    for ref, target_id, marker_span in (
        (old_ref, target_a, old_body_span),
        (other_ref, target_b, old_ref_span),
    ):
        matching_edges = [
            edge
            for edge in plan.apparatus_edges
            if edge.get("from_stable_key") == ref["stable_key"]
            and edge.get("relation") == "points_to_note"
        ]
        if len(matching_edges) != 1:
            return None
        body = fresh_items.get(str(matching_edges[0]["to_stable_key"]))
        if body is None or body.get("kind") != "footnote":
            return None
        body_source = body.get("source_ref")
        body_span = _exact_epub_span(snapshot, body)
        if (
            not isinstance(body_source, dict)
            or body_source.get("target_id") != target_id
            or body_span is None
            or body_span[0] != marker_span[0]
            or not body_span[1] <= marker_span[1] < marker_span[2] <= body_span[2]
            or body_span[2] - body_span[1] <= 1
            or sum(char.isalnum() for char in fragment.canonical_text[body_span[1] : body_span[2]])
            < 2
        ):
            return None
        bodies.append(body_span)
    if bodies[0][1] < bodies[1][2] and bodies[1][1] < bodies[0][2]:
        return None
    return old_key, old_edge_key


def _verified_0245_legacy_backlink(
    snapshot: _Snapshot, plan: EpubNavigationRepairPlan, item: dict[str, object]
) -> bool:
    """Keep the one authored return link after correcting its false note target."""
    if (
        snapshot.source_sha256 != "74fa6340b64edcb05cd2738993354155f00552d0dcd1b19344cd31bc5a3fa3c9"
        or item.get("stable_key") != "epub:8:ref:000001:fn1_1"
        or item.get("kind") != "footnote_ref"
        or item.get("label") != "1"
        or _exact_epub_span(snapshot, item)
        != (UUID("719ad69f-afb0-4552-af64-bcc34f315acf"), 13012, 13013)
    ):
        return False
    source = item.get("source_ref")
    if not isinstance(source, dict) or (source.get("marker_id"), source.get("target_id")) != (
        "fn1_11",
        "fn1_1",
    ):
        return False
    fragment = next(
        part
        for part in snapshot.fragments
        if part.id == UUID("719ad69f-afb0-4552-af64-bcc34f315acf")
    )
    root = fragment_fromstring(fragment.html_sanitized, create_parent=True)
    backlinks = root.xpath(".//a[@id='fn1_11' and @href='#fn1_1']")
    inline = root.xpath(".//a[@id='fn1_1' and @href='#fn1_11']")
    if (
        len(backlinks) != 1
        or len(inline) != 1
        or backlinks[0].getparent().tag != "sup"
        or inline[0].getparent().tag != "sup"
    ):
        return False
    target_key = "epub:8:target:OPS-xhtml-chapter002.html-fn1_11"
    target = next(
        (candidate for candidate in plan.apparatus_items if candidate["stable_key"] == target_key),
        None,
    )
    target_span = _exact_epub_span(snapshot, target) if target is not None else None
    return bool(
        target is not None
        and target.get("kind") == "footnote"
        and target_span is not None
        and target_span[0] == fragment.id
        and target_span[1] <= 13012 < 13013 <= target_span[2]
        and any(
            edge.get("from_stable_key") == "epub:8:ref:000000:fn1_11"
            and edge.get("to_stable_key") == target_key
            and edge.get("relation") == "points_to_note"
            for edge in plan.apparatus_edges
        )
    )


def _specific_0245_bad_target(
    snapshot: _Snapshot,
    plan: EpubNavigationRepairPlan,
    missing_items: list[dict[str, object]],
    missing_edges: list[dict[str, object]],
) -> tuple[str, str] | None:
    """Remove only the false main-text note installed before source-note repair."""
    key = "epub:8:target:fn1_1"
    edge_key = "epub:8:ref:000001:fn1_1->epub:8:target:fn1_1"
    if (
        snapshot.media_id != UUID("09f34c39-5c2c-481a-a713-9d83f7bbf320")
        or snapshot.source_sha256
        != "74fa6340b64edcb05cd2738993354155f00552d0dcd1b19344cd31bc5a3fa3c9"
        or len(missing_items) != 1
        or len(missing_edges) != 1
        or any(item["stable_key"] == key for item in plan.apparatus_items)
    ):
        return None
    body, edge = missing_items[0], missing_edges[0]
    source = body.get("source_ref")
    text_value = body.get("body_text")
    if (
        body.get("stable_key") != key
        or body.get("kind") != "footnote"
        or body.get("body_html_sanitized") is not None
        or not isinstance(text_value, str)
        or hashlib.sha256(text_value.encode()).hexdigest()
        != "016d113ac52d4c56ba03cccab3cecacf56e591c2f38554ba6c34e9aade5af138"
        or _exact_epub_span(snapshot, body)
        != (UUID("719ad69f-afb0-4552-af64-bcc34f315acf"), 6212, 6854)
        or not isinstance(source, dict)
        or source.get("target_id") != "fn1_1"
        or edge.get("stable_key") != edge_key
        or edge.get("from_stable_key") != "epub:8:ref:000001:fn1_1"
        or edge.get("to_stable_key") != key
        or edge.get("relation") != "points_to_note"
    ):
        return None
    return key, edge_key


def _exact_epub_span(snapshot: _Snapshot, item: dict[str, object]) -> tuple[UUID, int, int] | None:
    if item.get("locator_status") != "exact":
        return None
    locator = item.get("locator")
    if (
        not isinstance(locator, dict)
        or locator.get("type") != "epub_fragment_offsets"
        or locator.get("media_id") != str(snapshot.media_id)
        or locator.get("media_kind") not in (None, "epub")
    ):
        return None
    fragment = next(
        (part for part in snapshot.fragments if str(part.id) == locator.get("fragment_id")), None
    )
    start, end, quote = (
        locator.get("start_offset"),
        locator.get("end_offset"),
        locator.get("text_quote_selector"),
    )
    if (
        fragment is None
        or type(start) is not int
        or type(end) is not int
        or not 0 <= start < end <= len(fragment.canonical_text)
        or not isinstance(quote, dict)
        or fragment.canonical_text[start:end] != quote.get("exact")
    ):
        return None
    return fragment.id, start, end


def _exact_epub_label_body_correction(
    snapshot: _Snapshot, installed: dict[str, object], proposed: dict[str, object]
) -> bool:
    """Correct a numeric-only legacy body at its unchanged authored target."""
    old_span = _exact_epub_span(snapshot, installed)
    new_span = _exact_epub_span(snapshot, proposed)
    old_text = installed.get("body_text")
    new_text = proposed.get("body_text")
    old_html = installed.get("body_html_sanitized")
    new_html = proposed.get("body_html_sanitized")
    new_locator = proposed.get("locator")
    if (
        installed.get("kind") not in {"footnote", "endnote", "bibliography_entry"}
        or old_span is None
        or new_span is None
        or old_span[:2] != new_span[:2]
        or not isinstance(old_text, str)
        or not old_text.isdecimal()
        or not 1 <= len(old_text) <= 4
        or not isinstance(new_text, str)
        or not new_text.startswith(old_text)
        or len(new_text) <= len(old_text)
        or new_text[len(old_text)].isdecimal()
        or not isinstance(old_html, str)
        or not isinstance(new_html, str)
        or not isinstance(new_locator, dict)
        or generate_canonical_text(old_html) != old_text
        or generate_canonical_text(new_html) != new_text
    ):
        return False
    fragment = next(part for part in snapshot.fragments if part.id == old_span[0])
    old_quote = fragment.canonical_text[old_span[1] : old_span[2]]
    new_quote = fragment.canonical_text[new_span[1] : new_span[2]]
    return bool(
        old_quote == old_text
        and new_quote == (new_locator.get("text_quote_selector") or {}).get("exact")
        and new_quote in (new_text, new_text + "\n\n")
    )


def _assert_legacy_marker_unreferenced(
    db: Session, media_id: UUID, stable_key: str, *, lock: bool
) -> None:
    # These scheme/id references have no FK to the apparatus item. A SHARE lock
    # excludes concurrent inserts until the exceptional deletion commits.
    if lock:
        db.execute(
            text(
                "LOCK TABLE chat_run_turn_contexts, message_retrievals, resource_edges,"
                " resource_grants, resource_versions, resource_view_states"
                " IN SHARE MODE NOWAIT"
            )
        )
    row = db.execute(
        text(
            "SELECT id FROM reader_apparatus_items"
            " WHERE media_id = :media_id AND stable_key = :stable_key"
            + (" FOR UPDATE" if lock else "")
        ),
        {"media_id": media_id, "stable_key": stable_key},
    ).one_or_none()
    if row is None:
        raise ValueError("Legacy marker correction is stale")
    item_id = row.id
    checks = (
        (
            "SELECT 1 FROM resource_edges WHERE"
            " (source_scheme = 'reader_apparatus_item' AND source_id = :id) OR"
            " (target_scheme = 'reader_apparatus_item' AND target_id = :id) LIMIT 1",
            {"id": item_id},
        ),
        (
            "SELECT 1 FROM message_retrievals WHERE"
            " result_type = 'reader_apparatus_item' AND source_id = :id LIMIT 1",
            {"id": str(item_id)},
        ),
        (
            "SELECT 1 FROM resource_view_states WHERE"
            " (surface_scheme = 'reader_apparatus_item' AND surface_id = :id) OR"
            " (target_scheme = 'reader_apparatus_item' AND target_id = :id) LIMIT 1",
            {"id": item_id},
        ),
        (
            "SELECT 1 FROM resource_versions WHERE"
            " resource_scheme = 'reader_apparatus_item' AND resource_id = :id LIMIT 1",
            {"id": item_id},
        ),
        (
            "SELECT 1 FROM resource_grants WHERE"
            " subject_scheme = 'reader_apparatus_item' AND subject_id = :id LIMIT 1",
            {"id": item_id},
        ),
        (
            "SELECT 1 FROM chat_run_turn_contexts WHERE"
            " (subject_scheme = 'reader_apparatus_item' AND subject_id = :id) OR"
            " (requested_subject_scheme = 'reader_apparatus_item'"
            " AND requested_subject_id = :id) LIMIT 1",
            {"id": item_id},
        ),
    )
    if any(db.scalar(text(query), params) is not None for query, params in checks):
        raise ValueError("Legacy marker correction would remove a referenced apparatus item")


def _preservable_epub_note_body(
    snapshot: _Snapshot, plan: EpubNavigationRepairPlan, item: dict[str, object]
) -> bool:
    """Carry an old exact body only inside a newly proved collection."""
    if item.get("kind") not in {"footnote", "endnote"} or item.get("locator_status") != "exact":
        return False
    locator = item.get("locator")
    if not isinstance(locator, dict) or locator.get("type") != "epub_fragment_offsets":
        return False
    if locator.get("media_id") != str(snapshot.media_id):
        return False
    fragment = next(
        (part for part in snapshot.fragments if str(part.id) == locator.get("fragment_id")), None
    )
    start, end = locator.get("start_offset"), locator.get("end_offset")
    quote = locator.get("text_quote_selector")
    if (
        fragment is None
        or type(start) is not int
        or type(end) is not int
        or not 0 <= start < end <= len(fragment.canonical_text)
        or not isinstance(quote, dict)
        or not isinstance(quote.get("exact"), str)
        or item.get("body_text") != quote["exact"]
        or fragment.canonical_text[start:end] != quote["exact"]
    ):
        return False
    order = {part.id: part.idx for part in snapshot.fragments}
    point = (fragment.idx, start)
    stop = (fragment.idx, end)
    return any(
        group.range.start.fragment_id in order
        and group.range.end.fragment_id in order
        and (order[group.range.start.fragment_id], group.range.start.offset) <= point
        and stop <= (order[group.range.end.fragment_id], group.range.end.offset)
        for group in plan.note_groups
    )


def _exact_epub_body_enrichment(
    snapshot: _Snapshot, installed: dict[str, object], proposed: dict[str, object]
) -> bool:
    """Accept proved source bodies at unchanged target coordinates."""
    if snapshot.kind != "epub" or installed.get("kind") not in {
        "footnote",
        "endnote",
        "bibliography_entry",
    }:
        return False
    html = proposed.get("body_html_sanitized")
    text_value = proposed.get("body_text")
    locator = proposed.get("locator")
    if (
        not isinstance(html, str)
        or not html.strip()
        or not isinstance(text_value, str)
        or not text_value
        or not isinstance(locator, dict)
        or locator.get("type") != "epub_fragment_offsets"
        or locator.get("media_id") != str(snapshot.media_id)
        or generate_canonical_text(html) != text_value
    ):
        return False
    fragment = next(
        (part for part in snapshot.fragments if str(part.id) == locator.get("fragment_id")), None
    )
    start, end = locator.get("start_offset"), locator.get("end_offset")
    quote = locator.get("text_quote_selector")
    anchored = bool(
        fragment is not None
        and type(start) is int
        and type(end) is int
        and 0 <= start < end <= len(fragment.canonical_text)
        and isinstance(quote, dict)
        and quote.get("exact") == fragment.canonical_text[start:end]
    )
    if not anchored:
        return False
    assert fragment is not None and type(start) is int and type(end) is int
    assert isinstance(quote, dict)
    if installed.get("body_html_sanitized") is None:
        old_source = installed.get("source_ref")
        new_source = proposed.get("source_ref")
        return bool(
            quote.get("exact") == text_value
            or (
                installed.get("body_text") == text_value
                and installed.get("locator") == locator
                and isinstance(old_source, dict)
                and isinstance(new_source, dict)
                and all(
                    old_source.get(field) == new_source.get(field)
                    for field in ("format", "package_href", "target_id")
                )
            )
        )
    old_html = installed.get("body_html_sanitized")
    old_text = installed.get("body_text")
    if (
        not isinstance(old_html, str)
        or not isinstance(old_text, str)
        or not old_text.isdecimal()
        or not 1 <= len(old_text) <= 4
        or generate_canonical_text(old_html) != old_text
        or quote.get("exact") != old_text
        or not text_value.startswith(old_text)
        or len(text_value) <= len(old_text)
        or text_value[len(old_text)].isdecimal()
        or fragment.canonical_text[start : start + len(text_value)] != text_value
    ):
        return False
    return fragment.canonical_text[start + len(text_value) : start + len(text_value) + 2] in (
        "",
        "\n\n",
    )


def _inspection(snapshot: _Snapshot, prepared: _Prepared) -> ReaderNavigationRepairInspection:
    old = snapshot.installed
    new = prepared.metadata
    old_item_keys = {str(item["stable_key"]) for item in old["items"]}
    new_item_keys = {str(item["stable_key"]) for item in new["items"]}
    old_edge_keys = {str(edge["stable_key"]) for edge in old["edges"]}
    new_edge_keys = {str(edge["stable_key"]) for edge in new["edges"]}
    removed_items = old_item_keys - new_item_keys
    removed_edges = old_edge_keys - new_edge_keys
    correction = prepared.corrected_legacy_marker
    if (removed_items or removed_edges) and (
        correction is None or removed_items != {correction[0]} or removed_edges != {correction[1]}
    ):
        raise ValueError("Reader repair would remove existing apparatus identities or edges")
    new_items = {str(item["stable_key"]): item for item in new["items"]}
    old_items = {str(item["stable_key"]): item for item in old["items"]}
    for item in old["items"]:
        if str(item["stable_key"]) in removed_items:
            continue
        proposed = new_items[str(item["stable_key"])]
        if item["kind"] != proposed["kind"]:
            raise ValueError("Reader repair would change an existing apparatus item's kind")
        if item["locator_status"] == "exact":
            if proposed["locator_status"] != "exact" or item["locator"] != proposed["locator"]:
                raise ValueError("Reader repair would change an existing anchored apparatus item")
            if (
                item["body_text"] != proposed["body_text"]
                or item["body_html_sanitized"] != proposed["body_html_sanitized"]
            ) and not _exact_epub_body_enrichment(snapshot, item, proposed):
                raise ValueError("Reader repair would change an existing anchored apparatus item")
    new_edges = {str(edge["stable_key"]): edge for edge in new["edges"]}
    old_edges = {str(edge["stable_key"]): edge for edge in old["edges"]}
    for edge in old["edges"]:
        if str(edge["stable_key"]) in removed_edges:
            continue
        proposed = new_edges[str(edge["stable_key"])]
        if any(
            edge[field] != proposed[field]
            for field in ("from_stable_key", "to_stable_key", "relation")
        ):
            raise ValueError("Reader repair would redirect an existing apparatus edge")
    return ReaderNavigationRepairInspection(
        media_id=snapshot.media_id,
        kind=snapshot.kind,
        generation=snapshot.generation,
        source_sha256=snapshot.source_sha256,
        inspection_digest=_digest(
            [
                str(snapshot.media_id),
                snapshot.kind,
                snapshot.generation,
                snapshot.source_sha256,
                snapshot.storage_path,
                snapshot.source_size_bytes,
                _digest(
                    [
                        (
                            str(fragment.id),
                            fragment.idx,
                            fragment.package_href,
                            fragment.html_sanitized,
                            fragment.canonical_text,
                        )
                        for fragment in snapshot.fragments
                    ]
                ),
                old,
                new,
            ]
        ),
        changed=old != new,
        sections_before=len(old["sections"]),
        sections_after=len(new["sections"]),
        toc_before=len(old["toc"]),
        toc_after=len(new["toc"]),
        groups_before=len(old["groups"]),
        groups_after=len(new["groups"]),
        section_changes=_row_changes(old["sections"], new["sections"], "location_id"),
        toc_changes=_row_changes(old["toc"], new["toc"], "node_id"),
        groups_before_values=tuple(old["groups"]) if old["groups"] != new["groups"] else (),
        groups_after_values=tuple(new["groups"]) if old["groups"] != new["groups"] else (),
        source_issues_before=tuple(old["source_issues"]),
        source_issues_after=tuple(new["source_issues"]),
        item_keys_added=tuple(sorted(new_item_keys - old_item_keys)),
        item_keys_removed=tuple(sorted(removed_items)),
        item_keys_changed=tuple(
            sorted(key for key in old_item_keys & new_item_keys if old_items[key] != new_items[key])
        ),
        edge_keys_added=tuple(sorted(new_edge_keys - old_edge_keys)),
        edge_keys_removed=tuple(sorted(removed_edges)),
        edge_keys_changed=tuple(
            sorted(key for key in old_edge_keys & new_edge_keys if old_edges[key] != new_edges[key])
        ),
    )


def _row_changes(
    old: list[dict[str, object]], new: list[dict[str, object]], key: str
) -> tuple[dict[str, object], ...]:
    before = {str(row[key]): row for row in old}
    after = {str(row[key]): row for row in new}
    return tuple(
        {"id": row_id, "before": before.get(row_id), "after": after.get(row_id)}
        for row_id in sorted(before.keys() | after.keys())
        if before.get(row_id) != after.get(row_id)
    )


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()


def _article_source_sha256(fragments: tuple[RetainedEpubFragment, ...]) -> str:
    digest = hashlib.sha256()
    for fragment in fragments:
        data = fragment.html_sanitized.encode("utf-8")
        if len(fragments) > 1:
            digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def _check_snapshot_current(session_factory: sessionmaker[Session], snapshot: _Snapshot) -> None:
    with session_factory() as db:
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        db.execute(text("SET TRANSACTION READ ONLY"))
        row = db.execute(
            text(
                "SELECT rp.generation, mf.source_sha256 FROM reader_publications rp"
                " LEFT JOIN media_file mf ON mf.media_id = rp.media_id"
                " WHERE rp.media_id = :media_id"
            ),
            {"media_id": snapshot.media_id},
        ).one_or_none()
        if row is None or int(row.generation) != snapshot.generation:
            raise ValueError("Reader repair source changed during inspection")
        if snapshot.kind == "epub" and row.source_sha256 != snapshot.source_sha256:
            raise ValueError("Reader repair source changed during inspection")


def _check_locked_source(db: Session, snapshot: _Snapshot) -> None:
    row = db.execute(
        text(
            "SELECT storage_path, size_bytes, source_sha256 FROM media_file"
            " WHERE media_id = :media_id"
        ),
        {"media_id": snapshot.media_id},
    ).one_or_none()
    if snapshot.kind == "epub" and (
        row is None
        or row.storage_path != snapshot.storage_path
        or int(row.size_bytes) != snapshot.source_size_bytes
        or row.source_sha256 != snapshot.source_sha256
    ):
        raise ValueError("Reader repair source changed after inspection")
    rows = db.execute(
        text(
            "SELECT f.id, f.idx, f.html_sanitized, f.canonical_text, efs.package_href"
            " FROM fragments f LEFT JOIN epub_fragment_sources efs ON efs.fragment_id = f.id"
            " WHERE f.media_id = :media_id ORDER BY f.idx"
        ),
        {"media_id": snapshot.media_id},
    ).all()
    current = tuple(
        RetainedEpubFragment(
            r.id, int(r.idx), str(r.package_href or ""), r.html_sanitized, r.canonical_text
        )
        for r in rows
    )
    if current != snapshot.fragments:
        raise ValueError("Reader repair fragments changed after inspection")


def _apparatus_metadata(
    items: list[dict[str, object]], edges: list[dict[str, object]], groups: Sequence[Any]
) -> dict[str, Any]:
    item_fields = (
        "stable_key",
        "kind",
        "label",
        "body_text",
        "body_html_sanitized",
        "locator",
        "locator_status",
        "confidence",
        "extraction_method",
        "source_ref",
        "sort_key",
    )
    edge_fields = (
        "stable_key",
        "from_stable_key",
        "to_stable_key",
        "relation",
        "confidence",
        "extraction_method",
        "source_ref",
        "sort_key",
    )
    return {
        "status": "ready" if items else "empty",
        "items": sorted(
            ({key: item.get(key) for key in item_fields} for item in items),
            key=lambda item: str(item["stable_key"]),
        ),
        "edges": sorted(
            ({key: edge.get(key) for key in edge_fields} for edge in edges),
            key=lambda edge: str(edge["stable_key"]),
        ),
        "groups": [
            group.model_dump(mode="json") if hasattr(group, "model_dump") else group
            for group in groups
        ],
        "toc": [],
        "sections": [],
    }


def _epub_metadata(plan: EpubNavigationRepairPlan) -> dict[str, Any]:
    metadata = _apparatus_metadata(
        list(plan.apparatus_items), list(plan.apparatus_edges), list(plan.note_groups)
    )
    metadata["toc"] = sorted(
        (
            {
                "node_id": node.node_id,
                "nav_type": node.nav_type,
                "parent_node_id": node.parent_node_id,
                "label": node.label,
                "href": node.href,
                "fragment_idx": node.fragment_idx,
                "target_offset": node.target_offset,
                "section_id": node.section_id,
                "resolution": node.resolution,
                "depth": node.depth,
                "order_key": node.order_key,
            }
            for node in plan.toc_nodes
        ),
        key=lambda node: str(node["node_id"]),
    )
    metadata["sections"] = sorted(
        (
            {
                "location_id": section.location_id,
                "ordinal": ordinal,
                "parent_section_id": nullable_from_presence(section.parent_section_id),
                "label": section.label,
                "fragment_idx": section.fragment_idx,
                "href_path": section.href_path,
                "href_fragment": nullable_from_presence(section.href_fragment),
                "start_offset": section.start_offset,
                "end_fragment_idx": section.end.value.fragment_idx
                if isinstance(section.end, Present)
                else None,
                "end_offset": section.end.value.offset
                if isinstance(section.end, Present)
                else None,
                "source": section.source,
            }
            for ordinal, section in enumerate(plan.nav_locations)
        ),
        key=lambda section: str(section["location_id"]),
    )
    return metadata


def _web_navigation_metadata(
    fragments: tuple[RetainedEpubFragment, ...], regions: Sequence[NoteRegion]
) -> dict[str, list[dict[str, object]]]:
    sections: list[dict[str, object]] = []
    toc: list[dict[str, object]] = []
    for fragment in fragments:
        blocks = build_web_article_index_blocks(
            html_sanitized=fragment.html_sanitized,
            canonical_text=fragment.canonical_text,
            fragment_idx=fragment.idx,
            fragment_id=fragment.id,
            note_regions=regions,
        )
        for block in blocks:
            if block.heading_id is None:
                continue
            toc.append(
                {
                    "node_id": block.heading_id,
                    "label": block.heading_label,
                    "parent_node_id": nullable_from_presence(block.toc_parent_id),
                    "fragment_id": str(fragment.id),
                    "offset": block.start_offset,
                    "section_id": block.section_id,
                }
            )
            if block.section_id is not None:
                sections.append(
                    {
                        "location_id": block.section_id,
                        "label": block.heading_label,
                        "parent_section_id": nullable_from_presence(block.parent_section_id),
                        "fragment_id": str(fragment.id),
                        "offset": block.start_offset,
                    }
                )
    return {
        "sections": sorted(sections, key=lambda section: str(section["location_id"])),
        "toc": sorted(toc, key=lambda node: str(node["node_id"])),
    }


def _installed_metadata(
    db: Session, media_id: UUID, kind: Literal["epub", "web_article"]
) -> dict[str, Any]:
    state = (
        db.execute(
            text(
                "SELECT id, status, note_groups FROM reader_apparatus_states WHERE media_id = :id"
            ),
            {"id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if state is None or not isinstance(state["note_groups"], list):
        raise ValueError("Reader repair requires strict apparatus state")
    items = sorted(
        [
            dict(row)
            for row in db.execute(
                text(
                    "SELECT stable_key, kind, label, body_text, body_html_sanitized, locator, locator_status,"
                    " confidence, extraction_method, source_ref, sort_key"
                    " FROM reader_apparatus_items WHERE state_id = :id ORDER BY stable_key"
                ),
                {"id": state["id"]},
            ).mappings()
        ],
        key=lambda item: str(item["stable_key"]),
    )
    edges = sorted(
        [
            dict(row)
            for row in db.execute(
                text(
                    "SELECT edge.stable_key, source.stable_key AS from_stable_key,"
                    " target.stable_key AS to_stable_key, edge.relation, edge.confidence,"
                    " edge.extraction_method, edge.source_ref, edge.sort_key"
                    " FROM reader_apparatus_edges edge"
                    " JOIN reader_apparatus_items source ON source.id = edge.from_item_id"
                    " JOIN reader_apparatus_items target ON target.id = edge.to_item_id"
                    " WHERE edge.state_id = :id ORDER BY edge.stable_key"
                ),
                {"id": state["id"]},
            ).mappings()
        ],
        key=lambda edge: str(edge["stable_key"]),
    )
    result: dict[str, Any] = {
        "status": state["status"],
        "items": items,
        "edges": edges,
        "groups": state["note_groups"],
        "source_issues": source_issues_payload(
            tuple(
                SOURCE_ISSUES.validate_python(
                    db.scalar(
                        select(ReaderPublication.source_issues).where(
                            ReaderPublication.media_id == media_id
                        )
                    )
                )
            )
        ),
        "toc": [],
        "sections": [],
    }
    if kind == "epub":
        result["toc"] = sorted(
            [
                dict(row)
                for row in db.execute(
                    text(
                        "SELECT node_id, nav_type, parent_node_id, label, href, fragment_idx,"
                        " target_offset, section_id, resolution, depth, order_key"
                        " FROM epub_toc_nodes WHERE media_id = :id ORDER BY node_id"
                    ),
                    {"id": media_id},
                ).mappings()
            ],
            key=lambda node: str(node["node_id"]),
        )
        result["sections"] = sorted(
            [
                dict(row)
                for row in db.execute(
                    text(
                        "SELECT location_id, ordinal, parent_section_id, label, fragment_idx,"
                        " href_path, href_fragment, start_offset, end_fragment_idx, end_offset, source"
                        " FROM epub_nav_locations WHERE media_id = :id ORDER BY location_id"
                    ),
                    {"id": media_id},
                ).mappings()
            ],
            key=lambda section: str(section["location_id"]),
        )
    else:
        fragments = tuple(
            RetainedEpubFragment(row.id, int(row.idx), "", row.html_sanitized, row.canonical_text)
            for row in db.execute(
                text(
                    "SELECT id, idx, html_sanitized, canonical_text FROM fragments"
                    " WHERE media_id = :id ORDER BY idx"
                ),
                {"id": media_id},
            )
        )
        result.update(_web_navigation_metadata(fragments, read_note_regions(db, media_id)))
    return result


def _install_epub_navigation(db: Session, media_id: UUID, plan: EpubNavigationRepairPlan) -> None:
    db.execute(text("DELETE FROM epub_toc_nodes WHERE media_id = :id"), {"id": media_id})
    db.execute(text("DELETE FROM epub_nav_locations WHERE media_id = :id"), {"id": media_id})
    for ordinal, section in enumerate(plan.nav_locations):
        db.add(
            EpubNavLocation(
                media_id=media_id,
                location_id=section.location_id,
                ordinal=ordinal,
                parent_section_id=nullable_from_presence(section.parent_section_id),
                label=section.label,
                fragment_idx=section.fragment_idx,
                href_path=section.href_path,
                href_fragment=nullable_from_presence(section.href_fragment),
                start_offset=section.start_offset,
                end_fragment_idx=section.end.value.fragment_idx
                if isinstance(section.end, Present)
                else None,
                end_offset=section.end.value.offset if isinstance(section.end, Present) else None,
                source=section.source,
            )
        )
    db.flush()
    for node in plan.toc_nodes:
        db.add(
            EpubTocNode(
                media_id=media_id,
                node_id=node.node_id,
                nav_type=node.nav_type,
                parent_node_id=node.parent_node_id,
                label=node.label,
                href=node.href,
                fragment_idx=node.fragment_idx,
                target_offset=node.target_offset,
                section_id=node.section_id,
                resolution=node.resolution,
                depth=node.depth,
                order_key=node.order_key,
            )
        )
    db.flush()
