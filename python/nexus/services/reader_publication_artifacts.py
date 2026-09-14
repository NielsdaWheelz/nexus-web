"""Prepare verified object members before the reader publication transaction."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from tempfile import TemporaryFile
from typing import BinaryIO
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import insert, literal, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits, get_settings
from nexus.db.models import (
    Media,
    ReaderPublication,
    ReaderPublicationAnchor,
    ReaderPublicationArtifact,
    ReaderPublicationSearchMap,
    ReaderPublicationSearchSource,
    ReaderPublicationTarget,
    ReaderPublicationUnit,
)
from nexus.errors import (
    ReaderCapacityDimension,
    ReaderContentTooLargeError,
)
from nexus.schemas.media import MediaNavigationOut
from nexus.schemas.reader_publication import (
    PUBLICATION_DESCRIPTOR,
    READER_PUBLICATION_MOUNT_NODES,
    ReaderPublicationDescriptor,
    ReaderPublicationIndexPage,
    ReaderPublicationMemberRef,
    ReaderPublicationMemberRole,
    ReaderPublicationPdfDescriptor,
    ReaderPublicationRenderElement,
    ReaderPublicationSection,
    ReaderPublicationTableMetadataRecord,
    ReaderPublicationTextDescriptor,
    ReaderPublicationTocEntry,
    ReaderPublicationUnitBody,
    ReaderPublicationUnitIndex,
)
from nexus.schemas.reader_publication import (
    ReaderPublicationAnchor as ReaderPublicationAnchorOut,
)
from nexus.services.media_document_metrics import (
    canonical_word_boundary_ordinal,
    is_canonical_word_separator,
)
from nexus.services.reader_publication_anchors import (
    normalize_epub_lookup_paths,
    reader_publication_anchor_key,
)
from nexus.services.reader_publication_apparatus import retain_reader_publication_apparatus
from nexus.services.reader_publication_render import (
    canonical_text_from_render_nodes,
)
from nexus.services.reader_publication_search import (
    PreparedReaderSearch,
    ReaderSearchPreparation,
    install_reader_search,
    prepare_pdf_reader_search,
)
from nexus.storage.client import StorageClientBase, StorageError
from nexus.storage.paths import build_reader_publication_member_storage_path
from nexus.tasks.storage_object_cleanup import reserve_storage_object_write

# The object store reports an absent object with this code; every other failure is
# transient infrastructure that the bounded member read below retries.
_MISSING_OBJECT_CODE = "E_STORAGE_MISSING"
_OBJECT_READ_ATTEMPTS = 3


class ReaderPublicationMemberReadExhausted(RuntimeError):
    """Defect: bounded object-store reads of one prepared member stayed unavailable."""

    def __init__(self, storage_path: str, attempts: int) -> None:
        super().__init__(
            f"Reader publication member {storage_path} stayed unreadable "
            f"after {attempts} object-store attempts"
        )


@dataclass(frozen=True)
class PreparedReaderPublicationMember:
    ref: ReaderPublicationMemberRef
    role: ReaderPublicationMemberRole
    storage_path: str
    media_type: str


@dataclass(frozen=True)
class PreparedReaderPublicationUnit:
    index: ReaderPublicationUnitIndex


@dataclass(frozen=True)
class PreparedReaderPublicationTarget:
    target_id: str
    ordinal: int
    label: str
    unit_key: str
    offset_cp: int
    end_cp: int | None
    href_path: str | None
    href_pathname: str | None
    anchor_id: str | None


@dataclass(frozen=True)
class PreparedReaderPublication:
    media_id: UUID
    expected_generation: int | None
    descriptor: ReaderPublicationDescriptor
    members: tuple[PreparedReaderPublicationMember, ...]
    units: tuple[PreparedReaderPublicationUnit, ...]
    unit_projection_file: BinaryIO | None
    targets: tuple[PreparedReaderPublicationTarget, ...]
    anchors: tuple[ReaderPublicationAnchorOut, ...]
    search: PreparedReaderSearch


@dataclass(frozen=True)
class PreparedReaderPublicationTitle:
    media_id: UUID
    expected_generation: int
    descriptor: ReaderPublicationDescriptor
    member: PreparedReaderPublicationMember


@dataclass(frozen=True)
class ReaderPublicationDescriptorUnprepared:
    """The media's current generation carries no descriptor member to succeed.

    This owner creates that state deliberately: a generation exists from the
    instant its pointer is written and its descriptor member only after the job
    that prepares it runs. A caller that wanted to publish a successor title has
    nothing to succeed yet, so it is told which generation it found rather than
    handed an error it would have to re-classify.
    """

    generation: int


type PreparedReaderTitleOutcome = (
    PreparedReaderPublicationTitle | ReaderPublicationDescriptorUnprepared | None
)


def prepare_reader_publication_title(
    session_factory: sessionmaker[Session],
    storage: StorageClientBase,
    *,
    media_id: UUID,
    title: str,
    limits: ReaderPublicationLimits,
) -> PreparedReaderTitleOutcome:
    """Freeze a successor descriptor before the metadata owner's transaction.

    ``None`` means the media owns no reader publication at all.
    """
    with session_factory() as db:
        current = db.execute(
            select(ReaderPublication.generation, ReaderPublicationArtifact)
            .join(Media, Media.id == ReaderPublication.media_id)
            .join(
                ReaderPublicationArtifact,
                (ReaderPublicationArtifact.media_id == ReaderPublication.media_id)
                & (ReaderPublicationArtifact.generation == ReaderPublication.generation)
                & (ReaderPublicationArtifact.path == "descriptor.json"),
                isouter=True,
            )
            .where(ReaderPublication.media_id == media_id)
        ).one_or_none()
        if current is None:
            return None
        generation, artifact = current
        if artifact is None:
            return ReaderPublicationDescriptorUnprepared(generation)
        path, size, digest = artifact.storage_path, artifact.size_bytes, artifact.sha256
    if size > limits.descriptor_bytes:
        raise ReaderContentTooLargeError(
            "Reader descriptor exceeds qualified capacity",
            limit="descriptor_bytes",
            limit_value=limits.descriptor_bytes,
            measured=size,
        )
    body = bytearray()
    for chunk in storage.stream_object(path):
        if len(body) + len(chunk) > size:
            raise AssertionError("Retained descriptor exceeded its verified size")
        body.extend(chunk)
    if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
        raise AssertionError("Retained descriptor differs from its verified bytes")
    descriptor = PUBLICATION_DESCRIPTOR.validate_json(bytes(body))
    if descriptor.media_id != media_id or descriptor.reader_generation != generation:
        raise AssertionError("Retained descriptor has a different publication identity")
    descriptor = descriptor.model_copy(update={"reader_generation": generation + 1, "title": title})
    member = prepare_reader_publication_member(
        session_factory,
        storage,
        media_id=media_id,
        key="descriptor.json",
        role="descriptor",
        body=_encoded(descriptor, limit="descriptor_bytes", limit_value=limits.descriptor_bytes),
        media_type="application/json",
    )
    return PreparedReaderPublicationTitle(media_id, generation, descriptor, member)


def _preparation_retention_deadline(db: Session) -> datetime:
    """The last instant this attempt could still publish the member it is writing.

    A publication attempt writes its members long before the transaction that gives
    them a committed DB owner, and that attempt runs inside a background job bounded
    by the process wall timeout. The cleanup reservation must not become due before
    that bound plus the object-store clock-skew grace, or a member's own fence
    deletes the bytes the attempt is about to publish.
    """
    settings = get_settings()
    now: datetime = db.execute(text("SELECT now()")).scalar_one()
    return now + timedelta(
        seconds=settings.background_process_wall_timeout_seconds
        + settings.media_teardown_cleanup_grace_seconds
    )


def _read_object_identity(storage: StorageClientBase, storage_path: str) -> tuple[int, str]:
    """Stream one immutable object to its exact length and digest.

    justify-retry-schedule: an object read cannot resume once bytes have been
    yielded, so the whole read is the smallest retryable unit and the budget belongs
    here rather than around a caller that also writes. An absent object is a fact
    about the publication, not a transient failure, so it is raised unchanged.
    """
    for attempt in range(_OBJECT_READ_ATTEMPTS):
        digest = hashlib.sha256()
        size = 0
        try:
            for chunk in storage.stream_object(storage_path):
                size += len(chunk)
                digest.update(chunk)
        except StorageError as exc:
            if exc.code == _MISSING_OBJECT_CODE:
                raise
            if attempt == _OBJECT_READ_ATTEMPTS - 1:
                # justify-defect: reading back an object the store holds must succeed
                # within the bounded object-store retry budget.
                raise ReaderPublicationMemberReadExhausted(
                    storage_path, _OBJECT_READ_ATTEMPTS
                ) from exc
            continue
        return size, digest.hexdigest()
    # justify-defect: the bounded loop returns or raises on its final attempt.
    raise AssertionError("bounded reader publication member read produced no outcome")


def prepare_reader_publication_member(
    session_factory: sessionmaker[Session],
    storage: StorageClientBase,
    *,
    media_id: UUID,
    key: str,
    role: ReaderPublicationMemberRole,
    body: bytes,
    media_type: str,
) -> PreparedReaderPublicationMember:
    """Reserve cleanup, write, and verify exact bytes with no open DB transaction."""
    sha256 = hashlib.sha256(body).hexdigest()
    path = build_reader_publication_member_storage_path(media_id, sha256)
    with session_factory() as db:
        reserve_storage_object_write(
            db,
            media_id=media_id,
            storage_path=path,
            retain_until=_preparation_retention_deadline(db),
        )
    storage.put_object(path, body, media_type)
    size, read_digest = _read_object_identity(storage, path)
    if size != len(body) or read_digest != sha256:
        # justify-defect: immutable object publication requires the exact bytes
        # that the object store just accepted under this content-addressed key.
        raise AssertionError("Reader publication member verification failed")
    return PreparedReaderPublicationMember(
        ref=ReaderPublicationMemberRef(key=key, bytes=size, sha256=sha256),
        role=role,
        storage_path=path,
        media_type=media_type,
    )


def verify_reader_publication_asset(
    storage: StorageClientBase,
    *,
    key: str,
    storage_path: str,
    media_type: str,
    expected_size_bytes: int,
    expected_sha256: str | None = None,
) -> PreparedReaderPublicationMember:
    """Reference an existing immutable source/asset after a streaming verification."""
    size, sha256 = _read_object_identity(storage, storage_path)
    if size != expected_size_bytes or (expected_sha256 is not None and sha256 != expected_sha256):
        # justify-defect: extraction supplied the verified immutable source identity;
        # a different object cannot be installed as that source's reader asset.
        raise AssertionError("Reader publication source verification failed")
    return PreparedReaderPublicationMember(
        ref=ReaderPublicationMemberRef(key=key, bytes=size, sha256=sha256),
        role="asset",
        storage_path=storage_path,
        media_type=media_type,
    )


def _encoded(model: BaseModel, *, limit: ReaderCapacityDimension, limit_value: int) -> bytes:
    payload = model.model_dump_json().encode("utf-8")
    if len(payload) > limit_value:
        raise ReaderContentTooLargeError(
            "Reader member exceeds qualified capacity",
            limit=limit,
            limit_value=limit_value,
            measured=len(payload),
        )
    return payload


def prepare_text_reader_publication(
    session_factory: sessionmaker[Session],
    storage: StorageClientBase,
    *,
    media_id: UUID,
    expected_generation: int | None,
    generation: int,
    title: str,
    navigation: MediaNavigationOut,
    source_parts: Iterable[
        ReaderPublicationUnitBody
        | ReaderPublicationTableMetadataRecord
        | ReaderPublicationAnchorOut
    ],
    unit_projection_file: BinaryIO,
    search_projection_file: BinaryIO,
    assets: tuple[PreparedReaderPublicationMember, ...],
    limits: ReaderPublicationLimits,
) -> PreparedReaderPublication:
    """Materialize one text revision outside its later atomic installation."""
    if navigation.media_id != media_id:
        raise ValueError("Reader navigation belongs to another media")
    fragment_starts: dict[str, tuple[int, int]] = {}
    canonical_length = 0
    for fragment in navigation.fragments:
        fragment_starts[str(fragment.fragment_id)] = (canonical_length, fragment.char_count)
        canonical_length += fragment.char_count
    members = list(assets)
    search = ReaderSearchPreparation(
        search_projection_file, chunk_codepoints=limits.unit_codepoints
    )
    units: list[PreparedReaderPublicationUnit] = []
    anchored_units: dict[tuple[str, str], int] = {}
    parts: dict[tuple[str, int, int], int] = {}
    ends: dict[str, int] = {}
    previous_fragment: str | None = None
    document_word_start = 0
    starts_in_word = False
    from nexus.services.epub_read import epub_fragment_resume_targets

    epub_targets = {
        str(key): target for key, target in epub_fragment_resume_targets(navigation).items()
    }
    anchors: dict[tuple[str, str], ReaderPublicationAnchorOut] = {}
    embed_ids: set[UUID] = set()
    embed_keys: set[tuple[str, str]] = set()
    table_page = ReaderPublicationIndexPage(
        units=(),
        sections=(),
        toc=(),
        landmarks=(),
        page_list=(),
        anchors=(),
        table_metadata=(),
        next_ref=None,
    )
    table_continuation = ReaderPublicationMemberRef(
        key="index/tables-18446744073709551615.json",
        bytes=limits.index_bytes,
        sha256="0" * 64,
    )
    table_offsets: list[int] = []
    table_metadata_ref: ReaderPublicationMemberRef | None = None
    with TemporaryFile(mode="w+b") as table_pages:
        for part in source_parts:
            if isinstance(part, ReaderPublicationAnchorOut):
                anchors.setdefault((part.href_path, part.anchor_id), part)
                continue
            if not isinstance(part, ReaderPublicationUnitBody):
                candidate = table_page.model_copy(
                    update={
                        "table_metadata": (*table_page.table_metadata, part),
                        "next_ref": table_continuation,
                    }
                )
                page_bytes = len(candidate.model_dump_json().encode("utf-8"))
                if page_bytes > limits.index_bytes:
                    if not table_page.table_metadata:
                        raise ReaderContentTooLargeError(
                            "Table source record exceeds index capacity",
                            limit="index_bytes",
                            limit_value=limits.index_bytes,
                            measured=page_bytes,
                        )
                    table_offsets.append(table_pages.tell())
                    table_pages.write(
                        _encoded(table_page, limit="index_bytes", limit_value=limits.index_bytes)
                        + b"\n"
                    )
                    candidate = table_page.model_copy(
                        update={"table_metadata": (part,), "next_ref": table_continuation}
                    )
                    _encoded(candidate, limit="index_bytes", limit_value=limits.index_bytes)
                table_page = candidate
                continue
            unit = part
            ordinal = len(units)
            if unit.word_boundaries is None:
                raise ValueError("Hosted reader publication requires computed word boundaries")
            if unit.epub_target != epub_targets.get(unit.fragment_id):
                raise ValueError("Reader unit EPUB target differs from retained navigation")
            for source in unit.document_embeds:
                identity = (unit.fragment_id, source.occurrence_key)
                if source.id in embed_ids or identity in embed_keys:
                    raise ValueError("Reader publication repeats an embed source occurrence")
                embed_ids.add(source.id)
                embed_keys.add(identity)
            if unit.fragment_id != previous_fragment:
                starts_in_word = False
            if (
                unit.document_word_start != document_word_start
                or unit.starts_in_word != starts_in_word
            ):
                raise ValueError("Reader unit activity coordinates differ from canonical text")
            document_word_start += canonical_word_boundary_ordinal(
                unit.canonical_text, len(unit.canonical_text), starts_in_word=starts_in_word
            )
            if unit.canonical_text:
                starts_in_word = not is_canonical_word_separator(unit.canonical_text[-1])
            previous_fragment = unit.fragment_id
            if fragment_starts.get(unit.fragment_id) != (
                unit.fragment_document_start_cp,
                unit.fragment_length_cp,
            ):
                raise ValueError("Reader unit document coordinates differ from navigation")
            if unit.start_cp != ends.get(unit.fragment_id, 0):
                raise ValueError("Reader units must cover each fragment contiguously")
            ends[unit.fragment_id] = unit.end_cp
            rendered = canonical_text_from_render_nodes(unit.render_nodes)
            expected = unit.canonical_text[
                unit.render_start_cp - unit.start_cp : unit.render_end_cp - unit.start_cp
            ]
            if rendered != expected:
                raise ValueError("Reader unit tree changed canonical text")
            if len(unit.canonical_text) > limits.unit_codepoints:
                raise ReaderContentTooLargeError(
                    "Reader unit text exceeds qualified capacity",
                    limit="unit_codepoints",
                    limit_value=limits.unit_codepoints,
                    measured=len(unit.canonical_text),
                )
            mounted_nodes = READER_PUBLICATION_MOUNT_NODES + len(unit.render_nodes)
            if mounted_nodes > limits.unit_dom_nodes:
                raise ReaderContentTooLargeError(
                    "Reader unit DOM exceeds qualified capacity",
                    limit="unit_dom_nodes",
                    limit_value=limits.unit_dom_nodes,
                    measured=mounted_nodes,
                )
            for node in unit.render_nodes:
                if isinstance(node, ReaderPublicationRenderElement):
                    for attr in node.attributes:
                        if (
                            attr.namespace is None
                            and attr.name in {"id", "name"}
                            and isinstance(attr.value, str)
                            and attr.value
                        ):
                            anchored_units.setdefault((unit.fragment_id, attr.value), ordinal)
            extent = (unit.fragment_id, unit.start_cp, unit.end_cp)
            part = parts.get(extent, 0)
            parts[extent] = part + 1
            key = f"units/{unit.fragment_id}/{unit.start_cp}-{unit.end_cp}-{part}.json"
            search.append(
                source_ordinal=unit.fragment_idx,
                fragment_id=UUID(unit.fragment_id),
                raw_start=unit.start_cp,
                text=unit.canonical_text,
            )
            payload = _encoded(unit, limit="unit_bytes", limit_value=limits.unit_bytes)
            unit_projection_file.write(payload)
            unit_projection_file.write(b"\n")
            member = prepare_reader_publication_member(
                session_factory,
                storage,
                media_id=media_id,
                key=key,
                role="unit",
                body=payload,
                media_type="application/json",
            )
            members.append(member)
            units.append(
                PreparedReaderPublicationUnit(
                    index=ReaderPublicationUnitIndex(
                        member=member.ref,
                        ordinal=ordinal,
                        fragment_id=unit.fragment_id,
                        fragment_idx=unit.fragment_idx,
                        start_cp=unit.start_cp,
                        end_cp=unit.end_cp,
                    ),
                )
            )
        if table_page.table_metadata:
            table_offsets.append(table_pages.tell())
            table_pages.write(
                _encoded(table_page, limit="index_bytes", limit_value=limits.index_bytes) + b"\n"
            )
        for index in reversed(range(len(table_offsets))):
            table_pages.seek(table_offsets[index])
            page = ReaderPublicationIndexPage.model_validate_json(table_pages.readline())
            member = prepare_reader_publication_member(
                session_factory,
                storage,
                media_id=media_id,
                key=f"index/tables-{index}.json",
                role="index",
                body=_encoded(
                    page.model_copy(update={"next_ref": table_metadata_ref}),
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                ),
                media_type="application/json",
            )
            members.append(member)
            table_metadata_ref = member.ref
    if not units:
        raise ValueError("Text publication needs at least one unit")
    if ends != {
        str(fragment.fragment_id): fragment.char_count for fragment in navigation.fragments
    }:
        raise ValueError("Reader units do not cover the complete navigation fragments")

    pathnames = normalize_epub_lookup_paths(
        section.href_path for section in navigation.sections if section.href_path is not None
    )
    targets: list[PreparedReaderPublicationTarget] = []
    by_fragment: dict[str, list[PreparedReaderPublicationUnit]] = {}
    for unit in units:
        by_fragment.setdefault(unit.index.fragment_id, []).append(unit)
    for section in navigation.sections:
        candidates = by_fragment[str(section.fragment_id)]
        anchor = section.anchor_id or section.href_fragment
        anchor_unit = anchored_units.get((str(section.fragment_id), anchor)) if anchor else None
        target = (
            units[anchor_unit]
            if anchor_unit is not None
            else next(
                (
                    unit
                    for unit in candidates
                    if unit.index.start_cp <= section.start_offset < unit.index.end_cp
                ),
                None,
            )
        )
        if target is None and section.start_offset == candidates[-1].index.end_cp:
            target = next(
                (unit for unit in reversed(candidates) if unit.index.end_cp > unit.index.start_cp),
                candidates[0],
            )
        if target is None:
            raise ValueError("Navigation target lies outside its canonical fragment")
        targets.append(
            PreparedReaderPublicationTarget(
                target_id=section.section_id,
                ordinal=section.ordinal,
                label=section.label,
                unit_key=target.index.member.key,
                offset_cp=section.start_offset,
                end_cp=section.end_offset,
                href_path=section.href_path,
                href_pathname=pathnames.get(section.href_path)
                if section.href_path is not None
                else None,
                anchor_id=section.anchor_id or section.href_fragment,
            )
        )

    toc: list[ReaderPublicationTocEntry] = []

    def flatten(nodes: list, parent_id: str | None) -> None:
        for node in nodes:
            toc.append(
                ReaderPublicationTocEntry(
                    id=node.id,
                    parent_id=parent_id,
                    label=node.label,
                    ordinal=node.ordinal,
                    href=node.href,
                    fragment_idx=node.fragment_idx,
                    level=node.level,
                    depth=node.depth,
                    section_id=node.section_id,
                )
            )
            flatten(node.children, node.id)

    flatten(navigation.toc_nodes, None)
    sections = [
        ReaderPublicationSection(
            **section.model_dump(exclude={"fragment_id"}),
            fragment_id=str(section.fragment_id),
            unit_key=target.unit_key,
        )
        for section, target in zip(navigation.sections, targets, strict=True)
    ]
    pages: list[ReaderPublicationIndexPage] = []
    page = ReaderPublicationIndexPage(
        units=(),
        sections=(),
        toc=(),
        landmarks=(),
        page_list=(),
        table_metadata=(),
        anchors=(),
        next_ref=None,
    )
    # Reserve a full-sized continuation reference before packing every page.
    continuation = ReaderPublicationMemberRef(
        key="index/contents-18446744073709551615.json",
        bytes=limits.index_bytes,
        sha256="0" * 64,
    )
    for field, values in (
        ("units", [unit.index for unit in units]),
        ("sections", sections),
        ("anchors", list(anchors.values())),
        ("landmarks", navigation.landmarks),
        ("page_list", navigation.page_list),
    ):
        for value in values:
            candidate = page.model_copy(
                update={field: (*getattr(page, field), value), "next_ref": continuation}
            )
            page_bytes = len(candidate.model_dump_json().encode("utf-8"))
            if page_bytes > limits.index_bytes:
                if not any(
                    (
                        page.units,
                        page.sections,
                        page.toc,
                        page.landmarks,
                        page.page_list,
                        page.anchors,
                    )
                ):
                    raise ReaderContentTooLargeError(
                        "Navigation entry exceeds qualified capacity",
                        limit="index_bytes",
                        limit_value=limits.index_bytes,
                        measured=page_bytes,
                    )
                pages.append(page)
                page = ReaderPublicationIndexPage(
                    units=(),
                    sections=(),
                    toc=(),
                    landmarks=(),
                    page_list=(),
                    table_metadata=(),
                    anchors=(),
                    next_ref=None,
                )
                candidate = page.model_copy(update={field: (value,), "next_ref": continuation})
                _encoded(candidate, limit="index_bytes", limit_value=limits.index_bytes)
            page = candidate
    pages.append(page)
    next_ref: ReaderPublicationMemberRef | None = None
    for index in reversed(range(len(pages))):
        member = prepare_reader_publication_member(
            session_factory,
            storage,
            media_id=media_id,
            key=f"index/{index}.json",
            role="index",
            body=_encoded(
                pages[index].model_copy(update={"next_ref": next_ref}),
                limit="index_bytes",
                limit_value=limits.index_bytes,
            ),
            media_type="application/json",
        )
        members.append(member)
        next_ref = member.ref
    assert next_ref is not None
    # The display projection ends after its primary TOC/section rows. Unit lookup
    # never waits behind contents, and display never drains lookup-only pages.
    contents_pages: list[ReaderPublicationIndexPage] = []
    contents_field = "toc" if toc else "sections"
    contents_values = toc if toc else sections
    page = ReaderPublicationIndexPage(
        units=(),
        sections=(),
        toc=(),
        landmarks=(),
        page_list=(),
        table_metadata=(),
        anchors=(),
        next_ref=None,
    )
    for value in contents_values:
        candidate = page.model_copy(
            update={
                contents_field: (*getattr(page, contents_field), value),
                "next_ref": continuation,
            }
        )
        page_bytes = len(candidate.model_dump_json().encode("utf-8"))
        if page_bytes > limits.index_bytes:
            if not getattr(page, contents_field):
                raise ReaderContentTooLargeError(
                    "Contents entry exceeds qualified capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            contents_pages.append(page)
            page = ReaderPublicationIndexPage(
                units=(),
                sections=(),
                toc=(),
                landmarks=(),
                page_list=(),
                table_metadata=(),
                anchors=(),
                next_ref=None,
            )
            candidate = page.model_copy(update={contents_field: (value,), "next_ref": continuation})
            _encoded(candidate, limit="index_bytes", limit_value=limits.index_bytes)
        page = candidate
    if getattr(page, contents_field):
        contents_pages.append(page)
    contents_ref: ReaderPublicationMemberRef | None = None
    for index in reversed(range(len(contents_pages))):
        member = prepare_reader_publication_member(
            session_factory,
            storage,
            media_id=media_id,
            key=f"index/contents-{index}.json",
            role="index",
            body=_encoded(
                contents_pages[index].model_copy(update={"next_ref": contents_ref}),
                limit="index_bytes",
                limit_value=limits.index_bytes,
            ),
            media_type="application/json",
        )
        members.append(member)
        contents_ref = member.ref
    descriptor = ReaderPublicationTextDescriptor(
        media_id=media_id,
        reader_generation=generation,
        kind=navigation.kind,
        title=title,
        first_unit_ref=units[0].index.member,
        index_ref=next_ref,
        contents_ref=contents_ref,
        table_metadata_ref=table_metadata_ref,
        unit_count=len(units),
        canonical_length=canonical_length,
    )
    members.append(
        prepare_reader_publication_member(
            session_factory,
            storage,
            media_id=media_id,
            key="descriptor.json",
            role="descriptor",
            body=_encoded(
                descriptor, limit="descriptor_bytes", limit_value=limits.descriptor_bytes
            ),
            media_type="application/json",
        )
    )
    return PreparedReaderPublication(
        media_id=media_id,
        expected_generation=expected_generation,
        descriptor=descriptor,
        members=tuple(members),
        units=tuple(units),
        unit_projection_file=unit_projection_file,
        targets=tuple(targets),
        anchors=tuple(anchors.values()),
        search=search.finish(),
    )


def prepare_pdf_reader_publication(
    session_factory: sessionmaker[Session],
    storage: StorageClientBase,
    *,
    media_id: UUID,
    expected_generation: int | None,
    generation: int,
    title: str,
    page_count: int,
    plain_text: str,
    page_spans: tuple[tuple[int, int, int], ...],
    page_heights: tuple[tuple[int, float | None], ...],
    search_projection_file: BinaryIO,
    document: PreparedReaderPublicationMember,
    limits: ReaderPublicationLimits,
) -> PreparedReaderPublication:
    """Retain the binary and its canonical text/page query projection together."""
    search = prepare_pdf_reader_search(
        search_projection_file,
        plain_text=plain_text,
        page_spans=page_spans,
        page_heights=page_heights,
        page_count=page_count,
        chunk_codepoints=limits.unit_codepoints,
    )
    descriptor = ReaderPublicationPdfDescriptor(
        media_id=media_id,
        reader_generation=generation,
        title=title,
        page_count=page_count,
        document_asset_ref=document.ref,
    )
    member = prepare_reader_publication_member(
        session_factory,
        storage,
        media_id=media_id,
        key="descriptor.json",
        role="descriptor",
        body=_encoded(descriptor, limit="descriptor_bytes", limit_value=limits.descriptor_bytes),
        media_type="application/json",
    )
    return PreparedReaderPublication(
        media_id=media_id,
        expected_generation=expected_generation,
        descriptor=descriptor,
        members=(document, member),
        units=(),
        unit_projection_file=None,
        targets=(),
        anchors=(),
        search=search,
    )


def install_prepared_reader_title(db: Session, prepared: PreparedReaderPublicationTitle) -> None:
    """Reuse frozen content projections; only descriptor/title bytes change."""
    generation = prepared.descriptor.reader_generation
    member = prepared.member
    db.add(
        ReaderPublicationArtifact(
            media_id=prepared.media_id,
            generation=generation,
            path=member.ref.key,
            role=member.role,
            storage_path=member.storage_path,
            media_type=member.media_type,
            size_bytes=member.ref.bytes,
            sha256=member.ref.sha256,
            pdf_page_count=prepared.descriptor.page_count
            if isinstance(prepared.descriptor, ReaderPublicationPdfDescriptor)
            else None,
        )
    )
    # These are immutable retained projections, copied by SQL rather than decoded
    # into a whole-document Python graph in the metadata transaction.
    for model, fields in (
        (
            ReaderPublicationArtifact,
            ("media_id", "path", "role", "storage_path", "media_type", "size_bytes", "sha256"),
        ),
        (
            ReaderPublicationUnit,
            (
                "media_id",
                "unit_key",
                "ordinal",
                "fragment_id",
                "fragment_idx",
                "start_cp",
                "end_cp",
                "canonical_text",
                "word_boundaries",
                "embed_markers",
            ),
        ),
        (
            ReaderPublicationSearchSource,
            (
                "media_id",
                "source_ordinal",
                "fragment_id",
                "raw_codepoints",
                "normalized_codepoints",
                "normalized_text",
                "canonical_text",
                "pdf_page_spans",
                "pdf_quote_text_ready",
                "pdf_page_heights",
            ),
        ),
        (
            ReaderPublicationSearchMap,
            (
                "media_id",
                "source_ordinal",
                "normalized_start",
                "normalized_end",
                "page_number",
                "run_starts",
                "raw_deltas",
            ),
        ),
        (
            ReaderPublicationAnchor,
            ("media_id", "anchor_key", "href_path", "anchor_id", "unit_key", "offset_cp"),
        ),
        (
            ReaderPublicationTarget,
            (
                "media_id",
                "target_id",
                "ordinal",
                "label",
                "unit_key",
                "offset_cp",
                "end_cp",
                "href_path",
                "href_pathname",
                "anchor_id",
            ),
        ),
    ):
        source = select(literal(generation), *(getattr(model, field) for field in fields)).where(
            model.media_id == prepared.media_id, model.generation == prepared.expected_generation
        )
        if model is ReaderPublicationArtifact:
            source = source.where(ReaderPublicationArtifact.role.not_in(("descriptor", "archive")))
        db.execute(insert(model).from_select(("generation", *fields), source))
    retain_reader_publication_apparatus(
        db,
        media_id=prepared.media_id,
        generation=generation,
        source_generation=prepared.expected_generation,
    )
    db.flush()


def install_prepared_reader_publication(db: Session, prepared: PreparedReaderPublication) -> None:
    """Install verified members inside the held expected-generation publication fence."""
    media_id = prepared.media_id
    generation = prepared.descriptor.reader_generation
    existing = db.scalar(
        select(ReaderPublicationArtifact.path)
        .where(
            ReaderPublicationArtifact.media_id == media_id,
            ReaderPublicationArtifact.generation == generation,
        )
        .limit(1)
    )
    if existing is not None:
        raise ValueError("Reader generation already has immutable members")
    for member in prepared.members:
        if member.role == "archive":
            # justify-defect: an archive member owns expanded-size and revision facts
            # that only the offline package owner produces; this publication holds
            # none of them and would install an archive row without them.
            raise AssertionError("Reader publication cannot install an archive member")
    db.add_all(
        ReaderPublicationArtifact(
            media_id=media_id,
            generation=generation,
            path=member.ref.key,
            role=member.role,
            storage_path=member.storage_path,
            media_type=member.media_type,
            size_bytes=member.ref.bytes,
            sha256=member.ref.sha256,
            pdf_page_count=prepared.descriptor.page_count
            if member.role == "descriptor"
            and isinstance(prepared.descriptor, ReaderPublicationPdfDescriptor)
            else None,
        )
        for member in prepared.members
    )
    db.flush()
    if prepared.units:
        if prepared.unit_projection_file is None:
            raise AssertionError("Prepared text publication has no staged unit projections")
        prepared.unit_projection_file.seek(0)
    for unit in prepared.units:
        assert prepared.unit_projection_file is not None
        payload = prepared.unit_projection_file.read(unit.index.member.bytes)
        if (
            prepared.unit_projection_file.read(1) != b"\n"
            or hashlib.sha256(payload).hexdigest() != unit.index.member.sha256
        ):
            raise AssertionError("Staged projection differs from its prepared member")
        body = ReaderPublicationUnitBody.model_validate_json(payload)
        if body.word_boundaries is None:
            raise ValueError("Hosted reader publication requires computed word boundaries")
        db.execute(
            insert(ReaderPublicationUnit).values(
                media_id=media_id,
                generation=generation,
                unit_key=unit.index.member.key,
                ordinal=unit.index.ordinal,
                fragment_id=UUID(unit.index.fragment_id),
                fragment_idx=unit.index.fragment_idx,
                start_cp=unit.index.start_cp,
                end_cp=unit.index.end_cp,
                canonical_text=body.canonical_text,
                word_boundaries=list(body.word_boundaries),
                embed_markers=[
                    embed.model_dump(
                        mode="json",
                        include={
                            "id",
                            "ordinal",
                            "occurrence_key",
                            "canonical_start_offset",
                            "canonical_end_offset",
                        },
                    )
                    for embed in body.document_embeds
                ],
            )
        )
    db.add_all(
        ReaderPublicationTarget(
            media_id=media_id,
            generation=generation,
            target_id=target.target_id,
            ordinal=target.ordinal,
            label=target.label,
            unit_key=target.unit_key,
            offset_cp=target.offset_cp,
            end_cp=target.end_cp,
            href_path=target.href_path,
            href_pathname=target.href_pathname,
            anchor_id=target.anchor_id,
        )
        for target in prepared.targets
    )
    anchor_keys: dict[str, tuple[str, str]] = {}
    for anchor in prepared.anchors:
        key = reader_publication_anchor_key(anchor.href_path, anchor.anchor_id)
        identity = (anchor.href_path, anchor.anchor_id)
        if key in anchor_keys and anchor_keys[key] != identity:
            raise ValueError("Reader authored anchor digest collision")
        anchor_keys[key] = identity
        db.add(
            ReaderPublicationAnchor(
                media_id=media_id, generation=generation, anchor_key=key, **anchor.model_dump()
            )
        )
    install_reader_search(db, media_id=media_id, generation=generation, prepared=prepared.search)
    retain_reader_publication_apparatus(db, media_id=media_id, generation=generation)
    db.flush()
