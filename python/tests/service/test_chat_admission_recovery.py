"""Real-Postgres admission proof for immutable decisions and no duplicate work.

The cutover's operation-identity contract is the oracle. No worker or paid
provider runs here: persisted run/message/job identities establish admission.
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event
from time import monotonic
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation, ResourceMutation
from nexus.db.session import create_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.chat_reader_selection import ReaderSelectionInput, ReaderSelectionKey
from nexus.schemas.conversation import NewChatDestination
from nexus.schemas.llm import Ready, TemporarilyUnavailable
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_run_candidates import regenerate_assistant_response
from nexus.services.chat_run_event_store import mark_running
from nexus.services.chat_run_finalize import finalize_run
from nexus.services.chat_run_idempotency import lock_idempotency_key
from nexus.services.chat_runs import create_chat_run
from nexus.services.conversations import delete_conversation_rows_without_commit, delete_message
from nexus.services.generation_catalog import readiness_snapshot
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.testkit.generation_catalog import (
    CHAT_CATALOG_NOW,
    CHAT_TEST_SELECTION,
    configured_chat_catalog_service,
)
from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


def _owner(engine: Engine) -> UUID:
    owner = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(db, owner, f"admission-{owner}@example.invalid")
        grant_entitlement_override(
            db,
            user_id=owner,
            plan_tier="ai_pro",
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="admission proof",
            actor_label="nexus-test",
        )
        db.commit()
    return owner


@contextmanager
def _limiter(engine: Engine, *, rpm_limit: int = 20):
    previous = get_rate_limiter()
    set_rate_limiter(
        RateLimiter(session_factory=create_session_factory(engine), rpm_limit=rpm_limit)
    )
    try:
        yield
    finally:
        set_rate_limiter(previous)


def _send(
    db: Session, owner: UUID, key: str, *, definition_revision=None, selection=None, catalog=None
):
    async def send():
        selection_catalog = catalog or configured_chat_catalog_service()
        revision = definition_revision
        if revision is None:
            revision = (await selection_catalog.read_chat()).catalog.definition_revision
        return await create_chat_run(
            db,
            viewer_id=owner,
            destination=NewChatDestination(),
            reader_selection=selection,
            content="Preserve this question exactly once.",
            catalog_definition_revision=revision,
            selection=CHAT_TEST_SELECTION,
            tool_authority="ReadOnly",
            idempotency_key=key,
            catalog=selection_catalog,
            tool_runtime=compose_available_product_tool_runtime(),
        )

    receipt = asyncio.run(send()).model_dump(mode="json")
    assert set(receipt) == {"idempotency_key", "outcome"}, (
        "chat admission must return the exact immutable receipt envelope",
        receipt,
    )
    return receipt


def _regenerate(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str,
    definition_revision: str | None = None,
):
    async def regenerate():
        catalog = configured_chat_catalog_service()
        snapshot = await catalog.read_chat()
        return await regenerate_assistant_response(
            db,
            viewer_id=viewer_id,
            assistant_message_id=assistant_message_id,
            catalog_definition_revision=(
                definition_revision or snapshot.catalog.definition_revision
            ),
            selection=CHAT_TEST_SELECTION,
            tool_authority="ReadOnly",
            idempotency_key=idempotency_key,
            catalog=catalog,
            tool_runtime=compose_available_product_tool_runtime(),
        )

    return asyncio.run(regenerate())


def test_chat_admission_replays_one_immutable_decision_without_resurrecting_deleted_work(
    engine: Engine,
) -> None:
    owner, key = _owner(engine), "k" * 128
    with _limiter(engine), Session(engine) as db:
        accepted = _send(db, owner, key)
        assert accepted["idempotency_key"] == key
        assert accepted["outcome"]["kind"] == "Accepted", accepted
        run_id = UUID(accepted["outcome"]["run_id"])
        conversation_id = UUID(accepted["outcome"]["conversation_id"])
        assert (
            db.scalar(
                select(func.count()).select_from(ChatRun).where(ChatRun.owner_user_id == owner)
            )
            == 1
        )
        assert (
            db.scalar(
                text("SELECT count(*) FROM background_jobs WHERE dedupe_key=:k"),
                {"k": f"chat_run:{run_id}"},
            )
            == 1
        )

        # An accepted command must replay even when the quota now rejects new work.
        with _limiter(engine, rpm_limit=0):
            assert _send(db, owner, key) == accepted
        delete_conversation_rows_without_commit(db, conversation_id)
        db.commit()
        assert _send(db, owner, key) == accepted
        assert db.get(ChatRun, run_id) is None, "receipt replay resurrected a deleted run"
        assert db.get(Conversation, conversation_id) is None, "receipt replay resurrected its chat"
        assert (
            db.scalar(
                select(func.count())
                .select_from(ResourceMutation)
                .where(
                    ResourceMutation.user_id == owner,
                    ResourceMutation.mutation_scope == "chat:admission",
                )
            )
            == 1
        )


def test_chat_admission_serializes_duplicate_requests_before_quota_consumption(
    engine: Engine,
) -> None:
    owner, key = _owner(engine), str(uuid4())
    started = Event()
    pid: list[int] = []

    def send():
        with Session(engine) as db:
            pid.append(db.scalar(text("SELECT pg_backend_pid()")))
            started.set()
            return _send(db, owner, key)

    with _limiter(engine, rpm_limit=1), Session(engine) as original:
        # Hold the exact original operation lock before starting the duplicate.
        # PostgreSQL's lock wait establishes the schedule, not a timing guess.
        lock_idempotency_key(original, owner, key)
        with ThreadPoolExecutor(max_workers=1) as threads:
            duplicate = threads.submit(send)
            try:
                assert started.wait(timeout=5)
                deadline = monotonic() + 5
                waiting = False
                with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as observer:
                    # justify-polling: pg_stat_activity exposes the actual lock
                    # wait; bounded sampling ends as soon as the database proves it.
                    while monotonic() < deadline:
                        waiting = observer.scalar(
                            text(
                                "SELECT wait_event='advisory' FROM pg_stat_activity WHERE pid=:pid"
                            ),
                            {"pid": pid[0]},
                        )
                        if waiting:
                            break
                    assert waiting, "duplicate never waited on the admission operation lock"
                    assert (
                        observer.scalar(
                            text("SELECT count(*) FROM rate_limit_request_log WHERE user_id=:u"),
                            {"u": owner},
                        )
                        == 0
                    ), "duplicate consumed quota before observing the original decision"
                receipt = _send(original, owner, key)
                replay = duplicate.result(timeout=10)
            finally:
                # Release the controlled lock even when an oracle fails, so a
                # failing test cannot strand its worker thread.
                original.rollback()
    assert receipt == replay and receipt["outcome"]["kind"] == "Accepted", (receipt, replay)
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count()).select_from(ChatRun).where(ChatRun.owner_user_id == owner)
            )
            == 1
        )
        assert (
            db.scalar(
                text("SELECT count(*) FROM rate_limit_request_log WHERE user_id=:u"), {"u": owner}
            )
            == 1
        )


def test_chat_admission_rejection_remains_rejected_after_policy_change_and_rolls_back_setup(
    engine: Engine,
) -> None:
    owner, key = _owner(engine), str(uuid4())
    with _limiter(engine, rpm_limit=0), Session(engine) as db:
        rejected = _send(db, owner, key)
    assert rejected == {
        "idempotency_key": key,
        "outcome": {"kind": "Rejected", "reason": {"code": "E_RATE_LIMITED"}},
    }
    with _limiter(engine), Session(engine) as db:
        assert _send(db, owner, key) == rejected
        assert (
            db.scalar(
                select(func.count())
                .select_from(Conversation)
                .where(Conversation.owner_user_id == owner)
            )
            == 0
        )
        # New destinations are allocated before quote authorization. A failed
        # quote must roll that provisional conversation back before the receipt.
        selection = ReaderSelectionInput(
            key=ReaderSelectionKey(media_id=uuid4(), highlight_id=uuid4()), revision="0" * 64
        )
        quote_rejection = _send(db, owner, str(uuid4()), selection=selection)
        assert quote_rejection["outcome"] == {
            "kind": "Rejected",
            "reason": {"code": "E_READER_SELECTION_NOT_FOUND"},
        }
        assert (
            db.scalar(
                select(func.count())
                .select_from(Conversation)
                .where(Conversation.owner_user_id == owner)
            )
            == 0
        )
        assert _send(db, owner, str(uuid4()))["outcome"]["kind"] == "Accepted"


def test_chat_admission_keys_cannot_cross_send_and_regeneration_or_bypass_rejection(
    engine: Engine,
) -> None:
    owner = _owner(engine)
    with _limiter(engine), Session(engine) as db:
        source = _send(db, owner, str(uuid4()))["outcome"]
        run_id = UUID(source["run_id"])
        mark_running(db, run_id)
        finalize_run(
            db,
            run_id=run_id,
            assistant_content="Original answer",
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            commit=True,
        )
        candidate_key = str(uuid4())
        candidate = _regenerate(
            db,
            viewer_id=owner,
            assistant_message_id=UUID(source["assistant_message_id"]),
            idempotency_key=candidate_key,
        )
        with pytest.raises(ApiError) as mismatch:
            _send(db, owner, candidate_key)
        assert mismatch.value.code is ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH
        replay = _regenerate(
            db,
            viewer_id=owner,
            assistant_message_id=UUID(source["assistant_message_id"]),
            idempotency_key=candidate_key,
        )
        assert replay.run.id == candidate.run.id
        # A retained candidate receipt owns replay even after the source answer
        # is deleted. Incoming request mismatch still precedes source lookup.
        delete_message(db, owner, UUID(source["assistant_message_id"]))
        replay_after_source_delete = None
        replay_error = None
        try:
            replay_after_source_delete = _regenerate(
                db,
                viewer_id=owner,
                assistant_message_id=UUID(source["assistant_message_id"]),
                idempotency_key=candidate_key,
            )
        except ApiError as error:
            replay_error = error
        assert replay_error is None, "retained candidate replay consulted its deleted source"
        assert replay_after_source_delete is not None
        assert (
            replay_after_source_delete.run.id,
            replay_after_source_delete.conversation.id,
            replay_after_source_delete.assistant_message.id,
        ) == (candidate.run.id, candidate.conversation.id, candidate.assistant_message.id)
        with pytest.raises(ApiError) as changed_request:
            _regenerate(
                db,
                viewer_id=owner,
                assistant_message_id=UUID(source["assistant_message_id"]),
                idempotency_key=candidate_key,
                definition_revision="0" * 64,
            )
        assert changed_request.value.code is ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH
        rejected_key = str(uuid4())
        rejected = _send(db, owner, rejected_key, definition_revision="0" * 64)
        assert rejected["outcome"]["kind"] == "Rejected"
        with pytest.raises(ApiError) as rejected_mismatch:
            _regenerate(
                db,
                viewer_id=owner,
                assistant_message_id=UUID(source["assistant_message_id"]),
                idempotency_key=rejected_key,
            )
        assert rejected_mismatch.value.code is ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH
        assert (
            db.scalar(
                select(func.count()).select_from(ChatRun).where(ChatRun.owner_user_id == owner)
            )
            == 1
        )


@pytest.mark.parametrize("outage", ["temporarily_unavailable", "refresh_failure"])
def test_chat_admission_generation_outage_preserves_the_exact_unsettled_command(
    engine: Engine, outage: str
) -> None:
    owner, key = _owner(engine), str(uuid4())
    healthy_catalog = configured_chat_catalog_service()
    revision = asyncio.run(healthy_catalog.read_chat()).catalog.definition_revision

    async def unavailable_readiness():
        if outage == "refresh_failure":
            raise OSError("controlled external readiness source is unavailable")
        return readiness_snapshot(
            observed_at=CHAT_CATALOG_NOW,
            routes={
                "CodexPersonal": Ready(last_checked=CHAT_CATALOG_NOW),
                "ProviderApi:openai": TemporarilyUnavailable(
                    code="provider_unavailable",
                    explanation="The selected provider is temporarily unavailable.",
                    action="Retry the same command when availability returns.",
                    last_checked=CHAT_CATALOG_NOW,
                ),
            },
        )

    unavailable_catalog = configured_chat_catalog_service(readiness_loader=unavailable_readiness)
    with _limiter(engine), Session(engine) as db:
        with pytest.raises(ApiError) as unavailable:
            _send(
                db,
                owner,
                key,
                definition_revision=revision,
                catalog=unavailable_catalog,
            )
        assert unavailable.value.code is ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE
        assert (
            db.scalar(
                select(func.count())
                .select_from(ResourceMutation)
                .where(
                    ResourceMutation.user_id == owner,
                    ResourceMutation.mutation_scope == "chat:admission",
                )
            )
            == 0
        ), "generation outage was settled as an immutable admission decision"
        assert (
            db.scalar(
                select(func.count()).select_from(ChatRun).where(ChatRun.owner_user_id == owner)
            )
            == 0
        )
        accepted = _send(db, owner, key, definition_revision=revision, catalog=healthy_catalog)
        assert accepted["outcome"]["kind"] == "Accepted"


def test_chat_admission_dependency_failure_preserves_an_unsettled_key(engine: Engine) -> None:
    owner, key = _owner(engine), str(uuid4())
    previous = get_rate_limiter()
    try:
        set_rate_limiter(RateLimiter())
        with Session(engine) as db:
            with pytest.raises(ApiError) as unavailable:
                _send(db, owner, key)
            assert unavailable.value.code is ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ResourceMutation)
                    .where(
                        ResourceMutation.user_id == owner,
                        ResourceMutation.mutation_scope == "chat:admission",
                    )
                )
                == 0
            ), "dependency failure was incorrectly settled as an immutable rejection"
            assert (
                db.scalar(
                    select(func.count()).select_from(ChatRun).where(ChatRun.owner_user_id == owner)
                )
                == 0
            )
    finally:
        set_rate_limiter(previous)
    with _limiter(engine), Session(engine) as db:
        assert _send(db, owner, key)["outcome"]["kind"] == "Accepted"
