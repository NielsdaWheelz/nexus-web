"""Conversation and Message service layer.

Read visibility: shared read allowed via canonical visibility predicate
(owner, public, or library-shared with active dual membership).
Write boundary: owner-only for all mutation operations.

Error masking: E_CONVERSATION_NOT_FOUND / E_MESSAGE_NOT_FOUND consistently (prevent probing).
Pagination: cursor-based, ordered by updated_at DESC, id DESC.

Conversation access helpers:
- get_conversation_for_visible_read_or_404: read path (visibility predicate)
- get_conversation_for_owner_write_or_404: write path (owner-only)

Service functions correspond 1:1 with route handlers.
Routes are transport-only and call exactly one service function.
"""

import base64
import csv
import hashlib
import html
import io
import json
import textwrap
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session, joinedload

from nexus.auth.permissions import can_read_conversation, can_read_media, is_library_member
from nexus.db.models import (
    AssistantMessageVerifierRun,
    ChatRun,
    Conversation,
    EvidenceSpan,
    Library,
    Media,
    Message,
    MessageArtifact,
    MessageArtifactExport,
    MessageArtifactPart,
    MessageContextItem,
    MessageRerankLedger,
    MessageRetrieval,
    MessageRetrievalCandidateLedger,
    MessageToolCall,
)
from nexus.errors import (
    CHAT_RESPONSE_RETRYABLE_ERROR_CODES,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.evidence_span_ids import trusted_evidence_span_ids
from nexus.logging import get_logger
from nexus.schemas.conversation import (
    BRANCH_ANCHOR_KINDS,
    MESSAGE_ARTIFACT_KINDS,
    ArtifactIntentOptions,
    AssistantMessageBranchAnchorRequest,
    AssistantVerifierRunOut,
    ChatRunCreateRequest,
    ConversationOut,
    ConversationScopeOut,
    ConversationScopeRequest,
    MessageArtifactAskRequest,
    MessageArtifactCitationEntryOut,
    MessageArtifactCitationManifestOut,
    MessageArtifactContextSnapshot,
    MessageArtifactCreateRequest,
    MessageArtifactExportLedgerOut,
    MessageArtifactExportOut,
    MessageArtifactOut,
    MessageArtifactPartContextSnapshot,
    MessageArtifactPartCreateRequest,
    MessageArtifactPartOut,
    MessageArtifactPartProvenance,
    MessageContextRef,
    MessageContextSnapshot,
    MessageContextSnapshotOut,
    MessageDocument,
    MessageOut,
    MessageRerankLedgerOut,
    MessageRetrievalCandidateLedgerOut,
    PageInfo,
)
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.context_lookup import hydrate_context_ref, hydrate_source_ref
from nexus.services.contexts import reader_selection_message_snapshot_from_row
from nexus.services.contributor_credits import load_contributor_credits_for_media
from nexus.services.conversation_memory import conversation_memory_inspection
from nexus.services.message_context_snapshots import (
    artifact_context_snapshot_fields,
    artifact_part_context_ref,
    artifact_part_context_snapshot_fields,
    trusted_content_chunk_context_snapshot_fields,
    trusted_context_snapshot,
    trusted_object_ref_context_snapshot_payload,
)

logger = get_logger(__name__)


# =============================================================================
# Constants
# =============================================================================

# Pagination limits
DEFAULT_LIMIT = 50
MIN_LIMIT = 1
MAX_LIMIT = 100
DEFAULT_CONVERSATION_TITLE = "Chat"
MAX_CONVERSATION_TITLE_LENGTH = 120


# =============================================================================
# Cursor Encoding/Decoding
# =============================================================================


def _encode_cursor(payload: dict[str, object]) -> str:
    """Encode a cursor payload as base64url without padding."""
    json_bytes = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def _decode_cursor[T](cursor: str, extract: Callable[[dict[str, Any]], T]) -> T:
    """Decode a base64url cursor and project it with `extract`.

    Raises InvalidRequestError on any decode/projection failure.
    """
    try:
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding
        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))
        return extract(payload)
    except (ValueError, KeyError, TypeError):
        # justify-ignore-error: expected malformed-cursor failures from the
        # base64url/JSON decode path and from `extract` parsing primitive
        # fields (int/UUID/datetime). Other exceptions propagate.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def encode_conversation_cursor(updated_at: datetime, id: UUID) -> str:
    return _encode_cursor({"updated_at": updated_at.isoformat(), "id": str(id)})


def decode_conversation_cursor(cursor: str) -> tuple[datetime, UUID]:
    return _decode_cursor(
        cursor, lambda p: (datetime.fromisoformat(p["updated_at"]), UUID(p["id"]))
    )


def encode_message_cursor(seq: int, id: UUID) -> str:
    return _encode_cursor({"seq": seq, "id": str(id)})


def decode_message_cursor(cursor: str) -> tuple[int, UUID]:
    return _decode_cursor(cursor, lambda p: (int(p["seq"]), UUID(p["id"])))


def _conversation_cursor_clause(cursor: str | None) -> tuple[str, dict[str, object]]:
    """SQL fragment + bound params for conversation pagination, or empty when no cursor."""
    if not cursor:
        return "", {}
    updated_at, conversation_id = decode_conversation_cursor(cursor)
    return (
        "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)",
        {"cursor_updated_at": updated_at, "cursor_id": conversation_id},
    )


# =============================================================================
# Helper Functions
# =============================================================================


def clamp_limit(limit: int) -> int:
    """Clamp limit to valid range [MIN_LIMIT, MAX_LIMIT]."""
    return min(max(limit, MIN_LIMIT), MAX_LIMIT)


def derive_conversation_title(content: str | None) -> str:
    """Derive a conversation title from user content.

    Empty or whitespace-only input falls back to the default title.
    """
    if content is None:
        return DEFAULT_CONVERSATION_TITLE
    normalized = " ".join(content.split()).strip()
    if not normalized:
        return DEFAULT_CONVERSATION_TITLE
    return normalized[:MAX_CONVERSATION_TITLE_LENGTH].rstrip()


def get_conversation_for_visible_read_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    """Load conversation and verify canonical read visibility.

    Visible iff viewer is owner, or conversation is public, or conversation is
    library-shared with both viewer and owner as members of a share-target library.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer cannot read it.
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return conversation


def get_conversation_for_owner_write_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    """Load conversation and verify owner-only write access.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            OR viewer is not the owner.
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return conversation


def get_message_count(db: Session, conversation_id: UUID) -> int:
    """Get the count of messages in a conversation."""
    result = db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation_id)
    )
    return result or 0


def _artifact_part_to_out(part: MessageArtifactPart) -> MessageArtifactPartOut:
    return MessageArtifactPartOut(
        id=part.id,
        artifact_id=part.artifact_id,
        ordinal=part.ordinal,
        part_key=part.part_key,
        part_type=part.part_type,
        text=part.part_text,
        source_version=part.source_version,
        locator=cast(Any, part.locator),
        source_ref=cast(Any, part.source_ref),
        context_ref=cast(Any, part.context_ref),
        result_ref=cast(Any, part.result_ref),
        evidence_span_id=part.evidence_span_id,
        evidence_span_ids=trusted_evidence_span_ids(part.evidence_span_ids),
        source_refs=cast(Any, part.source_refs),
        metadata=part.metadata_json,
        created_at=part.created_at,
    )


def _artifact_to_out(artifact: MessageArtifact) -> MessageArtifactOut:
    return MessageArtifactOut(
        id=artifact.id,
        conversation_id=artifact.conversation_id,
        message_id=artifact.message_id,
        chat_run_id=artifact.chat_run_id,
        artifact_key=artifact.artifact_key,
        artifact_version=artifact.artifact_version,
        supersedes_artifact_id=artifact.supersedes_artifact_id,
        # artifact_kind and status are Text columns constrained to the literal
        # sets by CHECK constraints ck_message_artifacts_kind_supported and
        # ck_message_artifacts_status, so the casts narrow validated DB values.
        artifact_kind=cast(MESSAGE_ARTIFACT_KINDS, artifact.artifact_kind),
        title=artifact.title,
        status=cast(Literal["streaming", "complete", "error"], artifact.status),
        preview_text=artifact.preview_text,
        metadata=artifact.metadata_json,
        parts=[_artifact_part_to_out(part) for part in artifact.parts],
        created_at=artifact.created_at,
        updated_at=artifact.updated_at,
    )


def conversation_to_out(
    db: Session,
    conversation: Conversation,
    message_count: int,
    viewer_id: UUID | None = None,
) -> ConversationOut:
    """Convert Conversation ORM model to ConversationOut schema.

    Args:
        conversation: The ORM conversation.
        message_count: Pre-computed message count.
        viewer_id: The viewing user. Used to compute is_owner.
    """
    return ConversationOut(
        id=conversation.id,
        title=conversation.title,
        owner_user_id=conversation.owner_user_id,
        is_owner=(viewer_id is not None and conversation.owner_user_id == viewer_id),
        sharing=conversation.sharing,
        scope=conversation_scope_to_out(db, conversation),
        message_count=message_count,
        memory=conversation_memory_inspection(db, conversation_id=conversation.id),
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def conversation_scope_to_out(db: Session, conversation: Conversation) -> ConversationScopeOut:
    if conversation.scope_type == "general":
        return ConversationScopeOut(type="general")

    if conversation.scope_type == "media":
        media = db.get(Media, conversation.scope_media_id) if conversation.scope_media_id else None
        if media is None:
            return ConversationScopeOut(type="media", media_id=conversation.scope_media_id)
        contributors = load_contributor_credits_for_media(db, [media.id]).get(media.id, [])
        return ConversationScopeOut(
            type="media",
            media_id=media.id,
            title=media.title,
            media_kind=media.kind,
            contributors=contributors,
            published_date=media.published_date,
            publisher=media.publisher,
            canonical_source_url=media.canonical_source_url,
        )

    if conversation.scope_type == "library":
        library = (
            db.get(Library, conversation.scope_library_id)
            if conversation.scope_library_id
            else None
        )
        if library is None:
            return ConversationScopeOut(type="library", library_id=conversation.scope_library_id)
        rows = db.execute(
            text(
                """
                SELECT COUNT(le.media_id), array_remove(array_agg(DISTINCT m.kind), NULL)
                FROM library_entries le
                LEFT JOIN media m ON m.id = le.media_id
                WHERE le.library_id = :library_id
                """
            ),
            {"library_id": library.id},
        ).one()
        return ConversationScopeOut(
            type="library",
            library_id=library.id,
            title=library.name,
            library_name=library.name,
            entry_count=int(rows[0] or 0),
            media_kinds=list(rows[1] or []),
            source_policy="library_membership",
        )

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def conversation_scope_metadata(db: Session, conversation: Conversation) -> dict[str, object]:
    scope = conversation_scope_to_out(db, conversation)
    return scope.model_dump(mode="json")


def authorize_conversation_scope(
    db: Session,
    viewer_id: UUID,
    conversation_scope: ConversationScopeRequest,
) -> None:
    if conversation_scope.type == "general":
        return

    if conversation_scope.type == "media":
        media_id = conversation_scope.media_id
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
        return

    if conversation_scope.type == "library":
        library_id = conversation_scope.library_id
        if library_id is None or not is_library_member(db, viewer_id, library_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library not found")
        return

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def _lock_scoped_conversation(
    db: Session, viewer_id: UUID, scope_type: str, scope_id: UUID
) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"conversation_scope:{viewer_id}:{scope_type}:{scope_id}"},
    )


def resolve_conversation_for_scope(
    db: Session,
    viewer_id: UUID,
    conversation_scope: ConversationScopeRequest,
    title_content: str | None = None,
) -> Conversation:
    authorize_conversation_scope(db, viewer_id, conversation_scope)

    if conversation_scope.type == "general":
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=derive_conversation_title(title_content),
            sharing="private",
            scope_type="general",
            scope_media_id=None,
            scope_library_id=None,
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
        return conversation

    if conversation_scope.type == "media":
        media = db.get(Media, conversation_scope.media_id) if conversation_scope.media_id else None
        if conversation_scope.media_id is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Media scope requires media_id"
            )
        _lock_scoped_conversation(db, viewer_id, "media", conversation_scope.media_id)
        conversation = (
            db.execute(
                select(Conversation).where(
                    Conversation.owner_user_id == viewer_id,
                    Conversation.scope_type == "media",
                    Conversation.scope_media_id == conversation_scope.media_id,
                )
            )
            .scalars()
            .first()
        )
        if conversation is not None:
            return conversation
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=media.title if media is not None else DEFAULT_CONVERSATION_TITLE,
            sharing="private",
            scope_type="media",
            scope_media_id=conversation_scope.media_id,
            scope_library_id=None,
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
        return conversation

    if conversation_scope.type == "library":
        if conversation_scope.library_id is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Library scope requires library_id",
            )
        library = db.get(Library, conversation_scope.library_id)
        _lock_scoped_conversation(db, viewer_id, "library", conversation_scope.library_id)
        conversation = (
            db.execute(
                select(Conversation).where(
                    Conversation.owner_user_id == viewer_id,
                    Conversation.scope_type == "library",
                    Conversation.scope_library_id == conversation_scope.library_id,
                )
            )
            .scalars()
            .first()
        )
        if conversation is not None:
            return conversation
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=library.name if library is not None else DEFAULT_CONVERSATION_TITLE,
            sharing="private",
            scope_type="library",
            scope_media_id=None,
            scope_library_id=conversation_scope.library_id,
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
        return conversation

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def message_to_out(
    message: Message,
    contexts: list[MessageContextSnapshotOut] | None = None,
    artifacts: list[MessageArtifactOut] | None = None,
    can_retry_response: bool = False,
) -> MessageOut:
    """Convert Message ORM model to MessageOut schema."""
    branch_anchor = {"kind": message.branch_anchor_kind, **(message.branch_anchor or {})}
    artifact_list = artifacts or []
    return MessageOut(
        id=message.id,
        seq=message.seq,
        role=message.role,
        message_document=_message_document_with_artifact_refs(
            message.message_document,
            artifact_list,
        ),
        parent_message_id=message.parent_message_id,
        branch_root_message_id=message.branch_root_message_id,
        branch_anchor_kind=cast(BRANCH_ANCHOR_KINDS, message.branch_anchor_kind),
        branch_anchor=branch_anchor,
        contexts=contexts or [],
        status=message.status,
        error_code=message.error_code,
        can_retry_response=can_retry_response,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def _message_document_with_artifact_refs(
    message_document: dict[str, object],
    artifacts: list[MessageArtifactOut],
) -> MessageDocument:
    blocks = message_document.get("blocks")
    if not artifacts or not isinstance(blocks, list):
        return MessageDocument.model_validate(message_document)

    by_key = {artifact.artifact_key: artifact for artifact in artifacts if artifact.artifact_key}
    by_id = {str(artifact.id): artifact for artifact in artifacts}
    next_blocks: list[object] = []
    seen_artifact_ids: set[str] = set()
    seen_artifact_keys: set[str] = set()
    changed = False
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "artifact_preview":
            next_blocks.append(block)
            continue
        artifact_ref = block.get("artifact_id")
        artifact = (by_id.get(artifact_ref) if isinstance(artifact_ref, str) else None) or (
            by_key.get(artifact_ref) if isinstance(artifact_ref, str) else None
        )
        if artifact is None:
            next_blocks.append(block)
            continue
        seen_artifact_ids.add(str(artifact.id))
        seen_artifact_keys.add(artifact.artifact_key)
        next_block = dict(block)
        next_block["durable_artifact_id"] = str(artifact.id)
        next_block["artifact_id"] = str(artifact.id)
        next_block.setdefault("artifact_key", artifact.artifact_key)
        if artifact.preview_text is not None:
            next_block.setdefault("delta", artifact.preview_text)
        if artifact.parts:
            next_block["parts"] = [_artifact_part_preview(part) for part in artifact.parts]
        next_blocks.append(next_block)
        changed = True

    for artifact in artifacts:
        if str(artifact.id) in seen_artifact_ids or artifact.artifact_key in seen_artifact_keys:
            continue
        next_blocks.append(
            {
                "type": "artifact_preview",
                "artifact_id": str(artifact.id),
                "durable_artifact_id": str(artifact.id),
                "artifact_key": artifact.artifact_key,
                "artifact_version": artifact.artifact_version,
                "supersedes_artifact_id": str(artifact.supersedes_artifact_id)
                if artifact.supersedes_artifact_id is not None
                else None,
                "artifact_kind": artifact.artifact_kind,
                "title": artifact.title,
                "status": artifact.status,
                "delta": artifact.preview_text,
                "parts": [_artifact_part_preview(part) for part in artifact.parts],
            }
        )
        changed = True

    if not changed:
        return MessageDocument.model_validate(message_document)
    return MessageDocument.model_validate({**message_document, "blocks": next_blocks})


def _artifact_part_preview(part: MessageArtifactPartOut) -> dict[str, object]:
    preview: dict[str, object] = {
        "id": str(part.id),
        "ordinal": part.ordinal,
        "source_version": part.source_version,
        "locator": part.locator.model_dump(mode="json"),
    }
    if part.part_key is not None:
        preview["part_key"] = part.part_key
    if part.part_type is not None:
        preview["part_type"] = part.part_type
    if part.text is not None:
        preview["text"] = part.text
    if part.source_ref is not None:
        preview["source_ref"] = part.source_ref.model_dump(
            mode="json",
            exclude_none=True,
            exclude_defaults=True,
        )
    if part.context_ref is not None:
        preview["context_ref"] = part.context_ref.model_dump(mode="json")
    if part.result_ref is not None:
        preview["result_ref"] = part.result_ref.model_dump(mode="json")
    if part.evidence_span_id is not None:
        preview["evidence_span_id"] = str(part.evidence_span_id)
    if part.evidence_span_ids:
        preview["evidence_span_ids"] = [str(value) for value in part.evidence_span_ids]
    if part.source_refs:
        preview["source_refs"] = [
            source_ref.model_dump(
                mode="json",
                exclude_none=True,
                exclude_defaults=True,
            )
            for source_ref in part.source_refs
        ]
    return preview


def retryable_assistant_message_ids(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_ids: Sequence[UUID],
) -> set[UUID]:
    if not assistant_message_ids:
        return set()

    rows = db.scalars(
        select(ChatRun.assistant_message_id)
        .join(Message, Message.id == ChatRun.assistant_message_id)
        .where(
            ChatRun.owner_user_id == viewer_id,
            ChatRun.assistant_message_id.in_(assistant_message_ids),
            ChatRun.status == "error",
            ChatRun.error_code.in_(CHAT_RESPONSE_RETRYABLE_ERROR_CODES),
            Message.role == "assistant",
            Message.status == "error",
        )
    )
    return set(rows)


def load_message_context_snapshots_for_message_ids(
    db: Session,
    message_ids: list[UUID],
) -> dict[UUID, list[MessageContextSnapshotOut]]:
    """Load typed context snapshots for the given messages."""

    if not message_ids:
        return {}

    snapshots_by_message_id: dict[UUID, list[MessageContextSnapshotOut]] = {
        message_id: [] for message_id in message_ids
    }
    context_rows = db.scalars(
        select(MessageContextItem)
        .where(MessageContextItem.message_id.in_(message_ids))
        .order_by(MessageContextItem.message_id.asc(), MessageContextItem.ordinal.asc())
    ).all()
    for row in context_rows:
        if row.context_kind == "reader_selection":
            snapshots_by_message_id.setdefault(row.message_id, []).append(
                reader_selection_message_snapshot_from_row(row)
            )
            continue

        stored = trusted_context_snapshot(row.context_snapshot_json)
        payload = trusted_object_ref_context_snapshot_payload(
            object_type=row.object_type,
            object_id=row.object_id,
            payload=stored,
        )
        if row.object_type == "content_chunk":
            payload.update(
                trusted_content_chunk_context_snapshot_fields(
                    object_type=row.object_type,
                    object_id=row.object_id,
                    payload=stored,
                )
            )
        if row.object_type == "artifact":
            payload.update(artifact_context_snapshot_fields(stored))
            snapshots_by_message_id.setdefault(row.message_id, []).append(
                MessageArtifactContextSnapshot.model_validate(payload)
            )
            continue
        if row.object_type == "artifact_part":
            payload.update(artifact_part_context_snapshot_fields(stored))
            snapshots_by_message_id.setdefault(row.message_id, []).append(
                MessageArtifactPartContextSnapshot.model_validate(payload)
            )
            continue
        snapshots_by_message_id.setdefault(row.message_id, []).append(
            MessageContextSnapshot.model_validate(payload)
        )

    return snapshots_by_message_id


def load_message_artifacts_for_message_ids(
    db: Session,
    message_ids: Sequence[UUID],
) -> dict[UUID, list[MessageArtifactOut]]:
    """Load durable generated artifacts for the given messages."""
    if not message_ids:
        return {}

    artifacts = (
        db.execute(
            select(MessageArtifact)
            .options(joinedload(MessageArtifact.parts))
            .where(MessageArtifact.message_id.in_(message_ids))
            .order_by(MessageArtifact.created_at.asc(), MessageArtifact.id.asc())
        )
        .unique()
        .scalars()
        .all()
    )
    artifacts_by_message_id: dict[UUID, list[MessageArtifactOut]] = {}
    for artifact in artifacts:
        artifacts_by_message_id.setdefault(artifact.message_id, []).append(
            _artifact_to_out(artifact)
        )
    return artifacts_by_message_id


# =============================================================================
# Service Functions
# =============================================================================


def create_conversation(db: Session, viewer_id: UUID) -> ConversationOut:
    """Create a new empty private conversation.

    Args:
        db: Database session.
        viewer_id: The ID of the user creating the conversation.

    Returns:
        The created conversation with message_count=0.
    """
    conversation = Conversation(
        owner_user_id=viewer_id,
        title=DEFAULT_CONVERSATION_TITLE,
        sharing="private",
        scope_type="general",
        next_seq=1,
    )

    db.add(conversation)
    db.flush()
    db.commit()

    return conversation_to_out(db, conversation, message_count=0, viewer_id=viewer_id)


def resolve_conversation(
    db: Session,
    viewer_id: UUID,
    conversation_scope: ConversationScopeRequest,
) -> ConversationOut:
    conversation = resolve_conversation_for_scope(db, viewer_id, conversation_scope)
    db.commit()
    return conversation_to_out(
        db,
        conversation,
        get_message_count(db, conversation.id),
        viewer_id=viewer_id,
    )


def get_conversation(db: Session, viewer_id: UUID, conversation_id: UUID) -> ConversationOut:
    """Get a conversation by ID.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation.

    Returns:
        The conversation with message_count.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
    """
    conversation = get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    message_count = get_message_count(db, conversation_id)
    return conversation_to_out(db, conversation, message_count, viewer_id=viewer_id)


VALID_SCOPES = {"mine", "all", "shared"}


def _build_visibility_cte(viewer_id: UUID) -> str:
    """Return a SQL CTE that selects conversation IDs visible to viewer.

    Visible means:
    - Owner, OR
    - Public, OR
    - Library-shared with active dual membership (viewer + owner in share-target library)
    """
    return """
        visible_conversations AS (
            SELECT c.id
            FROM conversations c
            WHERE c.owner_user_id = :viewer_id
            UNION
            SELECT c.id
            FROM conversations c
            WHERE c.sharing = 'public'
            UNION
            SELECT c.id
            FROM conversations c
            JOIN conversation_shares cs ON cs.conversation_id = c.id
            JOIN memberships vm ON vm.library_id = cs.library_id AND vm.user_id = :viewer_id
            JOIN memberships om ON om.library_id = cs.library_id AND om.user_id = c.owner_user_id
            WHERE c.sharing = 'library'
        )
    """


def list_conversations(
    db: Session,
    viewer_id: UUID,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
    scope: str = "mine",
) -> tuple[list[ConversationOut], PageInfo]:
    """List conversations with scope-based visibility.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        limit: Maximum number of results (clamped to 1-100).
        cursor: Opaque pagination cursor.
        scope: One of 'mine' (default), 'all', 'shared'.

    Returns:
        Tuple of (conversations, page_info).

    Raises:
        InvalidRequestError(E_INVALID_REQUEST): If scope is invalid.
        InvalidRequestError(E_INVALID_CURSOR): If cursor is malformed.
    """
    if scope not in VALID_SCOPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid scope: {scope}. Must be one of: mine, all, shared",
        )

    limit = clamp_limit(limit)

    if scope == "mine":
        return _list_conversations_mine(db, viewer_id, limit, cursor)
    else:
        return _list_conversations_visible(db, viewer_id, limit, cursor, scope)


def _list_conversations_mine(
    db: Session,
    viewer_id: UUID,
    limit: int,
    cursor: str | None,
) -> tuple[list[ConversationOut], PageInfo]:
    """List only conversations owned by viewer (scope=mine)."""
    params: dict = {"viewer_id": viewer_id, "limit": limit + 1}
    cursor_clause, cursor_params = _conversation_cursor_clause(cursor)
    params.update(cursor_params)

    result = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
                   c.scope_type, c.scope_media_id, c.scope_library_id,
                   sm.title AS scope_media_title, sm.kind AS scope_media_kind,
                   sl.name AS scope_library_name
            FROM conversations c
            LEFT JOIN media sm ON sm.id = c.scope_media_id
            LEFT JOIN libraries sl ON sl.id = c.scope_library_id
            WHERE c.owner_user_id = :viewer_id
              {cursor_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit
        """),
        params,
    )

    return _build_conversation_page(result.fetchall(), limit, viewer_id)


def _list_conversations_visible(
    db: Session,
    viewer_id: UUID,
    limit: int,
    cursor: str | None,
    scope: str,
) -> tuple[list[ConversationOut], PageInfo]:
    """List visible conversations (scope=all or scope=shared).

    Visibility predicate is applied in SQL before cursor+limit to maintain
    correct global cursor ordering.
    """
    params: dict = {"viewer_id": viewer_id, "limit": limit + 1}
    cursor_clause, cursor_params = _conversation_cursor_clause(cursor)
    params.update(cursor_params)

    scope_filter = ""
    if scope == "shared":
        scope_filter = "AND c.owner_user_id != :viewer_id"

    cte = _build_visibility_cte(viewer_id)

    result = db.execute(
        text(f"""
            WITH {cte}
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
                   c.scope_type, c.scope_media_id, c.scope_library_id,
                   sm.title AS scope_media_title, sm.kind AS scope_media_kind,
                   sl.name AS scope_library_name
            FROM conversations c
            JOIN visible_conversations vc ON vc.id = c.id
            LEFT JOIN media sm ON sm.id = c.scope_media_id
            LEFT JOIN libraries sl ON sl.id = c.scope_library_id
            WHERE true
              {scope_filter}
              {cursor_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit
        """),
        params,
    )

    return _build_conversation_page(result.fetchall(), limit, viewer_id)


def _build_conversation_page(
    rows: Sequence, limit: int, viewer_id: UUID
) -> tuple[list[ConversationOut], PageInfo]:
    """Build paginated response from raw rows."""
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    conversations = [
        ConversationOut(
            id=row[0],
            owner_user_id=row[1],
            title=row[2],
            is_owner=(row[1] == viewer_id),
            sharing=row[3],
            scope=_conversation_scope_out_from_row(row),
            created_at=row[4],
            updated_at=row[5],
            message_count=row[6],
        )
        for row in rows
    ]

    next_cursor = None
    if has_more and conversations:
        last = conversations[-1]
        next_cursor = encode_conversation_cursor(last.updated_at, last.id)

    return conversations, PageInfo(next_cursor=next_cursor)


def _conversation_scope_out_from_row(row: Sequence) -> ConversationScopeOut:
    scope_type = row[7]
    if scope_type == "general":
        return ConversationScopeOut(type="general")
    if scope_type == "media":
        return ConversationScopeOut(
            type="media",
            media_id=row[8],
            title=row[10],
            media_kind=row[11],
        )
    if scope_type == "library":
        return ConversationScopeOut(
            type="library",
            library_id=row[9],
            title=row[12],
            library_name=row[12],
            source_policy="library_membership",
        )
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def delete_conversation(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    """Delete a conversation.

    Cleans conversation-owned context memory, then deletes the conversation.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation to delete.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
    """
    # Verify ownership (write = owner-only)
    get_conversation_for_owner_write_or_404(db, viewer_id, conversation_id)

    delete_conversation_rows_without_commit(db, conversation_id)
    db.commit()


def list_messages(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> tuple[list[MessageOut], PageInfo]:
    """List messages in a conversation.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation.
        limit: Maximum number of results (clamped to 1-100).
        cursor: Opaque pagination cursor.

    Returns:
        Tuple of (messages, page_info).

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
        InvalidRequestError(E_INVALID_CURSOR): If cursor is malformed.
    """
    # Verify read visibility (shared readers can list messages too)
    get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)

    limit = clamp_limit(limit)

    rows = _selected_path_message_rows(db, viewer_id, conversation_id)
    if cursor:
        cursor_seq, cursor_id = decode_message_cursor(cursor)
        rows = [row for row in rows if (row[1], row[0]) > (cursor_seq, cursor_id)]

    # Check if there are more results
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    message_ids = [row[0] for row in rows]
    contexts_by_message_id = load_message_context_snapshots_for_message_ids(db, message_ids)
    artifacts_by_message_id = load_message_artifacts_for_message_ids(db, message_ids)
    retryable_message_ids = retryable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=message_ids,
    )
    messages = [
        MessageOut(
            id=row[0],
            seq=row[1],
            role=row[2],
            message_document=_message_document_with_artifact_refs(
                row[12],
                artifacts_by_message_id.get(row[0], []),
            ),
            parent_message_id=row[8],
            branch_root_message_id=row[9],
            branch_anchor_kind=row[10],
            branch_anchor={"kind": row[10], **(row[11] or {})},
            contexts=contexts_by_message_id.get(row[0], []),
            status=row[4],
            error_code=row[5],
            can_retry_response=row[0] in retryable_message_ids,
            created_at=row[6],
            updated_at=row[7],
        )
        for row in rows
    ]

    # Build next_cursor from last item
    next_cursor = None
    if has_more and messages:
        last = messages[-1]
        next_cursor = encode_message_cursor(last.seq, last.id)

    return messages, PageInfo(next_cursor=next_cursor)


def list_message_artifacts(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
) -> list[MessageArtifactOut]:
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    get_conversation_for_visible_read_or_404(db, viewer_id, message.conversation_id)
    return load_message_artifacts_for_message_ids(db, [message_id]).get(message_id, [])


def _assert_artifact_part_refs_readable(
    db: Session,
    *,
    viewer_id: UUID,
    part: MessageArtifactPartCreateRequest,
) -> None:
    source_refs = [part.source_ref] if part.source_ref is not None else []
    source_refs.extend(part.source_refs)
    for source_ref in source_refs:
        result = hydrate_source_ref(
            db,
            viewer_id=viewer_id,
            source_ref=source_ref.model_dump(mode="json", exclude_none=True),
        )
        if not result.resolved:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Artifact source_ref is not readable",
            )

    if part.context_ref is not None:
        result = hydrate_context_ref(
            db,
            viewer_id=viewer_id,
            context_ref=part.context_ref.model_dump(mode="json", exclude_none=True),
        )
        if not result.resolved:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Artifact context_ref is not readable",
            )

    if part.result_ref is not None:
        result_ref = part.result_ref.model_dump(mode="json", exclude_none=True)
        context_ref = result_ref.get("context_ref")
        if isinstance(context_ref, dict) and context_ref.get("type") != "web_result":
            result = hydrate_context_ref(db, viewer_id=viewer_id, context_ref=context_ref)
            if not result.resolved:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Artifact result_ref context is not readable",
                )

    for evidence_span_id in _artifact_part_evidence_span_ids(part):
        media_id = db.scalar(
            select(EvidenceSpan.media_id).where(EvidenceSpan.id == evidence_span_id)
        )
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Artifact evidence_span_id is not readable",
            )


def create_artifact(
    db: Session,
    *,
    viewer_id: UUID,
    request: MessageArtifactCreateRequest,
) -> MessageArtifactOut:
    message = db.get(Message, request.message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    get_conversation_for_owner_write_or_404(db, viewer_id, message.conversation_id)
    if message.role != "assistant":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Artifacts can only be attached to assistant messages",
        )
    if request.status != "error" and not request.parts:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Artifacts require structured parts",
        )
    db.execute(select(Message.id).where(Message.id == message.id).with_for_update()).scalar_one()
    previous = db.execute(
        select(MessageArtifact.id, MessageArtifact.artifact_version)
        .where(
            MessageArtifact.message_id == message.id,
            MessageArtifact.artifact_key == request.artifact_key,
        )
        .order_by(MessageArtifact.artifact_version.desc(), MessageArtifact.created_at.desc())
        .limit(1)
    ).first()

    artifact = MessageArtifact(
        conversation_id=message.conversation_id,
        message_id=message.id,
        chat_run_id=None,
        artifact_key=request.artifact_key,
        artifact_version=int(previous[1]) + 1 if previous is not None else 1,
        supersedes_artifact_id=previous[0] if previous is not None else None,
        artifact_kind=request.artifact_kind,
        title=request.title,
        status=request.status,
        preview_text=request.preview_text,
        metadata_json=request.metadata,
    )
    db.add(artifact)
    db.flush()
    for ordinal, part in enumerate(request.parts):
        _assert_artifact_part_refs_readable(db, viewer_id=viewer_id, part=part)
        evidence_span_ids = _artifact_part_evidence_span_ids(part)
        part_id = uuid4()
        locator = retrieval_locator_json(
            {
                "type": "artifact_part_ref",
                "artifact_id": str(artifact.id),
                "artifact_part_id": str(part_id),
                "message_id": str(message.id),
                "conversation_id": str(message.conversation_id),
                "part_key": part.part_key,
            }
        )
        if locator is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Artifact part locator is invalid",
            )
        db.add(
            MessageArtifactPart(
                id=part_id,
                artifact_id=artifact.id,
                ordinal=ordinal,
                part_key=part.part_key,
                part_type=part.part_type,
                part_text=part.text,
                source_version=f"artifact_part:{part_id}:v1",
                locator=locator,
                source_ref=part.source_ref.model_dump(mode="json") if part.source_ref else None,
                context_ref=part.context_ref.model_dump(mode="json") if part.context_ref else None,
                result_ref=part.result_ref.model_dump(mode="json") if part.result_ref else None,
                evidence_span_id=part.evidence_span_id,
                evidence_span_ids=[str(value) for value in evidence_span_ids],
                source_refs=[ref.model_dump(mode="json") for ref in part.source_refs],
                metadata_json=part.metadata,
            )
        )
    db.commit()
    db.refresh(artifact)
    return get_artifact(db, viewer_id=viewer_id, artifact_id=artifact.id)


def _artifact_part_evidence_span_ids(part: MessageArtifactPartCreateRequest) -> list[UUID]:
    evidence_span_ids = list(part.evidence_span_ids)
    if part.evidence_span_id is not None:
        evidence_span_ids.append(part.evidence_span_id)
    return evidence_span_ids


def get_artifact(
    db: Session,
    *,
    viewer_id: UUID,
    artifact_id: UUID,
) -> MessageArtifactOut:
    artifact = (
        db.execute(
            select(MessageArtifact)
            .options(joinedload(MessageArtifact.parts))
            .where(MessageArtifact.id == artifact_id)
        )
        .unique()
        .scalars()
        .first()
    )
    if artifact is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Artifact not found")
    get_conversation_for_visible_read_or_404(db, viewer_id, artifact.conversation_id)
    return _artifact_to_out(artifact)


ARTIFACT_EXPORT_FORMATS = ("markdown", "json", "html", "pdf", "csv")


def export_artifact(
    db: Session,
    *,
    viewer_id: UUID,
    artifact_id: UUID,
    export_format: str,
) -> MessageArtifactExportOut:
    if export_format not in ARTIFACT_EXPORT_FORMATS:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid artifact export format")

    artifact = get_artifact(db, viewer_id=viewer_id, artifact_id=artifact_id)
    manifest = _artifact_citation_manifest(artifact)
    content: str | dict[str, Any]
    if export_format == "markdown":
        content = _artifact_markdown(artifact)
    elif export_format == "json":
        content = {
            "artifact": artifact.model_dump(mode="json"),
            "citation_manifest": manifest.model_dump(mode="json"),
        }
    elif export_format == "html":
        content = _artifact_html(artifact)
    elif export_format == "csv":
        content = _artifact_csv(artifact)
    else:
        content = _artifact_pdf(artifact)

    content_sha256 = hashlib.sha256(
        _artifact_export_content_bytes(export_format, content)
    ).hexdigest()
    manifest_sha256 = hashlib.sha256(
        json.dumps(
            manifest.model_dump(mode="json"),
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    ledger = MessageArtifactExport(
        conversation_id=artifact.conversation_id,
        message_id=artifact.message_id,
        artifact_id=artifact.id,
        viewer_user_id=viewer_id,
        export_format=export_format,
        artifact_version=artifact.artifact_version,
        content_sha256=content_sha256,
        manifest_sha256=manifest_sha256,
        metadata_json={
            "artifact_key": artifact.artifact_key,
            "artifact_kind": artifact.artifact_kind,
            "part_count": len(artifact.parts),
        },
    )
    db.add(ledger)
    db.commit()
    db.refresh(ledger)

    return MessageArtifactExportOut(
        export_id=ledger.id,
        format=cast(Literal["markdown", "json", "html", "pdf", "csv"], export_format),
        artifact=artifact,
        artifact_version=artifact.artifact_version,
        citation_manifest=manifest,
        content_sha256=content_sha256,
        manifest_sha256=manifest_sha256,
        exported_at=ledger.created_at,
        content=content,
    )


def list_artifact_exports(
    db: Session,
    *,
    viewer_id: UUID,
    artifact_id: UUID,
) -> list[MessageArtifactExportLedgerOut]:
    artifact = db.get(MessageArtifact, artifact_id)
    if artifact is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Artifact not found")
    conversation = get_conversation_for_visible_read_or_404(db, viewer_id, artifact.conversation_id)
    statement = select(MessageArtifactExport).where(
        MessageArtifactExport.artifact_id == artifact.id
    )
    if conversation.owner_user_id != viewer_id:
        statement = statement.where(MessageArtifactExport.viewer_user_id == viewer_id)
    rows = db.scalars(
        statement.order_by(MessageArtifactExport.created_at.desc(), MessageArtifactExport.id.desc())
    ).all()
    return [
        MessageArtifactExportLedgerOut(
            id=row.id,
            conversation_id=row.conversation_id,
            message_id=row.message_id,
            artifact_id=row.artifact_id,
            viewer_user_id=row.viewer_user_id,
            format=cast(Literal["markdown", "json", "html", "pdf", "csv"], row.export_format),
            artifact_version=row.artifact_version,
            content_sha256=row.content_sha256,
            manifest_sha256=row.manifest_sha256,
            metadata=row.metadata_json,
            created_at=row.created_at,
        )
        for row in rows
    ]


def create_artifact_ask(
    db: Session,
    *,
    viewer_id: UUID,
    artifact_id: UUID,
    request: MessageArtifactAskRequest,
) -> ChatRunCreateRequest:
    artifact = get_artifact(db, viewer_id=viewer_id, artifact_id=artifact_id)
    part = None
    if request.artifact_part_id is not None:
        part = next(
            (candidate for candidate in artifact.parts if candidate.id == request.artifact_part_id),
            None,
        )
        if part is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Artifact part not found")
    if part is not None:
        context = artifact_part_context_ref(
            artifact_part_id=part.id,
            artifact_id=artifact.id,
            source_version=part.source_version,
            locator=part.locator,
            evidence_span_id=part.evidence_span_id,
            evidence_span_ids=part.evidence_span_ids,
            artifact_kind=artifact.artifact_kind,
            message_id=artifact.message_id,
            conversation_id=artifact.conversation_id,
            artifact_key=artifact.artifact_key,
            artifact_version=artifact.artifact_version,
            artifact_title=artifact.title,
            ordinal=part.ordinal,
            part_key=part.part_key,
            part_type=part.part_type,
            text=part.text,
            source_ref=part.source_ref,
            context_ref=part.context_ref,
            result_ref=part.result_ref,
            source_refs=part.source_refs,
            metadata=part.metadata,
        )
    else:
        context = MessageContextRef(
            type="artifact",
            id=artifact.id,
            artifact_id=artifact.id,
            artifact_key=artifact.artifact_key,
            artifact_version=artifact.artifact_version,
            artifact_part_provenance=_artifact_provenance(artifact),
        )
    payload = ChatRunCreateRequest(
        conversation_id=artifact.conversation_id,
        parent_message_id=artifact.message_id,
        branch_anchor=AssistantMessageBranchAnchorRequest(
            kind="assistant_message",
            message_id=artifact.message_id,
        ),
        content=request.content,
        model_id=request.model_id,
        reasoning=request.reasoning,
        key_mode=request.key_mode,
        contexts=[context],
        web_search=request.web_search,
        artifact_intent=ArtifactIntentOptions(kind="off"),
    )
    return payload


def _artifact_citation_manifest(
    artifact: MessageArtifactOut,
) -> MessageArtifactCitationManifestOut:
    return MessageArtifactCitationManifestOut(
        artifact_id=artifact.id,
        message_id=artifact.message_id,
        conversation_id=artifact.conversation_id,
        entries=[
            MessageArtifactCitationEntryOut(
                artifact_part_id=part.id,
                ordinal=part.ordinal,
                part_key=part.part_key,
                part_type=part.part_type,
                source_version=part.source_version,
                locator=part.locator,
                source_ref=part.source_ref,
                context_ref=part.context_ref,
                result_ref=part.result_ref,
                evidence_span_id=part.evidence_span_id,
                evidence_span_ids=part.evidence_span_ids,
                source_refs=part.source_refs,
                metadata=part.metadata,
            )
            for part in artifact.parts
        ],
    )


def _artifact_export_content_bytes(export_format: str, content: str | dict[str, Any]) -> bytes:
    if export_format == "json":
        return (
            json.dumps(content, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")
    if export_format == "pdf":
        return str(content).encode("latin-1")
    return str(content).encode("utf-8")


def _artifact_markdown(artifact: MessageArtifactOut) -> str:
    lines: list[str] = []
    if artifact.title:
        lines.extend([f"# {artifact.title}", ""])
    elif artifact.artifact_kind:
        lines.extend([f"# {artifact.artifact_kind.replace('_', ' ').title()}", ""])

    for part in artifact.parts:
        label = f"artifact-part-{part.ordinal + 1}"
        text_value = (part.text or "").strip()
        if part.part_type:
            lines.extend([f"## {part.part_type.replace('_', ' ').title()}", ""])
        if text_value:
            lines.extend([f"{text_value} [^{label}]", ""])

    if artifact.preview_text and not artifact.parts:
        lines.extend([artifact.preview_text.strip(), ""])

    if artifact.parts:
        lines.extend(["## Citation Manifest", ""])
        for part in artifact.parts:
            label = f"artifact-part-{part.ordinal + 1}"
            lines.append(f"[^{label}]: {_artifact_manifest_entry_json(part)}")

    return "\n".join(lines).strip() + "\n"


def _artifact_manifest_entry_json(part: MessageArtifactPartOut) -> str:
    return json.dumps(
        {
            "artifact_part_id": str(part.id),
            "ordinal": part.ordinal,
            "part_key": part.part_key,
            "part_type": part.part_type,
            "source_version": part.source_version,
            "locator": part.locator.model_dump(mode="json"),
            "source_ref": part.source_ref.model_dump(mode="json") if part.source_ref else None,
            "context_ref": part.context_ref.model_dump(mode="json") if part.context_ref else None,
            "result_ref": part.result_ref.model_dump(mode="json") if part.result_ref else None,
            "evidence_span_id": str(part.evidence_span_id) if part.evidence_span_id else None,
            "evidence_span_ids": [str(value) for value in part.evidence_span_ids],
            "source_refs": [ref.model_dump(mode="json") for ref in part.source_refs],
            "metadata": part.metadata,
        },
        ensure_ascii=True,
        sort_keys=True,
    )


def _artifact_html(artifact: MessageArtifactOut) -> str:
    title = artifact.title or artifact.artifact_kind.replace("_", " ").title()
    lines = [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        f"<title>{html.escape(title)}</title>",
        "</head>",
        "<body>",
        f"<h1>{html.escape(title)}</h1>",
    ]
    for part in artifact.parts:
        if part.part_type:
            lines.append(f"<h2>{html.escape(part.part_type.replace('_', ' ').title())}</h2>")
        if part.text:
            label = f"artifact-part-{part.ordinal + 1}"
            lines.append(
                f"<p>{html.escape(part.text)} "
                f'<a href="#{label}" aria-label="Citation {label}">[{label}]</a></p>'
            )
    if artifact.preview_text and not artifact.parts:
        lines.append(f"<p>{html.escape(artifact.preview_text)}</p>")
    if artifact.parts:
        lines.extend(["<h2>Citation Manifest</h2>", "<ol>"])
        for part in artifact.parts:
            label = f"artifact-part-{part.ordinal + 1}"
            lines.append(
                f'<li id="{label}"><pre>'
                f"{html.escape(_artifact_manifest_entry_json(part))}</pre></li>"
            )
        lines.append("</ol>")
    lines.extend(["</body>", "</html>"])
    return "\n".join(lines) + "\n"


def _artifact_csv(artifact: MessageArtifactOut) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "ordinal",
            "part_key",
            "part_type",
            "source_version",
            "locator",
            "text",
            "evidence_span_ids",
            "source_refs",
            "source_ref",
            "context_ref",
            "result_ref",
            "citation_manifest_artifact_id",
            "citation_manifest_message_id",
            "citation_manifest_conversation_id",
        ]
    )
    for part in artifact.parts:
        writer.writerow(
            [
                part.ordinal,
                part.part_key or "",
                part.part_type or "",
                part.source_version,
                json.dumps(part.locator.model_dump(mode="json"), ensure_ascii=True),
                part.text or "",
                json.dumps([str(value) for value in part.evidence_span_ids], ensure_ascii=True),
                json.dumps([ref.model_dump(mode="json") for ref in part.source_refs]),
                json.dumps(part.source_ref.model_dump(mode="json")) if part.source_ref else "",
                json.dumps(part.context_ref.model_dump(mode="json")) if part.context_ref else "",
                json.dumps(part.result_ref.model_dump(mode="json")) if part.result_ref else "",
                str(artifact.id),
                str(artifact.message_id),
                str(artifact.conversation_id),
            ]
        )
    return output.getvalue()


def _artifact_pdf(artifact: MessageArtifactOut) -> str:
    title = artifact.title or artifact.artifact_kind.replace("_", " ").title()
    lines = [title, ""]
    for part in artifact.parts:
        if part.part_type:
            lines.append(part.part_type.replace("_", " ").title())
        if part.text:
            lines.append(f"{part.text} [artifact-part-{part.ordinal + 1}]")
            lines.append("")
    if artifact.preview_text and not artifact.parts:
        lines.append(artifact.preview_text)
    if artifact.parts:
        lines.extend(["Citation Manifest", ""])
        for part in artifact.parts:
            lines.append(f"artifact-part-{part.ordinal + 1}: {_artifact_manifest_entry_json(part)}")

    wrapped_lines: list[str] = []
    for line in lines:
        if not line:
            wrapped_lines.append("")
            continue
        wrapped_lines.extend(
            textwrap.wrap(
                line,
                width=96,
                break_long_words=True,
                break_on_hyphens=False,
            )
            or [""]
        )
    pages = [
        wrapped_lines[index : index + 52] for index in range(0, max(1, len(wrapped_lines)), 52)
    ]
    page_object_numbers = [4 + index * 2 for index in range(len(pages))]
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (
            f"<< /Type /Pages /Kids [{' '.join(f'{number} 0 R' for number in page_object_numbers)}] "
            f"/Count {len(pages)} >>"
        ).encode("ascii"),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, page_lines in enumerate(pages):
        page_object_number = 4 + index * 2
        content_object_number = page_object_number + 1
        commands = ["BT", "/F1 10 Tf", "50 780 Td", "12 TL"]
        for line in page_lines:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            commands.append(f"({escaped}) Tj")
            commands.append("T*")
        commands.append("ET")
        stream = "\n".join(commands).encode("latin-1", "replace")
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_object_number} 0 R >>"
            ).encode("ascii")
        )
        objects.append(
            b"<< /Length "
            + str(len(stream)).encode("ascii")
            + b" >>\nstream\n"
            + stream
            + b"\nendstream"
        )
    body = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(body))
        body.extend(f"{index} 0 obj\n".encode("ascii"))
        body.extend(obj)
        body.extend(b"\nendobj\n")
    xref_offset = len(body)
    body.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    body.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        body.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    body.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return body.decode("latin-1")


def _artifact_provenance(artifact: MessageArtifactOut) -> MessageArtifactPartProvenance:
    return MessageArtifactPartProvenance(
        type="artifact",
        artifact_id=artifact.id,
        artifact_kind=artifact.artifact_kind,
        message_id=artifact.message_id,
        conversation_id=artifact.conversation_id,
        artifact_key=artifact.artifact_key,
        artifact_version=artifact.artifact_version,
        artifact_title=artifact.title,
    )


def _get_message_for_visible_read_or_404(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
) -> Message:
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    try:
        get_conversation_for_visible_read_or_404(db, viewer_id, message.conversation_id)
    except NotFoundError:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found") from None
    return message


def list_message_verifier_runs(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
) -> list[AssistantVerifierRunOut]:
    _get_message_for_visible_read_or_404(
        db,
        viewer_id=viewer_id,
        message_id=message_id,
    )
    rows = db.scalars(
        select(AssistantMessageVerifierRun)
        .where(AssistantMessageVerifierRun.message_id == message_id)
        .order_by(
            AssistantMessageVerifierRun.created_at.asc(),
            AssistantMessageVerifierRun.id.asc(),
        )
    ).all()
    return [
        AssistantVerifierRunOut(
            id=row.id,
            message_id=row.message_id,
            chat_run_id=row.chat_run_id,
            prompt_assembly_id=row.prompt_assembly_id,
            verifier_name=row.verifier_name,
            verifier_version=row.verifier_version,
            verifier_status=cast(Any, row.verifier_status),
            support_status=cast(Any, row.support_status),
            claim_count=row.claim_count,
            supported_claim_count=row.supported_claim_count,
            unsupported_claim_count=row.unsupported_claim_count,
            not_enough_evidence_count=row.not_enough_evidence_count,
            metadata=row.metadata_,
            created_at=row.created_at,
        )
        for row in rows
    ]


def list_message_retrieval_candidate_ledgers(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
    tool_call_id: UUID | None = None,
) -> list[MessageRetrievalCandidateLedgerOut]:
    _get_message_for_visible_read_or_404(
        db,
        viewer_id=viewer_id,
        message_id=message_id,
    )
    stmt = (
        select(
            MessageRetrievalCandidateLedger,
            MessageRetrieval.included_in_prompt,
        )
        .join(
            MessageToolCall,
            MessageToolCall.id == MessageRetrievalCandidateLedger.tool_call_id,
        )
        .outerjoin(
            MessageRetrieval,
            MessageRetrieval.id == MessageRetrievalCandidateLedger.retrieval_id,
        )
        .where(MessageToolCall.assistant_message_id == message_id)
        .order_by(
            MessageToolCall.tool_call_index.asc(),
            MessageRetrievalCandidateLedger.ordinal.asc(),
            MessageRetrievalCandidateLedger.id.asc(),
        )
    )
    if tool_call_id is not None:
        stmt = stmt.where(MessageRetrievalCandidateLedger.tool_call_id == tool_call_id)

    rows = db.execute(stmt).all()
    return [
        _retrieval_candidate_ledger_to_out(row, linked_retrieval_included_in_prompt)
        for row, linked_retrieval_included_in_prompt in rows
    ]


def _retrieval_candidate_ledger_to_out(
    row: MessageRetrievalCandidateLedger,
    linked_retrieval_included_in_prompt: bool | None,
) -> MessageRetrievalCandidateLedgerOut:
    if linked_retrieval_included_in_prompt is None:
        included_in_prompt = row.included_in_prompt
        included_in_prompt_source = "candidate_ledger"
        included_in_prompt_reconciled = True
    else:
        included_in_prompt = linked_retrieval_included_in_prompt
        included_in_prompt_source = "linked_retrieval"
        included_in_prompt_reconciled = (
            row.included_in_prompt == linked_retrieval_included_in_prompt
        )

    return MessageRetrievalCandidateLedgerOut(
        id=row.id,
        tool_call_id=row.tool_call_id,
        retrieval_id=row.retrieval_id,
        ordinal=row.ordinal,
        result_type=cast(Any, row.result_type),
        source_id=row.source_id,
        score=row.score,
        selected=row.selected,
        included_in_prompt=included_in_prompt,
        ledger_included_in_prompt=row.included_in_prompt,
        linked_retrieval_included_in_prompt=linked_retrieval_included_in_prompt,
        included_in_prompt_source=cast(Any, included_in_prompt_source),
        included_in_prompt_reconciled=included_in_prompt_reconciled,
        selection_status=row.selection_status,
        selection_reason=row.selection_reason,
        result_ref=cast(Any, row.result_ref),
        locator=cast(Any, row.locator),
        source_version=row.source_version,
        created_at=row.created_at,
    )


def list_message_rerank_ledgers(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
    tool_call_id: UUID | None = None,
) -> list[MessageRerankLedgerOut]:
    _get_message_for_visible_read_or_404(
        db,
        viewer_id=viewer_id,
        message_id=message_id,
    )
    stmt = (
        select(MessageRerankLedger)
        .join(MessageToolCall, MessageToolCall.id == MessageRerankLedger.tool_call_id)
        .where(MessageToolCall.assistant_message_id == message_id)
        .order_by(
            MessageToolCall.tool_call_index.asc(),
            MessageRerankLedger.created_at.asc(),
            MessageRerankLedger.id.asc(),
        )
    )
    if tool_call_id is not None:
        stmt = stmt.where(MessageRerankLedger.tool_call_id == tool_call_id)

    rows = db.scalars(stmt).all()
    return [
        MessageRerankLedgerOut(
            id=row.id,
            tool_call_id=row.tool_call_id,
            strategy=row.strategy,
            input_count=row.input_count,
            selected_count=row.selected_count,
            budget_chars=row.budget_chars,
            selected_chars=row.selected_chars,
            status=row.status,
            metadata=row.metadata_,
            created_at=row.created_at,
        )
        for row in rows
    ]


def _selected_path_message_rows(db: Session, viewer_id: UUID, conversation_id: UUID) -> list:
    active_leaf_id = db.scalar(
        text(
            """
            SELECT cap.active_leaf_message_id
            FROM conversation_active_paths cap
            JOIN messages active_message ON active_message.id = cap.active_leaf_message_id
            WHERE cap.conversation_id = :conversation_id
              AND cap.viewer_user_id = :viewer_id
              AND active_message.conversation_id = :conversation_id
            """
        ),
        {"conversation_id": conversation_id, "viewer_id": viewer_id},
    )
    if active_leaf_id is None:
        active_leaf_id = db.scalar(
            select(Message.id)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.seq.desc(), Message.id.desc())
            .limit(1)
        )
    if active_leaf_id is None:
        return []

    return list(
        db.execute(
            text(
                """
                WITH RECURSIVE path AS (
                    SELECT id, parent_message_id
                    FROM messages
                    WHERE conversation_id = :conversation_id
                      AND id = :active_leaf_id
                    UNION ALL
                    SELECT parent.id, parent.parent_message_id
                    FROM messages parent
                    JOIN path child ON child.parent_message_id = parent.id
                    WHERE parent.conversation_id = :conversation_id
                )
                SELECT m.id, m.seq, m.role, m.content, m.status, m.error_code,
                       m.created_at, m.updated_at, m.parent_message_id,
                       m.branch_root_message_id, m.branch_anchor_kind, m.branch_anchor,
                       m.message_document
                FROM messages m
                JOIN path ON path.id = m.id
                ORDER BY m.seq ASC, m.id ASC
                """
            ),
            {"conversation_id": conversation_id, "active_leaf_id": active_leaf_id},
        ).fetchall()
    )


def delete_message(db: Session, viewer_id: UUID, message_id: UUID) -> None:
    """Delete a single message.

    If this is the last message in the conversation, deletes the conversation too.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        message_id: The ID of the message to delete.

    Raises:
        NotFoundError(E_MESSAGE_NOT_FOUND): If message doesn't exist
            or viewer is not the conversation owner.
    """
    # Load message with conversation
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    # Verify viewer owns the conversation (masked as message not found)
    conversation = message.conversation
    if conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    conversation_id = conversation.id

    message_ids = _message_subtree_ids(db, conversation_id, message_id)
    delete_message_rows_without_commit(db, message_ids)
    db.flush()

    # Check remaining message count in same transaction
    remaining = db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation_id)
    )

    # If no messages remain, delete conversation
    if remaining == 0:
        delete_conversation_rows_without_commit(db, conversation_id)
        db.flush()

    db.commit()


def delete_conversation_rows_without_commit(db: Session, conversation_id: UUID) -> None:
    message_ids = _message_ids_for_conversation(db, conversation_id)
    delete_message_rows_without_commit(db, message_ids)

    db.execute(
        text("""
            DELETE FROM object_links
            WHERE (a_type = 'conversation' AND a_id = :conversation_id)
               OR (b_type = 'conversation' AND b_id = :conversation_id)
        """),
        {"conversation_id": conversation_id},
    )

    memory_item_ids = _conversation_memory_item_ids(db, conversation_id)
    if memory_item_ids:
        db.execute(
            text("""
                DELETE FROM conversation_memory_item_sources
                WHERE memory_item_id = ANY(:memory_item_ids)
            """),
            {"memory_item_ids": memory_item_ids},
        )
    db.execute(
        text("DELETE FROM conversation_memory_items WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_state_snapshots WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_active_paths WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_branches WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_media WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_shares WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(delete(Conversation).where(Conversation.id == conversation_id))
    db.flush()


def delete_message_rows_without_commit(db: Session, message_ids: Sequence[UUID]) -> None:
    if not message_ids:
        return

    db.execute(
        text("""
            DELETE FROM conversation_active_paths
            WHERE active_leaf_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            DELETE FROM conversation_branches
            WHERE branch_user_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )

    chat_run_ids = _chat_run_ids_for_messages(db, message_ids)
    if chat_run_ids:
        db.execute(
            text("DELETE FROM source_manifests WHERE chat_run_id = ANY(:chat_run_ids)"),
            {"chat_run_ids": chat_run_ids},
        )
        db.execute(
            text("DELETE FROM chat_run_events WHERE run_id = ANY(:chat_run_ids)"),
            {"chat_run_ids": chat_run_ids},
        )

    db.execute(
        text("""
            DELETE FROM message_artifact_exports
            WHERE message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    artifact_ids = _message_artifact_ids_for_messages(db, message_ids)
    if artifact_ids:
        db.execute(
            text("DELETE FROM message_artifact_parts WHERE artifact_id = ANY(:artifact_ids)"),
            {"artifact_ids": artifact_ids},
        )
        db.execute(
            text("DELETE FROM message_artifacts WHERE id = ANY(:artifact_ids)"),
            {"artifact_ids": artifact_ids},
        )

    db.execute(
        text("""
            DELETE FROM assistant_message_citation_audits
            WHERE message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    claim_ids = _assistant_claim_ids_for_messages(db, message_ids)
    if claim_ids:
        db.execute(
            text("""
                DELETE FROM assistant_message_claim_evidence
                WHERE claim_id = ANY(:claim_ids)
            """),
            {"claim_ids": claim_ids},
        )
    db.execute(
        text("""
            DELETE FROM assistant_message_claims
            WHERE message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            DELETE FROM assistant_message_evidence_summaries
            WHERE message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            DELETE FROM assistant_message_verifier_runs
            WHERE message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            DELETE FROM chat_prompt_assemblies
            WHERE assistant_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )

    tool_call_ids = _message_tool_call_ids_for_messages(db, message_ids)
    if tool_call_ids:
        db.execute(
            text("""
                DELETE FROM message_retrieval_candidate_ledgers
                WHERE tool_call_id = ANY(:tool_call_ids)
            """),
            {"tool_call_ids": tool_call_ids},
        )
        db.execute(
            text("""
                DELETE FROM message_rerank_ledgers
                WHERE tool_call_id = ANY(:tool_call_ids)
            """),
            {"tool_call_ids": tool_call_ids},
        )
        db.execute(
            text("DELETE FROM message_retrievals WHERE tool_call_id = ANY(:tool_call_ids)"),
            {"tool_call_ids": tool_call_ids},
        )
        db.execute(
            text("DELETE FROM message_tool_calls WHERE id = ANY(:tool_call_ids)"),
            {"tool_call_ids": tool_call_ids},
        )

    if chat_run_ids:
        db.execute(
            text("DELETE FROM chat_runs WHERE id = ANY(:chat_run_ids)"),
            {"chat_run_ids": chat_run_ids},
        )

    db.execute(
        text("DELETE FROM message_context_items WHERE message_id = ANY(:message_ids)"),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            DELETE FROM object_links
            WHERE (a_type = 'message' AND a_id = ANY(:message_ids))
               OR (b_type = 'message' AND b_id = ANY(:message_ids))
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("DELETE FROM message_llm WHERE message_id = ANY(:message_ids)"),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            UPDATE conversation_memory_items
            SET created_by_message_id = NULL
            WHERE created_by_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(delete(Message).where(Message.id.in_(message_ids)))
    db.flush()


def _message_ids_for_conversation(db: Session, conversation_id: UUID) -> list[UUID]:
    return list(
        db.scalars(
            select(Message.id)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.seq.asc(), Message.id.asc())
        )
    )


def _message_subtree_ids(db: Session, conversation_id: UUID, message_id: UUID) -> list[UUID]:
    rows = db.execute(
        text(
            """
            WITH RECURSIVE subtree AS (
                SELECT id
                FROM messages
                WHERE conversation_id = :conversation_id
                  AND id = :message_id
                UNION ALL
                SELECT child.id
                FROM messages child
                JOIN subtree parent ON parent.id = child.parent_message_id
                WHERE child.conversation_id = :conversation_id
            )
            SELECT id FROM subtree
            """
        ),
        {"conversation_id": conversation_id, "message_id": message_id},
    )
    return [row[0] for row in rows]


def _conversation_memory_item_ids(db: Session, conversation_id: UUID) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM conversation_memory_items
            WHERE conversation_id = :conversation_id
            ORDER BY created_at ASC, id ASC
        """),
        {"conversation_id": conversation_id},
    )
    return [row[0] for row in rows]


def _chat_run_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM chat_runs
            WHERE user_message_id = ANY(:message_ids)
               OR assistant_message_id = ANY(:message_ids)
            ORDER BY created_at ASC, id ASC
        """),
        {"message_ids": list(message_ids)},
    )
    return [row[0] for row in rows]


def _assistant_claim_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM assistant_message_claims
            WHERE message_id = ANY(:message_ids)
            ORDER BY ordinal ASC, id ASC
        """),
        {"message_ids": list(message_ids)},
    )
    return [row[0] for row in rows]


def _message_tool_call_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM message_tool_calls
            WHERE user_message_id = ANY(:message_ids)
               OR assistant_message_id = ANY(:message_ids)
            ORDER BY tool_call_index ASC, id ASC
        """),
        {"message_ids": list(message_ids)},
    )
    return [row[0] for row in rows]


def _message_artifact_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM message_artifacts
            WHERE message_id = ANY(:message_ids)
            ORDER BY created_at ASC, id ASC
        """),
        {"message_ids": list(message_ids)},
    )
    return [row[0] for row in rows]
