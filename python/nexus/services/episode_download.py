"""Capture one authorized episode from the caller's repeatable-read snapshot.

Rendition and notes identify the recording's published presentation. Transcript
identity covers the complete serialized reader response; retries must name both
captured identities and never substitute a later body. This read writes nothing.
"""

import hashlib
import html
import json
from uuid import UUID

import lxml.etree as etree
from lxml.html import fragment_fromstring
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError
from nexus.responses import Data
from nexus.schemas import episode_download as wire
from nexus.schemas.reader_document import ReaderTranscriptDocumentOut
from nexus.services.consumption import state
from nexus.services.image_placeholder import replace_image_with_placeholder
from nexus.services.reader_document import read_reader_document


def capture(db: Session, viewer_id: UUID, media_id: UUID) -> wire.EpisodeDownloadOut:
    return _capture(db, viewer_id, media_id)[0]


def _capture(
    db: Session, viewer_id: UUID, media_id: UUID
) -> tuple[wire.EpisodeDownloadOut, bytes | None]:
    activation = state.get_player(db, viewer_id, media_id)
    descriptor = activation.descriptor
    row = db.execute(
        text("""SELECT pe.duration_seconds, pe.description_html, pe.description_text,
                       mts.transcript_state, statement_timestamp() AS captured_at
                FROM podcast_episodes pe
                LEFT JOIN media_transcript_states mts ON mts.media_id = pe.media_id
                WHERE pe.media_id = :id"""),
        {"id": media_id},
    ).one()
    rendition = wire.EpisodeRenditionOut(
        title=descriptor.title,
        subtitle=descriptor.subtitle,
        podcast_id=descriptor.podcast_id,
        stream_url=descriptor.stream_url,
        artwork_url=descriptor.artwork_url,
        duration_ms=None if row.duration_seconds is None else row.duration_seconds * 1000,
        chapters=descriptor.chapters,
    )
    notes: (
        wire.EpisodeContentAbsent | wire.EpisodeShowNotesAvailable | wire.EpisodeContentUnavailable
    )
    markup = row.description_html or (
        f"<p>{html.escape(row.description_text)}</p>" if row.description_text else None
    )
    if markup is None:
        notes = wire.EpisodeContentAbsent(kind="Absent")
    else:
        body = fragment_fromstring(markup, create_parent=True)
        for image in list(body.iter("img")):
            replace_image_with_placeholder(image)
        rendered = html.escape(body.text or "", quote=False) + "".join(
            etree.tostring(child, encoding="unicode", method="html") for child in body
        )
        notes = (
            wire.EpisodeContentUnavailable(kind="Unavailable", reason="TooLarge")
            if len(rendered.encode("utf-8")) > 512 * 1024
            else wire.EpisodeShowNotesAvailable(kind="Available", html=rendered)
        )
    source = json.dumps(
        {
            "rendition": rendition.model_dump(mode="json"),
            "show_notes": notes.model_dump(mode="json"),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    transcript: (
        wire.EpisodeContentAbsent | wire.EpisodeTranscriptAvailable | wire.EpisodeContentUnavailable
    )
    encoded: bytes | None = None
    if row.transcript_state in ("ready", "partial"):
        document, encoded = _transcript(db, viewer_id, media_id)
        transcript = (
            wire.EpisodeContentUnavailable(kind="Unavailable", reason="TooLarge")
            if len(encoded) > 8 * 1024 * 1024
            else wire.EpisodeTranscriptAvailable(
                kind="Available",
                sha256=hashlib.sha256(encoded).hexdigest(),
                byte_count=len(encoded),
                coverage=document.transcript_coverage,
            )
        )
    elif row.transcript_state in (None, "not_requested"):
        transcript = wire.EpisodeContentAbsent(kind="Absent")
    else:
        transcript = wire.EpisodeContentUnavailable(kind="Unavailable", reason="E_MEDIA_NOT_READY")
    return wire.EpisodeDownloadOut(
        format_version=1,
        media_id=media_id,
        captured_at=row.captured_at,
        source_key=hashlib.sha256(source).hexdigest(),
        rendition=rendition,
        playback_baseline=wire.EpisodePlaybackBaselineOut(
            observation=activation.observation,
            playback_rate=descriptor.playback_rate,
            pause_shortening_mode=descriptor.pause_shortening_mode,
        ),
        show_notes=notes,
        transcript=transcript,
    ), encoded


def transcript(db: Session, viewer_id: UUID, media_id: UUID, source_key: str, sha256: str) -> bytes:
    current, encoded = _capture(db, viewer_id, media_id)
    if (
        current.source_key != source_key
        or not isinstance(current.transcript, wire.EpisodeTranscriptAvailable)
        or current.transcript.sha256 != sha256
    ):
        raise ConflictError(
            ApiErrorCode.E_EPISODE_DOWNLOAD_CHANGED, "The captured episode content changed"
        )
    if encoded is None:
        raise AssertionError(
            "available captured transcript has no bytes"
        )  # justify-defect: available metadata is built from these bytes
    return encoded


def _transcript(
    db: Session, viewer_id: UUID, media_id: UUID
) -> tuple[ReaderTranscriptDocumentOut, bytes]:
    document = read_reader_document(db, viewer_id, media_id)
    if not isinstance(document, ReaderTranscriptDocumentOut):
        raise AssertionError(
            "episode reader returned a non-transcript document"
        )  # justify-defect: capture authorized a podcast episode
    return document, Data(data=document).model_dump_json().encode("utf-8")
