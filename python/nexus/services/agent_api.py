"""Run-bound bearer admission and canonical HTTP tool execution."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from llm_tools import (
    ParsedJson,
    PositionConflictDefect,
    RecoveryRequired,
    ToolId,
    Unavailable,
    raw_input_digest,
)
from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    AssistantWriteAuthorship,
    GenerationApiCredential,
    LLMCall,
    LLMModelTurn,
    LLMToolPosition,
)
from nexus.jobs.queue import JobExecutionContext, get_job, lock_running_job_claim
from nexus.services.generation_spec import CodexShell
from nexus.services.llm_ledger import (
    LlmCallOwner,
    lock_active_generation_for_authority_in_current_transaction,
)
from nexus.services.tool_authority import (
    GenerationToolExecutor,
    ToolAuthority,
    ToolAuthorityRefused,
)
from nexus.services.tool_runtime.catalog import FrozenToolOperation, write_tool_ids

GENERATION_API_CONTRACT_REVISION = "nexus-generation-api.v1"


class AgentApiRefusal(RuntimeError):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True, slots=True)
class AgentApiAdmission:
    user_id: UUID
    owner: LlmCallOwner
    generation_id: UUID
    job_context: JobExecutionContext
    child_seq: int | None


def _owner_user_id(db: Session, *, owner: LlmCallOwner, job_id: UUID) -> UUID | None:
    job = get_job(db, job_id)
    if job is None:
        return None
    payload_key = {
        "chat_run": "run_id",
        "oracle_reading": "reading_id",
        "artifact_build": "build_id",
        "media_summary": "summary_id",
        "media_enrichment": "media_id",
    }.get(owner.kind)
    if payload_key is not None and job.payload.get(payload_key) != str(owner.id):
        return None
    if owner.kind == "synapse_scan":
        from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

        ref = parse_resource_ref(str(job.payload.get("ref", "")))
        if isinstance(ref, ResourceRefParseFailure) or ref.id != owner.id:
            return None
    direct = {
        "chat_run": ("chat_runs", "owner_user_id"),
        "oracle_reading": ("oracle_readings", "user_id"),
        "artifact_build": ("artifact_builds", "requester_user_id"),
    }
    if owner.kind in direct:
        table, column = direct[owner.kind]
        value = db.scalar(text(f"SELECT {column} FROM {table} WHERE id = :id"), {"id": owner.id})
        return UUID(str(value)) if value is not None else None
    if owner.kind == "media_summary":
        value = db.scalar(
            text(
                "SELECT m.created_by_user_id FROM media_summaries s JOIN media m ON m.id = s.media_id WHERE s.id = :id"
            ),
            {"id": owner.id},
        )
        return UUID(str(value)) if value is not None else None
    if owner.kind in {"synapse_scan", "media_enrichment"}:
        key = "user_id" if owner.kind == "synapse_scan" else "requester_user_id"
        value = job.payload.get(key)
        try:
            return UUID(str(value))
        except ValueError:
            return None
    return None


def issue_generation_api_credential(
    session_factory: sessionmaker[Session],
    *,
    user_id: UUID,
    owner: LlmCallOwner,
    generation_id: UUID,
    job_context: JobExecutionContext,
    expires_at: datetime,
) -> str:
    """Mint once after admission; never persist or log the raw bearer."""

    with session_factory() as db, db.begin():
        return issue_generation_api_credential_in_current_transaction(
            db,
            user_id=user_id,
            owner=owner,
            generation_id=generation_id,
            job_context=job_context,
            expires_at=expires_at,
        )


def issue_generation_api_credential_in_current_transaction(
    db: Session,
    *,
    user_id: UUID,
    owner: LlmCallOwner,
    generation_id: UUID,
    job_context: JobExecutionContext,
    expires_at: datetime,
) -> str:
    """Stage a bearer with child arm and uncertain dispatch in one transaction."""

    if expires_at.tzinfo is None:
        raise ValueError("generation API expiry must be timezone aware")
    token = secrets.token_urlsafe(48)
    digest = hashlib.sha256(token.encode("ascii")).hexdigest()
    generation = lock_active_generation_for_authority_in_current_transaction(
        db, owner=owner, generation_id=generation_id
    )
    if generation is None or not isinstance(generation.spec.authority, CodexShell):
        raise ToolAuthorityRefused("generation API requires active Codex authority")
    if not lock_running_job_claim(db, context=job_context):
        raise ToolAuthorityRefused("generation API requires the live job claim")
    job = get_job(db, job_context.job_id)
    if job is None or job.execution_id != job_context.execution_id:
        raise ToolAuthorityRefused("generation API job execution changed")
    if _owner_user_id(db, owner=owner, job_id=job_context.job_id) != user_id:
        raise ToolAuthorityRefused("generation API account differs from owner")
    now = db.scalar(func.clock_timestamp())
    if not isinstance(now, datetime) or expires_at <= now:
        raise ToolAuthorityRefused("generation API credential has no live lifetime")
    existing = db.get(GenerationApiCredential, generation_id)
    if existing is not None:
        raise ToolAuthorityRefused("generation API credential was already issued")
    db.add(
        GenerationApiCredential(
            generation_id=generation_id,
            token_sha256=digest,
            job_execution_id=job_context.execution_id,
            user_id=user_id,
            expires_at=expires_at.astimezone(UTC),
            closed_at=None,
        )
    )
    return token


def close_generation_api_admission(db: Session, *, generation_id: UUID) -> None:
    """Close inside the same owner-locked transaction as terminal acceptance."""

    row = db.get(GenerationApiCredential, generation_id)
    if row is not None and row.closed_at is None:
        row.closed_at = func.clock_timestamp()
        db.flush()


def close_generation_api_admission_for_owner(db: Session, *, owner: LlmCallOwner) -> None:
    """Close an owner's run bearer in the transaction that requests cancellation."""

    db.execute(
        update(GenerationApiCredential)
        .where(
            GenerationApiCredential.generation_id.in_(
                select(LLMCall.id).where(
                    LLMCall.owner_kind == owner.kind,
                    LLMCall.owner_id == owner.id,
                )
            ),
            GenerationApiCredential.closed_at.is_(None),
        )
        .values(closed_at=func.clock_timestamp())
    )


def authenticate_generation_api(
    db: Session, *, bearer: str, require_child: bool
) -> AgentApiAdmission:
    if not bearer or len(bearer) > 512:
        raise AgentApiRefusal(401, "invalid_bearer")
    digest = hashlib.sha256(bearer.encode("utf-8")).hexdigest()
    credential = db.scalar(
        select(GenerationApiCredential).where(GenerationApiCredential.token_sha256 == digest)
    )
    if credential is None:
        raise AgentApiRefusal(401, "invalid_bearer")
    call = db.get(LLMCall, credential.generation_id)
    if call is None:
        raise AgentApiRefusal(409, "inactive_generation")
    owner = LlmCallOwner(kind=call.owner_kind, id=call.owner_id)  # type: ignore[arg-type]
    generation = lock_active_generation_for_authority_in_current_transaction(
        db, owner=owner, generation_id=call.id
    )
    now = db.scalar(func.clock_timestamp())
    if (
        generation is None
        or not isinstance(generation.spec.authority, CodexShell)
        or credential.closed_at is not None
        or not isinstance(now, datetime)
        or credential.expires_at <= now
    ):
        raise AgentApiRefusal(409, "inactive_generation")
    claim = db.execute(
        text(
            "SELECT id, kind, claimed_by, attempts FROM background_jobs WHERE execution_id = :execution_id AND status = 'running' AND lease_expires_at > clock_timestamp() FOR UPDATE"
        ),
        {"execution_id": credential.job_execution_id},
    ).one_or_none()
    if claim is None or claim.claimed_by is None:
        raise AgentApiRefusal(409, "changed_job_claim")
    from nexus.jobs.registry import get_default_registry

    job_definition = get_default_registry().get(claim.kind)
    if job_definition is None:
        raise AgentApiRefusal(409, "changed_job_claim")
    context = JobExecutionContext(
        job_id=claim.id,
        worker_id=claim.claimed_by,
        attempt_no=claim.attempts,
        resource_class=job_definition.resource_class,
        execution_id=credential.job_execution_id,
    )
    job = get_job(db, context.job_id)
    if job is None or job.execution_id != credential.job_execution_id:
        raise AgentApiRefusal(409, "changed_job_claim")
    if _owner_user_id(db, owner=owner, job_id=context.job_id) != credential.user_id:
        raise AgentApiRefusal(409, "changed_account")
    child = db.scalar(
        select(LLMModelTurn)
        .where(
            LLMModelTurn.generation_id == call.id,
            LLMModelTurn.dispatch_started_at.is_not(None),
            LLMModelTurn.terminal.is_(None),
        )
        .order_by(LLMModelTurn.turn_seq.desc())
        .limit(1)
    )
    if require_child and child is None:
        raise AgentApiRefusal(409, "inactive_child")
    return AgentApiAdmission(
        user_id=credential.user_id,
        owner=owner,
        generation_id=call.id,
        job_context=context,
        child_seq=child.turn_seq if child is not None else None,
    )


async def execute_operation(
    *,
    bearer: str,
    canonical_id: str,
    idempotency_key: UUID,
    arguments: dict[str, object],
    operation: FrozenToolOperation,
    session_factory: sessionmaker[Session],
) -> dict[str, object]:
    tool_id = ToolId(canonical_id)
    if tool_id not in operation.profile.grants:
        raise AgentApiRefusal(404, "unknown_operation")
    try:
        with session_factory() as db, db.begin():
            admission = authenticate_generation_api(db, bearer=bearer, require_child=False)
            existing = db.scalar(
                select(LLMToolPosition).where(
                    LLMToolPosition.generation_id == admission.generation_id,
                    LLMToolPosition.transport_kind == "GenerationApi",
                    LLMToolPosition.transport_call_id == str(idempotency_key),
                )
            )
            if existing is not None:
                digest = raw_input_digest(ParsedJson(arguments))
                if (
                    existing.canonical_tool_id != canonical_id
                    or existing.canonical_input_digest != digest
                ):
                    raise AgentApiRefusal(409, "replay_mismatch")
                if existing.replay_status != "Completed":
                    raise AgentApiRefusal(409, "operation_in_progress_or_uncertain")
                evidence = existing.result_evidence
                typed_result = evidence.get("tool_result") if evidence is not None else None
                if not isinstance(typed_result, dict):
                    raise RuntimeError(
                        "completed generation API operation lacks its typed ledger result"
                    )
                return {"position_id": str(existing.id), "result": typed_result}
            if admission.child_seq is None:
                raise AgentApiRefusal(409, "inactive_child")
            if isinstance(operation.plan.catalog_view.binding(tool_id).execute, Unavailable):
                raise AgentApiRefusal(503, "dependency_unavailable")
            projection = None
            if admission.owner.kind == "chat_run":
                from nexus.services.tool_runtime.chat_projection import ChatToolExecutionProjection

                projection = ChatToolExecutionProjection.from_run(db, run_id=admission.owner.id)
    except ToolAuthorityRefused as error:
        raise AgentApiRefusal(409, "inactive_generation") from error
    try:
        authority = await ToolAuthority.from_claimed_generation_attempt(
            session_factory=session_factory,
            user_id=admission.user_id,
            owner=admission.owner,
            generation_id=admission.generation_id,
            job_context=admission.job_context,
            operation=operation,
            projection=projection,
        )
        result = await GenerationToolExecutor(authority).execute_canonical(
            transport_kind="GenerationApi",
            model_turn_seq=admission.child_seq,
            transport_call_id=str(idempotency_key),
            provider_wire_name=canonical_id,
            tool_id=tool_id,
            arguments=arguments,
        )
    except ToolAuthorityRefused as error:
        raise AgentApiRefusal(409, "inactive_generation") from error
    except PositionConflictDefect as error:
        raise AgentApiRefusal(409, "replay_mismatch") from error
    except RecoveryRequired as error:
        raise AgentApiRefusal(409, "operation_uncertain") from error
    position = result.position
    if position is None:
        raise RuntimeError("generation API operation lacks its durable position")
    evidence = position.result_evidence
    typed_result = evidence.get("tool_result") if evidence is not None else None
    if not isinstance(typed_result, dict):
        raise RuntimeError("completed generation API operation lacks its typed ledger result")
    return {"position_id": str(position.id), "result": typed_result}


def undo_generation_api_position(db: Session, *, viewer_id: UUID, position_id: UUID) -> bool:
    """Undo one completed background write and stamp provenance atomically."""

    from nexus.services.agent_tools.writes import revert_created_refs_in_current_transaction

    try:
        row = db.scalar(
            select(LLMToolPosition)
            .join(
                GenerationApiCredential,
                GenerationApiCredential.generation_id == LLMToolPosition.generation_id,
            )
            .join(LLMCall, LLMCall.id == LLMToolPosition.generation_id)
            .where(
                LLMToolPosition.id == position_id,
                LLMToolPosition.transport_kind == "GenerationApi",
                LLMToolPosition.canonical_tool_id.in_(write_tool_ids()),
                GenerationApiCredential.user_id == viewer_id,
                LLMCall.owner_kind != "chat_run",
            )
            .with_for_update()
        )
        if row is None:
            raise AgentApiRefusal(404, "write_position_not_found")
        if row.replay_status != "Completed":
            raise AgentApiRefusal(409, "operation_in_progress_or_uncertain")
        result = row.result_evidence
        if not isinstance(result, dict) or not isinstance(result.get("tool_result"), dict):
            raise RuntimeError("completed generation API position lacks result evidence")
        tool_result = result["tool_result"]
        assert isinstance(tool_result, dict)
        if tool_result.get("type") != "Success":
            raise AgentApiRefusal(409, "write_did_not_succeed")
        refs = result.get("created_refs")
        if not isinstance(refs, list) or any(not isinstance(ref, dict) for ref in refs):
            raise RuntimeError("completed generation API write lacks created refs")
        if row.reverted_at is not None:
            return False
        revert_created_refs_in_current_transaction(db, viewer_id=viewer_id, refs=refs)
        now = db.scalar(func.clock_timestamp())
        if not isinstance(now, datetime):
            raise RuntimeError("database clock did not return a timestamp")
        row.reverted_at = now
        db.execute(
            update(AssistantWriteAuthorship)
            .where(AssistantWriteAuthorship.tool_position_id == position_id)
            .values(reverted_at=now)
        )
        db.commit()
        return True
    except BaseException:
        db.rollback()
        raise


def list_generation_api_effects(
    db: Session,
    *,
    viewer_id: UUID,
    generation_id: UUID | None = None,
    before: UUID | None = None,
) -> dict[str, object]:
    """Read one bounded page of account-owned additive operation positions."""

    base = (
        select(LLMToolPosition)
        .join(
            GenerationApiCredential,
            GenerationApiCredential.generation_id == LLMToolPosition.generation_id,
        )
        .join(LLMCall, LLMCall.id == LLMToolPosition.generation_id)
        .where(
            GenerationApiCredential.user_id == viewer_id,
            LLMCall.owner_kind != "chat_run",
            LLMToolPosition.transport_kind == "GenerationApi",
            LLMToolPosition.canonical_tool_id.in_(write_tool_ids()),
        )
    )
    if generation_id is not None:
        base = base.where(LLMToolPosition.generation_id == generation_id)
    if before is not None:
        cursor = db.scalar(base.where(LLMToolPosition.id == before))
        if cursor is None:
            raise AgentApiRefusal(404, "effect_cursor_not_found")
        base = base.where(
            or_(
                LLMToolPosition.created_at < cursor.created_at,
                and_(
                    LLMToolPosition.created_at == cursor.created_at,
                    LLMToolPosition.id < cursor.id,
                ),
            )
        )
    rows = db.scalars(
        base.order_by(LLMToolPosition.created_at.desc(), LLMToolPosition.id.desc()).limit(31)
    ).all()
    items: list[dict[str, object]] = []
    for row in rows[:30]:
        evidence = row.result_evidence or {}
        result = evidence.get("tool_result")
        created_refs = evidence.get("created_refs")
        undo_allowed = (
            row.replay_status == "Completed"
            and isinstance(result, dict)
            and result.get("type") == "Success"
            and row.reverted_at is None
        )
        items.append(
            {
                "position_id": str(row.id),
                "generation_id": str(row.generation_id),
                "canonical_id": row.canonical_tool_id,
                "replay_status": row.replay_status,
                "created_at": row.created_at.isoformat(),
                "created_refs": created_refs if isinstance(created_refs, list) else None,
                "result": result if isinstance(result, dict) else None,
                "reverted_at": row.reverted_at.isoformat() if row.reverted_at else None,
                "undo_allowed": undo_allowed,
                "undo_url": f"/generation-effects/{row.id}/undo" if undo_allowed else None,
            }
        )
    return {"items": items, "next_cursor": str(rows[29].id) if len(rows) > 30 else None}
