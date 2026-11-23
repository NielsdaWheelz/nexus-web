"""Frozen librarian exports: one local terminal commit, then acknowledged delivery."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Self
from uuid import UUID, uuid4

import httpx2
from pydantic import (
    AnyHttpUrl,
    BaseModel,
    Field,
    SecretStr,
    TypeAdapter,
    ValidationError,
    model_validator,
)
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from universal_memory import MemoryError
from universal_memory.nexus import (
    NEXUS_CONTRACT_REVISION,
    NexusActivate,
    NexusIngest,
    NexusReceipt,
    NexusRegistration,
    NexusState,
    NexusTurnExport,
    payload_digest,
)
from universal_memory.policy import BODY_BYTES, RESULT_BYTES, canonical_json
from universal_memory.tools import MemoryToolFailure
from universal_memory.types import Closed

from nexus.config import get_settings
from nexus.db.models import (
    ChatRun,
    LibrarianState,
    MemoryExport,
    Message,
    MessageRetrieval,
)
from nexus.db.retries import retry_read_committed
from nexus.db.session import get_session_factory
from nexus.jobs.queue import (
    JobExecutionContext,
    JobFailure,
    lock_running_job_claim,
    running_job_claim_is_current,
)
from nexus.schemas.live_reference import SavedReference, SavedRetrievalTarget
from nexus.services.chat.deletion import lock_revision
from nexus.services.tools.memory import (
    BEARER_PATTERN,
    HTTP_TIMEOUT,
    MemoryClientConfig,
    load_memory_client_config,
)

_EXPORTS_PER_RUN = 64
_PARK = frozenset({"invalid_input", "unsupported", "event_too_large", "source_conflict"})
_SAVED_TARGET = TypeAdapter(SavedRetrievalTarget)


class MemoryCaptureConfig(Closed):
    owner_user_id: UUID
    capture: bool
    admit: bool
    base_url: AnyHttpUrl
    bearer: SecretStr = Field(repr=False)

    @model_validator(mode="after")
    def valid_publisher(self) -> Self:
        url = self.base_url
        if (
            url.path not in (None, "", "/")
            or url.username is not None
            or url.password is not None
            or url.query is not None
            or url.fragment is not None
            or (url.scheme == "http" and url.host not in ("localhost", "127.0.0.1", "[::1]"))
            or len(str(url).encode()) > 4096
            or BEARER_PATTERN.fullmatch(self.bearer.get_secret_value()) is None
        ):
            raise ValueError("invalid private memory publisher declaration")
        return self


def load_memory_capture_config(path: Path | None) -> MemoryCaptureConfig | None:
    if path is None:
        return None
    try:
        return TypeAdapter(MemoryCaptureConfig | None).validate_json(path.read_bytes(), strict=True)
    except (OSError, ValueError):
        raise RuntimeError("invalid private memory publisher configuration") from None


def append_turn(db: Session, run: ChatRun) -> None:
    """Freeze fresh canonical rows under the terminal writer's account/run locks."""
    if run.memory_capture_id is None:
        return
    db.flush()
    terminal = db.execute(select(ChatRun.__table__).where(ChatRun.id == run.id)).mappings().one()
    messages = {
        row["id"]: row
        for row in db.execute(
            select(Message.__table__).where(
                Message.id.in_((run.user_message_id, run.assistant_message_id))
            )
        ).mappings()
    }
    question, answer = messages[run.user_message_id], messages[run.assistant_message_id]
    assert question["owner_user_id"] == answer["owner_user_id"] == run.owner_user_id
    assert question["role"] == "user" and answer["role"] == "assistant"
    sequence = db.execute(
        text(
            "UPDATE librarian_state SET memory_next_export_seq=memory_next_export_seq+1 "
            "WHERE user_id=:owner AND memory_capture_id=:capture "
            "RETURNING memory_next_export_seq-1"
        ),
        {"owner": run.owner_user_id, "capture": run.memory_capture_id},
    ).scalar_one()
    payload = NexusTurnExport.model_validate_json(
        canonical_json(
            {
                "contract_revision": NEXUS_CONTRACT_REVISION,
                "capture_id": str(run.memory_capture_id),
                "owner_user_id": str(run.owner_user_id),
                "run_id": str(run.id),
                "export_seq": str(sequence),
                "retry_of_run_id": str(run.retry_of_run_id)
                if run.retry_of_run_id is not None
                else None,
                "question": {
                    "message_id": str(question["id"]),
                    "message_seq": str(question["seq"]),
                    "created_at": question["created_at"].isoformat(),
                    "text": question["content"],
                },
                "answer": {
                    "message_id": str(answer["id"]),
                    "message_seq": str(answer["seq"]),
                    "created_at": answer["created_at"].isoformat(),
                    "text": answer["content"],
                },
                "settlement": {
                    "status": terminal["status"],
                    "completed_at": terminal["completed_at"].isoformat(),
                    "error_code": terminal["error_code"],
                    "publication_warning_code": terminal["publication_warning_code"],
                },
                "attachments": [
                    {
                        "ordinal": index + 1,
                        "snapshot_json": canonical_json(
                            SavedReference.model_validate(value).model_dump(mode="json")
                        ),
                    }
                    for index, value in enumerate(question["attachments"])
                ],
                "citations": [
                    {
                        "ordinal": row.citation_ordinal,
                        "snapshot_json": canonical_json(
                            _SAVED_TARGET.validate_python(row.target).model_dump(mode="json")
                        ),
                    }
                    for row in db.execute(
                        select(MessageRetrieval.citation_ordinal, MessageRetrieval.target)
                        .where(
                            MessageRetrieval.assistant_message_id == run.assistant_message_id,
                            MessageRetrieval.citation_ordinal.is_not(None),
                        )
                        .order_by(MessageRetrieval.citation_ordinal)
                    )
                ],
            }
        )
    )
    db.add(
        MemoryExport(
            owner_user_id=run.owner_user_id,
            capture_id=run.memory_capture_id,
            export_seq=sequence,
            run_id=run.id,
            payload=payload.model_dump(mode="json"),
            payload_sha256=payload_digest(payload),
            parked_code=None,
        )
    )
    db.flush()


class _Error(Closed):
    error: MemoryToolFailure


class _InvalidResponse(Exception):
    """No valid acknowledgement: preserve the pending payload for a later attempt."""


def _request[T: BaseModel](
    http: httpx2.Client, method: str, path: str, result: type[T], request: BaseModel | None = None
) -> T:
    body = None if request is None else canonical_json(request.model_dump(mode="json")).encode()
    if body is not None and len(body) > BODY_BYTES:
        raise MemoryError("event_too_large")
    try:
        with http.stream(method, path, content=body) as response:
            if response.status_code in (401, 403, 429) or response.status_code >= 500:
                raise MemoryError(
                    {401: "unauthorized", 403: "forbidden", 429: "rate_limited"}.get(
                        response.status_code, "unavailable"
                    )
                )
            received = bytearray()
            for chunk in response.iter_bytes():
                received.extend(chunk)
                if len(received) > RESULT_BYTES:
                    raise _InvalidResponse
            if response.status_code == 200:
                return result.model_validate_json(bytes(received))
            if response.status_code not in (409, 413, 422):
                raise _InvalidResponse
            raise MemoryError(_Error.model_validate_json(bytes(received)).error.code)
    except ValidationError:
        raise _InvalidResponse from None
    except (httpx2.NetworkError, httpx2.TimeoutException, httpx2.RemoteProtocolError):
        raise MemoryError("unavailable") from None


def _current(db: Session, context: JobExecutionContext) -> None:
    if lock_running_job_claim(db, context=context) is None:
        raise JobFailure(
            "E_WORKER_INTERRUPTED", "The memory publisher lost its job claim.", "retry"
        )


def _park(
    config: MemoryCaptureConfig,
    context: JobExecutionContext,
    code: str,
    attempted: tuple[UUID, int] | None,
) -> None:
    with get_session_factory()() as db:
        query = select(MemoryExport).where(MemoryExport.owner_user_id == config.owner_user_id)
        if attempted is not None:
            query = query.where(
                MemoryExport.capture_id == attempted[0],
                MemoryExport.export_seq == attempted[1],
            )
        row = db.scalar(query.order_by(MemoryExport.export_seq).limit(1).with_for_update())
        _current(db, context)
        if row is not None:
            row.parked_code = code
        db.commit()


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> Mapping[str, Any]:
    del payload
    config = load_memory_capture_config(get_settings().memory_capture_config_path)
    if config is None or not config.capture or not config.admit:
        return {"status": "disabled"}
    attempted: tuple[UUID, int] | None = None
    with get_session_factory()() as db:

        def activate() -> NexusActivate:
            lock_revision(db, config.owner_user_id)
            _current(db, context)
            row = db.get_one(LibrarianState, config.owner_user_id)
            if row.memory_capture_id is None:
                row.memory_capture_id = uuid4()
                row.memory_capture_after_message_seq = row.next_seq
            assert row.memory_capture_after_message_seq is not None
            return NexusActivate(
                contract_revision=NEXUS_CONTRACT_REVISION,
                capture_id=row.memory_capture_id,
                owner_user_id=config.owner_user_id,
                capture_after_message_seq=str(row.memory_capture_after_message_seq),
            )

        activation = retry_read_committed(db, "memory_capture_activation", activate)
    try:
        with httpx2.Client(
            base_url=str(config.base_url),
            timeout=HTTP_TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            headers={
                "authorization": "Bearer " + config.bearer.get_secret_value(),
                "content-type": "application/json",
            },
        ) as http:
            registration = _request(
                http, "POST", "/v1/memory/nexus/activate", NexusRegistration, activation
            )
            if (
                registration.capture_id,
                registration.owner_user_id,
                registration.capture_after_message_seq,
            ) != (
                activation.capture_id,
                activation.owner_user_id,
                activation.capture_after_message_seq,
            ):
                raise MemoryError("source_conflict")
            through = registration.through_export_seq
            for _ in range(_EXPORTS_PER_RUN):
                with get_session_factory()() as db:
                    if not running_job_claim_is_current(db, context=context):
                        return {"status": "superseded"}
                    pending = db.scalar(
                        select(MemoryExport)
                        .where(MemoryExport.owner_user_id == config.owner_user_id)
                        .order_by(MemoryExport.export_seq)
                        .limit(1)
                    )
                    if pending is None:
                        return {"status": "caught_up"}
                    if pending.parked_code is not None:
                        return {"status": "parked", "code": pending.parked_code}
                    attempted = (pending.capture_id, pending.export_seq)
                    try:
                        export = NexusTurnExport.model_validate_json(
                            canonical_json(pending.payload)
                        )
                    except ValidationError:
                        raise MemoryError("invalid_input") from None
                    digest = pending.payload_sha256
                try:
                    request = NexusIngest(
                        contract_revision=NEXUS_CONTRACT_REVISION,
                        expected_through_export_seq=through,
                        payload=export,
                        payload_sha256=digest,
                    )
                except ValidationError:
                    raise MemoryError("invalid_input") from None
                try:
                    receipt = _request(
                        http, "POST", "/v1/memory/nexus/ingest", NexusReceipt, request
                    )
                except MemoryError as error:
                    if error.code != "stale_checkpoint":
                        raise
                    state = _request(http, "GET", "/v1/memory/nexus/state", NexusState)
                    current = state.registration
                    if current is None or (
                        current.capture_id,
                        current.owner_user_id,
                        current.capture_after_message_seq,
                    ) != (
                        activation.capture_id,
                        activation.owner_user_id,
                        activation.capture_after_message_seq,
                    ):
                        raise MemoryError("source_conflict") from None
                    through = current.through_export_seq
                    continue
                expected = NexusReceipt(
                    capture_id=export.capture_id,
                    export_seq=export.export_seq,
                    run_id=export.run_id,
                    payload_sha256=digest,
                )
                if receipt != expected:
                    raise _InvalidResponse
                with get_session_factory()() as db:
                    acknowledged = db.get(
                        MemoryExport,
                        (config.owner_user_id, export.capture_id, int(export.export_seq)),
                        with_for_update=True,
                    )
                    _current(db, context)
                    if acknowledged is not None:
                        assert (
                            acknowledged.run_id == receipt.run_id
                            and acknowledged.payload_sha256 == receipt.payload_sha256
                        )
                        db.delete(acknowledged)
                    db.commit()
                through = receipt.export_seq
    except MemoryError as error:
        if error.code in _PARK:
            _park(config, context, error.code, attempted)
        return {"status": error.code}
    except _InvalidResponse:
        return {"status": "invalid_response"}
    return {"status": "pending"}


def _operator_config() -> MemoryCaptureConfig | MemoryClientConfig | None:
    settings = get_settings()
    capture = load_memory_capture_config(settings.memory_capture_config_path)
    client = load_memory_client_config(settings.memory_client_config_path)
    if (
        capture is not None
        and client is not None
        and (capture.owner_user_id, capture.capture, capture.admit)
        != (client.owner_user_id, client.capture, client.admit)
    ):
        raise ValueError("memory client and publisher declarations disagree")
    return capture or client


def status() -> dict[str, Any]:
    config = _operator_config()
    if config is None:
        return {"configured": False}
    with get_session_factory()() as db:
        db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        state = db.get_one(LibrarianState, config.owner_user_id)
        count, oldest = db.execute(
            select(func.count(), func.min(MemoryExport.created_at)).where(
                MemoryExport.owner_user_id == config.owner_user_id
            )
        ).one()
        parked = db.scalar(
            select(MemoryExport.parked_code)
            .where(MemoryExport.owner_user_id == config.owner_user_id)
            .order_by(MemoryExport.export_seq)
            .limit(1)
        )
        result = {
            "configured": True,
            "capture": config.capture,
            "admit": config.admit,
            "capture_id": str(state.memory_capture_id) if state.memory_capture_id else None,
            "capture_after_message_seq": str(state.memory_capture_after_message_seq)
            if state.memory_capture_after_message_seq is not None
            else None,
            "pending_count": count,
            "oldest_pending_at": oldest.isoformat() if oldest else None,
            "parked_code": parked,
            "central": None,
        }
    if not isinstance(config, MemoryCaptureConfig):
        return result
    try:
        with httpx2.Client(
            base_url=str(config.base_url),
            timeout=HTTP_TIMEOUT,
            follow_redirects=False,
            trust_env=False,
            headers={"authorization": "Bearer " + config.bearer.get_secret_value()},
        ) as http:
            result["central"] = _request(
                http, "GET", "/v1/memory/nexus/state", NexusState
            ).model_dump(mode="json")
    except (MemoryError, _InvalidResponse):
        pass  # Unknown remote progress remains null; local evidence is still useful.
    return result


def retry(capture_id: UUID, export_seq: int) -> None:
    config = _operator_config()
    if config is None:
        raise ValueError("memory capture is not configured")
    with get_session_factory()() as db:
        row = db.get(
            MemoryExport, (config.owner_user_id, capture_id, export_seq), with_for_update=True
        )
        if row is None:
            raise ValueError("pending memory export not found")
        row.parked_code = None
        db.commit()
