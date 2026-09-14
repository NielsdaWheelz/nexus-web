"""Stage exact retained members into the worker-owned schema-two archive."""

from __future__ import annotations

import base64
import hashlib
import os
import tempfile
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import ReaderPublicationArtifact
from nexus.schemas.offline_reading_package import (
    OFFLINE_READING_MAX_ENTRIES,
    OFFLINE_READING_MAX_EXPANDED_BYTES,
    OfflineReadingEntry,
    OfflineReadingManifest,
)
from nexus.schemas.reader_publication import (
    PUBLICATION_DESCRIPTOR,
    ReaderPublicationCapturedAsset,
    ReaderPublicationMemberRef,
    ReaderPublicationPdfDescriptor,
    ReaderPublicationUnitBody,
)
from nexus.services.offline_reading_packages import (
    OFFLINE_READING_ZIP_MEDIA_TYPE,
    OfflineReadingPackageError,
    assemble_offline_reading_zip_from_files,
    build_offline_reading_manifest_from_entries,
)
from nexus.storage.client import get_storage_client


@dataclass(frozen=True, slots=True)
class OfflineReadingArchive:
    media_type: str
    compressed_length: int
    account_independent_digest: str
    content_digest: str
    expanded_length: int
    reader_generation: int
    reader_revision_key: str


def _parse_retained[T](parse: Callable[[bytes], T], body: bytes) -> T:
    """Classify a retained member that no longer satisfies its own schema."""
    try:
        return parse(body)
    except ValidationError as exc:
        raise OfflineReadingPackageError("retained publication member is not valid") from exc


@dataclass(frozen=True, slots=True)
class StagedReaderPublication:
    manifest: OfflineReadingManifest
    members: Mapping[str, Path]
    expanded_length: int


@contextmanager
def stage_reader_publication_members(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    generation: int,
    limits: ReaderPublicationLimits,
    parent_directory: Path,
) -> Iterator[StagedReaderPublication]:
    """Share exact member staging between archive assembly and release verification.

    No archive is created here. The caller runs the existing full member verifier
    before claiming conformance; all file lifetimes end with this context.
    """
    storage = get_storage_client()
    entries: dict[str, OfflineReadingEntry] = {}
    members: dict[str, Path] = {}
    expanded = 0

    with tempfile.TemporaryDirectory(dir=parent_directory, prefix="members-") as directory:
        staging = Path(directory)

        def stage(
            key: str,
            role: str,
            *,
            ref: ReaderPublicationMemberRef | None = None,
            maximum_bytes: int | None = None,
        ) -> Path:
            nonlocal expanded
            if key in entries:
                entry = entries[key]
                if ref is not None and (
                    entry.size_bytes != ref.bytes or entry.sha256 != ref.sha256
                ):
                    raise OfflineReadingPackageError("repeated member reference differs")
                return members[key]
            with session_factory() as db:
                row = db.scalar(
                    select(ReaderPublicationArtifact).where(
                        ReaderPublicationArtifact.media_id == media_id,
                        ReaderPublicationArtifact.generation == generation,
                        ReaderPublicationArtifact.path == key,
                        ReaderPublicationArtifact.role == role,
                    )
                )
                if row is None:
                    raise OfflineReadingPackageError(
                        "retained publication member is missing", reason="SourceUnavailable"
                    )
                entry = OfflineReadingEntry(
                    path=row.path,
                    media_type=row.media_type,
                    size_bytes=row.size_bytes,
                    sha256=row.sha256,
                )
                storage_path = row.storage_path
            if ref is not None and (entry.size_bytes != ref.bytes or entry.sha256 != ref.sha256):
                raise OfflineReadingPackageError("retained member differs from its reference")
            if maximum_bytes is not None and entry.size_bytes > maximum_bytes:
                raise OfflineReadingPackageError(
                    "retained JSON member exceeds its bound", reason="TooLarge"
                )
            expanded += entry.size_bytes
            if (
                expanded > OFFLINE_READING_MAX_EXPANDED_BYTES
                or len(entries) >= OFFLINE_READING_MAX_ENTRIES
            ):
                raise OfflineReadingPackageError(
                    "publication exceeds offline archive bounds", reason="TooLarge"
                )
            destination = staging.joinpath(*entry.path.split("/"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            length = 0
            with destination.open("xb") as output:
                for chunk in storage.stream_object(storage_path):
                    length += len(chunk)
                    if length > entry.size_bytes:
                        raise OfflineReadingPackageError("retained member exceeds advertised bytes")
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            if length != entry.size_bytes or digest.hexdigest() != entry.sha256:
                raise OfflineReadingPackageError("retained member integrity mismatch")
            entries[key], members[key] = entry, destination
            return destination

        descriptor = _parse_retained(
            PUBLICATION_DESCRIPTOR.validate_json,
            stage(
                "descriptor.json", "descriptor", maximum_bytes=limits.descriptor_bytes
            ).read_bytes(),
        )
        if descriptor.media_id != media_id or descriptor.reader_generation != generation:
            raise OfflineReadingPackageError(
                "retained descriptor identity mismatch", reason="SourceUnavailable"
            )
        if isinstance(descriptor, ReaderPublicationPdfDescriptor):
            stage(descriptor.document_asset_ref.key, "asset", ref=descriptor.document_asset_ref)
        else:
            from nexus.schemas.reader_publication import ReaderPublicationIndexPage

            page_ref: ReaderPublicationMemberRef | None = descriptor.index_ref
            seen_pages: set[str] = set()
            while page_ref is not None:
                if page_ref.key in seen_pages:
                    raise OfflineReadingPackageError("retained index contains a cycle")
                seen_pages.add(page_ref.key)
                index = _parse_retained(
                    ReaderPublicationIndexPage.model_validate_json,
                    stage(
                        page_ref.key, "index", ref=page_ref, maximum_bytes=limits.index_bytes
                    ).read_bytes(),
                )
                for position in index.units:
                    unit = _parse_retained(
                        ReaderPublicationUnitBody.model_validate_json,
                        stage(
                            position.member.key,
                            "unit",
                            ref=position.member,
                            maximum_bytes=limits.unit_bytes,
                        ).read_bytes(),
                    )
                    for asset in unit.assets:
                        if isinstance(asset, ReaderPublicationCapturedAsset):
                            stage(asset.member.key, "asset", ref=asset.member)
                    del unit
                page_ref = index.next_ref
            page_ref = descriptor.contents_ref
            while page_ref is not None:
                if page_ref.key in seen_pages:
                    raise OfflineReadingPackageError("retained contents contains a cycle")
                seen_pages.add(page_ref.key)
                contents = _parse_retained(
                    ReaderPublicationIndexPage.model_validate_json,
                    stage(
                        page_ref.key, "index", ref=page_ref, maximum_bytes=limits.index_bytes
                    ).read_bytes(),
                )
                if (
                    contents.units
                    or contents.anchors
                    or contents.table_metadata
                    or contents.landmarks
                    or contents.page_list
                ):
                    raise OfflineReadingPackageError("contents contains non-display records")
                page_ref = contents.next_ref
            page_ref = descriptor.table_metadata_ref
            while page_ref is not None:
                if page_ref.key in seen_pages:
                    raise OfflineReadingPackageError("retained table metadata contains a cycle")
                seen_pages.add(page_ref.key)
                metadata = _parse_retained(
                    ReaderPublicationIndexPage.model_validate_json,
                    stage(
                        page_ref.key, "index", ref=page_ref, maximum_bytes=limits.index_bytes
                    ).read_bytes(),
                )
                if not metadata.table_metadata:
                    raise OfflineReadingPackageError("table metadata page is empty")
                page_ref = metadata.next_ref
        manifest = build_offline_reading_manifest_from_entries(
            media_id=media_id,
            media_kind={"pdf": "Pdf", "epub": "Epub", "web_article": "WebArticle"}[descriptor.kind],
            title=descriptor.title,
            reader_generation=generation,
            entries=entries.values(),
        )
        yield StagedReaderPublication(manifest, members, expanded)


def build_offline_reading_archive_file(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    generation: int,
    limits: ReaderPublicationLimits,
    path: str | os.PathLike[str],
) -> OfflineReadingArchive:
    """Copy a retained generation; never reconstruct or rewrite its reading text."""
    with stage_reader_publication_members(
        session_factory,
        media_id=media_id,
        generation=generation,
        limits=limits,
        parent_directory=Path(path).parent,
    ) as staged:
        compressed = assemble_offline_reading_zip_from_files(
            staged.manifest, staged.members, path, publication_limits=limits
        )
    digest = hashlib.sha256()
    with Path(path).open("rb") as package_file:
        for chunk in iter(lambda: package_file.read(1024 * 1024), b""):
            digest.update(chunk)
    digest_bytes = digest.digest()
    return OfflineReadingArchive(
        media_type=OFFLINE_READING_ZIP_MEDIA_TYPE,
        compressed_length=compressed,
        account_independent_digest=digest_bytes.hex(),
        content_digest=f"sha-256=:{base64.b64encode(digest_bytes).decode('ascii')}:",
        expanded_length=staged.expanded_length,
        reader_generation=generation,
        reader_revision_key=staged.manifest.reader_revision_key,
    )
