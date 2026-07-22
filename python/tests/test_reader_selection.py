"""Tests for the reader-highlight quote snapshot contract.

The reader quote is captured once, at send, from the locked Highlight into an
immutable ``ReaderSelectionSnapshot`` on the user message; every later read and
every prompt turn derives from that snapshot, never the live Highlight. These
tests cover the snapshot owner (``nexus.services.chat_reader_selection``): build,
revision, encode/decode, wire projection, the idempotency-hash identity, and the
``<reader_selection>`` / ``<subject>`` / ``<historical_reader_selection>`` prompt
blocks. The pre-cutover ``ReaderSelectionRequest(exact=...)``,
``turn_context.reader_selection_*`` columns, ``_build_reader_selection_block``,
and ``chat_subject`` hashing are all gone.
"""

from __future__ import annotations

import inspect
from uuid import UUID, uuid4

import pytest
from provider_runtime import CATALOG
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.chat_reader_selection import ReaderSelectionKey, ReaderSelectionSnapshot
from nexus.schemas.conversation import ExistingChatDestination, NewChatDestination
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_reader_selection import (
    build_reader_selection_snapshot,
    compute_reader_selection_revision,
    decode_reader_selection_snapshot,
    encode_reader_selection_snapshot,
    reader_selection_out,
    reader_selection_preview,
)
from nexus.services.chat_run_idempotency import compute_payload_hash
from nexus.services.chat_run_message_blocks import message_document
from nexus.services.context_assembler import (
    assemble_chat_context,
    load_recent_history_units,
)
from nexus.services.llm_profiles import profile as lookup_profile
from nexus.services.llm_profiles import reasoning_level as lookup_reasoning_level
from tests.factories import (
    create_test_conversation,
    create_test_fragment,
    create_test_highlight,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


# =============================================================================
# Seeding
# =============================================================================


def _seed_quotable_highlight(
    db: Session,
    user_id: UUID,
    *,
    exact: str = "poolpah",
    title: str = "Skinwalkers",
    content: str | None = None,
) -> tuple[UUID, UUID]:
    """A readable fragment Highlight whose media lives in the viewer's library.

    ``build_reader_selection_snapshot`` resolves through the highlight anchor →
    fragment.media_id → Media, and ``can_read_highlight`` needs a library the
    viewer and author both belong to (the default library here). Returns
    ``(media_id, highlight_id)``.
    """
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    media_id = create_test_media_in_library(db, user_id, library_id, title=title)
    fragment_id = create_test_fragment(db, media_id, content=content or f"{exact} hit the fan")
    highlight_id = create_test_highlight(db, user_id, fragment_id, exact=exact)
    return media_id, highlight_id


def _key(media_id: UUID, highlight_id: UUID) -> ReaderSelectionKey:
    return ReaderSelectionKey(media_id=media_id, highlight_id=highlight_id)


# =============================================================================
# Snapshot owner: build_reader_selection_snapshot
# =============================================================================


def test_build_snapshot_happy_path(db_session: Session, bootstrapped_user: UUID):
    media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)

    snapshot = build_reader_selection_snapshot(
        db_session, viewer_id=bootstrapped_user, key=_key(media_id, highlight_id)
    )

    assert snapshot.key == _key(media_id, highlight_id)
    # source_label falls back to the media title (no contributor rows seeded).
    assert snapshot.source_label == "“Skinwalkers”"
    assert snapshot.exact == "poolpah"
    assert snapshot.prefix == ""
    assert snapshot.suffix == ""
    # The locator is the immutable in-reader destination; its media agrees with
    # the key (§Persistence application invariant).
    assert snapshot.locator.model_dump(mode="json")["media_id"] == str(media_id)


def test_build_snapshot_geometry_only_is_rejected(db_session: Session, bootstrapped_user: UUID):
    # A geometry-only highlight has valid offsets but a blank resolved quote; it
    # cannot be launched or sent (Domain Rule 9).
    media_id, highlight_id = _seed_quotable_highlight(
        db_session, bootstrapped_user, exact="   ", content="    tail"
    )

    with pytest.raises(ApiError) as exc:
        build_reader_selection_snapshot(
            db_session, viewer_id=bootstrapped_user, key=_key(media_id, highlight_id)
        )

    assert exc.value.code == ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY


def test_build_snapshot_media_highlight_mismatch_is_not_found(
    db_session: Session, bootstrapped_user: UUID
):
    # The key media_id must equal the highlight anchor media; a mismatch is
    # NOT_FOUND (no existence leak), never a silent re-target.
    _media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)

    with pytest.raises(ApiError) as exc:
        build_reader_selection_snapshot(
            db_session, viewer_id=bootstrapped_user, key=_key(uuid4(), highlight_id)
        )

    assert exc.value.code == ApiErrorCode.E_READER_SELECTION_NOT_FOUND


def test_build_snapshot_over_limit_is_too_large(db_session: Session, bootstrapped_user: UUID):
    # Exact bound is 1..20,000; preview/send reject excess rather than truncate.
    oversized = "A" * 20_001
    media_id, highlight_id = _seed_quotable_highlight(
        db_session, bootstrapped_user, exact=oversized, content=oversized
    )

    with pytest.raises(ApiError) as exc:
        build_reader_selection_snapshot(
            db_session, viewer_id=bootstrapped_user, key=_key(media_id, highlight_id)
        )

    assert exc.value.code == ApiErrorCode.E_READER_SELECTION_TOO_LARGE


def test_build_snapshot_forbidden_for_unreadable_viewer(
    db_session: Session, bootstrapped_user: UUID
):
    # A viewer with no library intersection cannot read the highlight → FORBIDDEN
    # (distinct from NOT_FOUND, which this internal path reports as a defect).
    media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)
    stranger = uuid4()
    ensure_user_and_default_library(db_session, stranger)

    with pytest.raises(ApiError) as exc:
        build_reader_selection_snapshot(
            db_session, viewer_id=stranger, key=_key(media_id, highlight_id)
        )

    assert exc.value.code == ApiErrorCode.E_READER_SELECTION_FORBIDDEN


# =============================================================================
# Revision + encode/decode
# =============================================================================


def test_revision_is_stable_and_encode_decode_round_trips(
    db_session: Session, bootstrapped_user: UUID
):
    media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)
    snapshot = build_reader_selection_snapshot(
        db_session, viewer_id=bootstrapped_user, key=_key(media_id, highlight_id)
    )

    # A revision digests the canonical answer/display fields deterministically.
    revision = compute_reader_selection_revision(snapshot)
    assert revision == compute_reader_selection_revision(snapshot)
    assert len(revision) == 64 and revision == revision.lower()

    # encode → decode is value-equal (no fallback, no metadata) and digests equal.
    encoded = encode_reader_selection_snapshot(snapshot)
    decoded = decode_reader_selection_snapshot(encoded)
    assert decoded == snapshot
    assert compute_reader_selection_revision(decoded) == revision


def test_decode_rejects_non_object_trusted_state():
    # JSON null / non-object stored state is a trusted-state defect, never Absent.
    with pytest.raises(AssertionError):
        decode_reader_selection_snapshot(None)
    with pytest.raises(AssertionError):
        decode_reader_selection_snapshot("not-an-object")


def test_reader_selection_out_activation_is_none_when_source_unreadable(
    db_session: Session, bootstrapped_user: UUID
):
    # The immutable snapshot always projects; only activation reflects current
    # visibility. An unreadable viewer gets kind="none" (no dead control), while
    # the quote fields stay intact.
    media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)
    snapshot = build_reader_selection_snapshot(
        db_session, viewer_id=bootstrapped_user, key=_key(media_id, highlight_id)
    )
    stranger = uuid4()
    ensure_user_and_default_library(db_session, stranger)

    owner_out = reader_selection_out(db_session, viewer_id=bootstrapped_user, snapshot=snapshot)
    stranger_out = reader_selection_out(db_session, viewer_id=stranger, snapshot=snapshot)

    assert owner_out.activation.kind == "route"
    assert stranger_out.activation.kind == "none"
    assert stranger_out.exact == snapshot.exact
    assert stranger_out.source_label == snapshot.source_label


def test_reader_selection_preview_carries_revision(db_session: Session, bootstrapped_user: UUID):
    media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)
    key = _key(media_id, highlight_id)

    preview = reader_selection_preview(db_session, viewer_id=bootstrapped_user, key=key)
    snapshot = build_reader_selection_snapshot(db_session, viewer_id=bootstrapped_user, key=key)

    assert preview.key == key
    assert preview.exact == snapshot.exact
    assert preview.revision == compute_reader_selection_revision(snapshot)
    assert preview.activation.kind == "route"


# =============================================================================
# Idempotency-hash identity: key is answer-determining; revision is not.
# =============================================================================


def test_idempotency_hash_uses_selection_key_but_never_revision():
    common = {
        "destination": NewChatDestination(),
        "content": "where does this word come from?",
        "profile_id": "balanced",
        "reasoning_option_id": "medium",
    }
    media_id = uuid4()
    highlight_id = uuid4()
    key = _key(media_id, highlight_id)

    none_hash = compute_payload_hash(**common, reader_selection_key=None)
    key_hash = compute_payload_hash(**common, reader_selection_key=key)
    same_key_hash = compute_payload_hash(**common, reader_selection_key=_key(media_id, highlight_id))
    other_key_hash = compute_payload_hash(
        **common, reader_selection_key=_key(media_id, uuid4())
    )

    assert none_hash != key_hash, "A selection must change the idempotency identity"
    assert key_hash == same_key_hash, "An equal ReaderSelectionKey must replay, not conflict"
    assert key_hash != other_key_hash, "A different highlight must conflict, not replay"

    # The revision is a live compare-on-send precondition, explicitly excluded
    # from the hash — the signature does not even accept it.
    assert "revision" not in inspect.signature(compute_payload_hash).parameters


def test_idempotency_hash_distinguishes_destination():
    common = {
        "content": "summarize this",
        "profile_id": "balanced",
        "reasoning_option_id": "medium",
        "reader_selection_key": None,
    }
    conversation_id = uuid4()
    new_hash = compute_payload_hash(destination=NewChatDestination(), **common)
    existing_hash = compute_payload_hash(
        destination=ExistingChatDestination(
            kind="Existing",
            conversation_id=conversation_id,
            insertion={"kind": "Empty"},
        ),
        **common,
    )

    assert new_hash != existing_hash


# =============================================================================
# Prompt assembly: <reader_selection> + <subject>, and history pairing.
# =============================================================================


def _profile_and_reasoning():
    profile = lookup_profile("balanced")
    assert profile is not None
    reasoning = lookup_reasoning_level(profile, "medium")
    assert reasoning is not None
    return profile, reasoning


def _add_message(
    db: Session,
    conversation_id: UUID,
    *,
    seq: int,
    role: str,
    content: str,
    status: str = "complete",
    parent_message_id: UUID | None = None,
    snapshot: ReaderSelectionSnapshot | None = None,
) -> UUID:
    message = Message(
        id=uuid4(),
        conversation_id=conversation_id,
        seq=seq,
        role=role,
        content=content,
        message_document=message_document(role, content),
        status=status,
        parent_message_id=parent_message_id,
        reader_selection_snapshot=(
            encode_reader_selection_snapshot(snapshot) if snapshot is not None else None
        ),
    )
    db.add(message)
    db.flush()
    return message.id


def _run_for_leaf(
    db: Session, user_id: UUID, conversation_id: UUID, user_message_id: UUID, *, seq: int
) -> ChatRun:
    assistant_id = _add_message(
        db,
        conversation_id,
        seq=seq,
        role="assistant",
        content="",
        status="pending",
        parent_message_id=user_message_id,
    )
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_id,
        idempotency_key=f"reader-selection-{uuid4()}",
        payload_hash="hash",
        status="queued",
        profile_id="balanced",
        reasoning_option_id="medium",
    )
    db.add(run)
    db.flush()
    return run


def test_current_turn_snapshot_emits_reader_selection_and_subject_once(
    db_session: Session, bootstrapped_user: UUID
):
    media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)
    snapshot = build_reader_selection_snapshot(
        db_session, viewer_id=bootstrapped_user, key=_key(media_id, highlight_id)
    )
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = _add_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="What does this word mean?",
        snapshot=snapshot,
    )
    run = _run_for_leaf(db_session, bootstrapped_user, conversation_id, user_message_id, seq=2)
    profile, reasoning = _profile_and_reasoning()

    assembly = assemble_chat_context(
        db_session,
        run=run,
        profile=profile,
        reasoning=reasoning,
        contract=CATALOG.chat_contract(profile.target),
        max_output_tokens=1024,
        tools=(),
    )

    blocks = assembly.context_blocks
    reader_selection_blocks = [b for b in blocks if b.startswith("<reader_selection")]
    subject_blocks = [b for b in blocks if b.startswith("<subject")]
    assert len(reader_selection_blocks) == 1
    assert "<exact>poolpah</exact>" in reader_selection_blocks[0]
    # <subject> is identity/source metadata only; the quote text lives solely in
    # <reader_selection>, so canonical quote text appears exactly once.
    assert len(subject_blocks) == 1
    assert 'kind="reader_highlight"' in subject_blocks[0]
    assert "poolpah" not in subject_blocks[0]
    assert sum(block.count("<exact>poolpah</exact>") for block in blocks) == 1


def test_turn_without_snapshot_emits_no_reader_selection_or_subject(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = _add_message(
        db_session, conversation_id, seq=1, role="user", content="Plain question, no quote."
    )
    run = _run_for_leaf(db_session, bootstrapped_user, conversation_id, user_message_id, seq=2)
    profile, reasoning = _profile_and_reasoning()

    assembly = assemble_chat_context(
        db_session,
        run=run,
        profile=profile,
        reasoning=reasoning,
        contract=CATALOG.chat_contract(profile.target),
        max_output_tokens=1024,
        tools=(),
    )

    assert not any(b.startswith("<reader_selection") for b in assembly.context_blocks)
    assert not any(b.startswith("<subject") for b in assembly.context_blocks)


def test_historical_quoted_turn_prefixes_historical_reader_selection(
    db_session: Session, bootstrapped_user: UUID
):
    media_id, highlight_id = _seed_quotable_highlight(db_session, bootstrapped_user)
    snapshot = build_reader_selection_snapshot(
        db_session, viewer_id=bootstrapped_user, key=_key(media_id, highlight_id)
    )
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    quoted_user_id = _add_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="Explain this passage.",
        snapshot=snapshot,
    )
    _add_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="It means fate.",
        parent_message_id=quoted_user_id,
    )

    units = load_recent_history_units(
        db_session, conversation_id=conversation_id, before_seq=99
    )

    assert len(units) == 1
    user_turn = units[0].turns[0]
    assert user_turn.role == "user"
    # A bounded <historical_reader_selection> block precedes the historical user
    # text; the quote-to-user-turn binding is preserved from the snapshot.
    assert user_turn.content.startswith("<historical_reader_selection")
    assert "<exact>poolpah</exact>" in user_turn.content
    assert user_turn.content.rstrip().endswith("Explain this passage.")
    assert units[0].turns[1].content == "It means fate."
