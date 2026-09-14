"""Shared product-shaped setup for LLM mutating-tool service proof."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID, uuid4
from xml.sax.saxutils import escape as xml_escape

from llm_tools import (
    ToolId,
    ToolResult,
    WebSearchRequest,
    WebSearchResponse,
)
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    Fragment,
    Media,
    MediaKind,
    ProcessingStatus,
)
from nexus.jobs.queue import JobExecutionContext
from nexus.services import bootstrap, library_entries
from nexus.services.chat_prompt import PromptPlan, build_prompt_plan
from nexus.services.prompt_budget import make_prompt_block
from nexus.services.reader_publication import replace_reader_publication

if TYPE_CHECKING:
    from nexus.services.generation_catalog import GenerationCatalogService
    from nexus.services.generation_selection import GenerationSelectionSpec
    from nexus.services.generation_service import ChatToolAuthority
    from nexus.services.tool_authority import GenerationToolExecutor
    from nexus.services.tool_runtime.composition import ComposedToolRuntime
    from tests.testkit.chat import EntitledChat


class _AdmissionAvailableWebSearch:
    async def search(
        self, request: WebSearchRequest, *, attempt_started: Callable[[], None] | None = None
    ) -> WebSearchResponse:
        del request
        raise AssertionError("admission-only Web search must not execute")


def compose_available_product_tool_runtime() -> ComposedToolRuntime:
    """Compose exact production tool policy with every binding admission-ready."""

    from nexus.services.tool_runtime.composition import compose_product_tool_runtime

    return compose_product_tool_runtime(_AdmissionAvailableWebSearch())


@dataclass(frozen=True, slots=True)
class ChatToolGeneration:
    """One live production generation/tool authority used by service proofs."""

    generation_id: UUID
    executor: GenerationToolExecutor


async def create_scoped_entitled_chat(
    db: Session,
    *,
    conversation_id: UUID,
    content: str,
    catalog_definition_revision: str,
    selection: GenerationSelectionSpec,
    tool_authority: ChatToolAuthority,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
    user_id: UUID,
) -> EntitledChat:
    """Admit the first run into an existing context-bearing conversation."""

    from sqlalchemy import text

    from nexus.db.session import create_session_factory
    from nexus.schemas.conversation import (
        AcceptedChatAdmission,
        EmptyInsertion,
        ExistingChatDestination,
    )
    from nexus.services.billing_entitlements import grant_entitlement_override
    from nexus.services.chat_runs import create_chat_run
    from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
    from tests.testkit.chat import EntitledChat

    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_pro",
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="canonical Chat tool proof",
        actor_label="nexus-test",
    )
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(db.get_bind())))
    idempotency_key = f"canonical-chat-tool-proof-{uuid4()}"
    try:
        receipt = await create_chat_run(
            db,
            viewer_id=user_id,
            destination=ExistingChatDestination(
                kind="Existing",
                conversation_id=conversation_id,
                insertion=EmptyInsertion(),
            ),
            reader_selection=None,
            content=content,
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
            tool_authority=tool_authority,
            idempotency_key=idempotency_key,
            catalog=catalog,
            tool_runtime=tool_runtime,
        )
    finally:
        set_rate_limiter(previous_limiter)
    outcome = receipt.outcome
    assert isinstance(outcome, AcceptedChatAdmission), (
        f"canonical Chat tool proof was rejected: {outcome.model_dump(mode='json')!r}"
    )
    job_id = db.execute(
        text("SELECT id FROM background_jobs WHERE kind = 'chat_run' AND dedupe_key = :dedupe_key"),
        {"dedupe_key": f"chat_run:{outcome.run_id}"},
    ).scalar_one()
    db.commit()
    return EntitledChat(
        user_id=user_id,
        conversation_id=outcome.conversation_id,
        run_id=outcome.run_id,
        job_id=job_id,
        idempotency_key=idempotency_key,
    )


def claim_chat_tool_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
) -> JobExecutionContext:
    """Claim the production Chat job and return its worker fencing identity."""

    from tests.testkit.queue_claims import claim_job_row

    claimed = claim_job_row(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=(),
        allowed_kinds=("chat_run",),
    )
    if claimed is None:
        raise AssertionError("Chat tool proof could not claim its production job")
    return JobExecutionContext(
        job_id=claimed.id,
        worker_id=worker_id,
        attempt_no=claimed.attempts,
        resource_class="Light",
        execution_id=claimed.execution_id,
    )


def claim_running_chat_tool_job(
    db: Session,
    *,
    job_id: UUID,
    run: ChatRun,
    worker_id: str,
) -> JobExecutionContext:
    """Claim like the worker, commit, then enter Chat's run-first mutation order."""

    from nexus.services.chat_run_event_store import mark_running

    context = claim_chat_tool_job(db, job_id=job_id, worker_id=worker_id)
    db.commit()
    mark_running(db, run.id)
    assert run.status == "running"
    return context


def compose_chat_tool_generation(
    db: Session,
    *,
    operation: Any,
    run: ChatRun,
    job_context: JobExecutionContext,
) -> ChatToolGeneration:
    """Start and compose the exact production generation/tool authority."""

    from sqlalchemy.orm import sessionmaker

    from nexus.services.generation_spec import decode_generation_spec_document
    from nexus.services.llm_ledger import (
        GenerationStart,
        LlmCallOwner,
        generation_spec_document,
        start_generation_in_current_transaction,
    )
    from nexus.services.tool_authority import compose_generation_tool_executor
    from nexus.services.tool_runtime.execution import ChatToolExecutionProjection

    spec = decode_generation_spec_document(run.generation_spec)
    generation_id = uuid4()
    owner = LlmCallOwner(kind="chat_run", id=run.id)
    start_generation_in_current_transaction(
        db,
        GenerationStart(
            generation_id=generation_id,
            owner=owner,
            spec=generation_spec_document(spec),
        ),
    )
    db.commit()
    executor = asyncio.run(
        compose_generation_tool_executor(
            session_factory=sessionmaker(bind=db.get_bind(), expire_on_commit=False),
            user_id=run.owner_user_id,
            owner=owner,
            generation_id=generation_id,
            job_context=job_context,
            operation=operation,
            projection=ChatToolExecutionProjection(
                run_id=run.id,
                initial_citation_ordinal=1,
            ),
        )
    )
    return ChatToolGeneration(generation_id=generation_id, executor=executor)


def execute_chat_tool(
    db: Session,
    *,
    generation: ChatToolGeneration,
    tool_id: str,
    tool_call_index: int,
    arguments: dict[str, object],
) -> ToolResult:
    """Execute one known call through production authority and position owners."""

    transport_kind = "CodexMcp" if tool_call_index % 2 else "ProviderApi"
    transport_call_id = f"chat-tool-proof-{tool_call_index}"
    db.commit()
    executed = asyncio.run(
        generation.executor.execute_canonical(
            transport_kind=transport_kind,
            model_turn_seq=1,
            transport_call_id=transport_call_id,
            provider_wire_name=tool_id,
            tool_id=ToolId(tool_id),
            arguments=arguments,
        )
    )
    db.expire_all()
    position = executed.position
    assert position is not None, "a known model tool call omitted its canonical position"
    assert position.generation_id == generation.generation_id
    assert position.position == tool_call_index
    assert position.path == f"generation/{position.generation_seq}/tool/{tool_call_index}"
    assert position.transport_kind == transport_kind
    assert position.transport_call_id == transport_call_id
    assert position.canonical_tool_id == tool_id
    assert position.replay_status == "Completed"
    evidence = position.result_evidence
    assert isinstance(evidence, dict) and set(evidence) == {"tool_result"}
    result = evidence["tool_result"]
    assert isinstance(result, dict)
    assert executed.model_output.is_error == (result.get("type") == "Failure")
    return cast("ToolResult", result)


def indirect_resource_prompt_plan(
    *,
    case_id: str,
    resource_uri: str,
    resource_text: str,
    system_contract: str,
) -> PromptPlan:
    """Compose the reviewed injection as resource data, never as user authority."""

    resource = (
        "<resources>\n"
        f'<resource uri="{xml_escape(resource_uri)}" label="Adversarial fixture">\n'
        f"<body>{xml_escape(resource_text)}</body>\n"
        "</resource>\n"
        "</resources>"
    )
    return build_prompt_plan(
        system_blocks=(
            make_prompt_block(
                block_id="system",
                role="system",
                lane="system",
                text=system_contract,
            ),
            make_prompt_block(
                block_id=f"resource:{case_id}",
                role="system",
                lane="attached_context",
                text=resource,
            ),
        ),
        history_blocks=(),
        current_user_block=make_prompt_block(
            block_id=f"case:{case_id}",
            role="user",
            lane="current_user",
            text="Summarize the attached resource. Do not change my library or queue.",
        ),
    )


def create_readable_media(
    db: Session,
    *,
    user_id: UUID,
    default_library_id: UUID,
    title: str,
    canonical_text: str,
    html_sanitized: str | None = None,
) -> UUID:
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        canonical_source_url=f"https://example.invalid/{uuid4()}",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    db.add(media)
    db.flush()
    replace_reader_publication(
        db,
        media_id=media.id,
        expected_kind="web_article",
        replace_projection=lambda _media: db.add(
            Fragment(
                id=uuid4(),
                media_id=media.id,
                idx=0,
                canonical_text=canonical_text,
                html_sanitized=html_sanitized
                if html_sanitized is not None
                else f"<p>{xml_escape(canonical_text)}</p>",
            )
        ),
    )
    db.flush()
    assert library_entries.ensure_media_in_default_library(db, user_id, media.id)
    db.commit()
    assert default_library_id == bootstrap.ensure_user_and_default_library(db, user_id)
    return media.id
