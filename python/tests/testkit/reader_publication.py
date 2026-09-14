"""Shared reader-publication scenario scaffolding: rows and payloads, no verdicts.

Every proof that needs a real PDF byte payload, the small publication limits that
keep fixtures inside one page, physical media teardown, or a seeded retained
publication takes it from here. Proof modules never import each other, so a
pinned proof's scenario cannot be changed by editing a sibling proof.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import fitz
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.config import ReaderPublicationLimits
from nexus.db.models import (
    Media,
    ReaderPublication,
    ReaderPublicationArtifact,
    ReaderPublicationUnit,
)
from nexus.ids import new_uuid7
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from tests.testkit.auth import UserRecord

FIXTURE_LIMITS = ReaderPublicationLimits(
    unit_bytes=1100,
    unit_codepoints=160,
    unit_dom_nodes=20,
    index_bytes=2000,
    descriptor_bytes=1000,
)


def pdf_payload(text: str) -> bytes:
    """One real single-page PDF whose only text is `text`."""
    document = fitz.open()
    document.new_page(width=595, height=842).insert_text((72, 72), text)
    payload: bytes = document.tobytes()
    document.close()
    return payload


def delete_media(engine: Engine, media_id: UUID) -> None:
    """Physically remove a fixture media through its deletion owner."""
    with Session(engine) as db:
        delete_document_media_if_unreferenced(db, media_id)
        db.commit()


def seed_retained_text(
    db_session: Session,
    test_user: UserRecord,
    chunks: tuple[str, ...],
    boundaries: tuple[int, ...],
) -> tuple[UUID, UUID]:
    """Seed generation 1 units over `chunks` under a current generation 2."""
    media_id, fragment_id = uuid4(), uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind="web_article",
            title="Retained query proof",
            processing_status="ready_for_reading",
            created_by_user_id=test_user.id,
        )
    )
    db_session.flush()
    ensure_media_in_default_library(db_session, test_user.id, media_id)
    db_session.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=2))
    for generation in (1, 2):
        db_session.add(
            ReaderPublicationArtifact(
                media_id=media_id,
                generation=generation,
                path="descriptor.json",
                role="descriptor",
                storage_path=f"proof/{media_id}/{generation}/descriptor",
                media_type="application/json",
                size_bytes=2,
                sha256="0" * 64,
            )
        )
    position = 0
    for ordinal, chunk in enumerate(chunks):
        key = f"units/{ordinal}.json"
        db_session.add(
            ReaderPublicationArtifact(
                media_id=media_id,
                generation=1,
                path=key,
                role="unit",
                storage_path=f"proof/{media_id}/{key}",
                media_type="application/json",
                size_bytes=100,
                sha256="1" * 64,
            )
        )
        db_session.flush()
        db_session.add(
            ReaderPublicationUnit(
                embed_markers=[],
                media_id=media_id,
                generation=1,
                unit_key=key,
                ordinal=ordinal,
                fragment_id=fragment_id,
                fragment_idx=0,
                start_cp=position,
                end_cp=position + len(chunk),
                canonical_text=chunk,
                word_boundaries=[
                    point for point in boundaries if position <= point <= position + len(chunk)
                ],
            )
        )
        position += len(chunk)
    db_session.flush()
    return media_id, fragment_id
