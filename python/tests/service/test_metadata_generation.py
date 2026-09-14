"""Metadata publication fences source refreshes and preserves explicit unknown dates."""

from __future__ import annotations

import asyncio
import json
import threading
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import (
    ContentIndexState,
    Fragment,
    LibraryEntry,
    LLMModelTurn,
    Media,
    ProcessingStatus,
)
from nexus.db.session import create_session_factory
from nexus.jobs.queue import JobExecutionContext, complete_job, get_job
from nexus.jobs.registry import get_default_registry, resolve_job_handler
from nexus.schemas.presence import Present, absent, present
from nexus.services import generation_policy
from nexus.services.agent_tools_mcp import (
    ActiveAgentToolRegistry,
    active_agent_tool_registry,
    set_active_agent_tool_registry,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.durable_step_journal import (
    Completed,
    StepReplayState,
    checkpoint_step_state,
    decode_step_result,
    encode_step_result,
    read_step_states,
    stable_generation_id,
)
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    FrozenToolScope,
    ImmutablePromptPayloadRef,
    decode_generation_spec_document,
    generation_fact_digest,
)
from nexus.services.llm_execution import JobGenerationJournal
from nexus.services.metadata_dispatch import METADATA_STEP_PATH, enqueue_metadata_enrichment
from nexus.services.metadata_enrichment import MetadataEnrichmentOutput, get_content_sample
from nexus.services.reader_publication import replace_reader_publication
from nexus.tasks.enrich_metadata import (
    _CompletedMetadataResultEnvelope,
    _CompletedSuccess,
    _metadata_generation_intent,
    _metadata_user_content,
    _publish_completed_transaction,
)
from tests.testkit.codex_generation_server import CodexGenerationPeerServer
from tests.testkit.generation_catalog import configured_chat_catalog_service
from tests.testkit.llm_tool_scenarios import compose_available_product_tool_runtime
from tests.testkit.queue_claims import claim_job_row
from tests.testkit.unreachable_state import (
    cleanup_committed_upload_user,
    clear_heavy_capacity_holder,
    delete_generations_by_ids,
    delete_jobs_by_ids,
)


def test_metadata_registry_worker_binds_research_accepts_unknown_dates_and_replays(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = create_session_factory(engine)
    requester, media_id = uuid4(), uuid4()
    job_id = library_id = None
    previous_registry = active_agent_tool_registry()
    registry = ActiveAgentToolRegistry(session_factory=factory)
    operation = compose_available_product_tool_runtime().operations["MetadataRead"]
    registry.bind_operations((operation,))
    set_active_agent_tool_registry(registry)
    try:
        with (
            TemporaryDirectory(prefix="nexus-md-") as temporary,
            monkeypatch.context() as environment,
        ):
            socket_path = Path(temporary) / "peer.sock"
            audit_path = Path(temporary) / "requests.jsonl"
            audit_path.touch()
            environment.setenv("NEXUS_CODEX_AGENT_SOCKET", str(socket_path))
            environment.setenv("BRAVE_SEARCH_API_KEY", "metadata-proof-unused-brave-key")
            get_settings.cache_clear()
            with CodexGenerationPeerServer(socket_path, audit_path) as server:
                thread = threading.Thread(
                    target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
                )
                thread.start()
                try:
                    with factory() as db:
                        library_id = ensure_user_and_default_library(
                            db, requester, f"metadata-worker-{requester}@example.invalid"
                        )
                        db.add(
                            Media(
                                id=media_id,
                                kind="video",
                                title="Saved work",
                                processing_status=ProcessingStatus.pending,
                                created_by_user_id=requester,
                                original_published_date="1900",
                                edition_published_date="2000",
                            )
                        )
                        db.flush()
                        db.add(LibraryEntry(library_id=library_id, media_id=media_id))
                        assert enqueue_metadata_enrichment(
                            db,
                            media_id=media_id,
                            requester_user_id=requester,
                            request_id=None,
                            dedupe_key=f"metadata-worker:{media_id}",
                        )
                        job_id = db.scalar(
                            text("SELECT id FROM background_jobs WHERE dedupe_key = :key"),
                            {"key": f"metadata-worker:{media_id}"},
                        )
                        assert job_id is not None
                        definition = get_default_registry()["enrich_metadata"]
                        claimed = claim_job_row(
                            db,
                            job_id=job_id,
                            worker_id="metadata-worker-proof",
                            lease_seconds=definition.lease_seconds,
                            heavy_kinds=(definition.kind,),
                        )
                        assert claimed is not None
                        context = JobExecutionContext(
                            job_id=job_id,
                            worker_id="metadata-worker-proof",
                            attempt_no=claimed.attempts,
                            resource_class=definition.resource_class,
                            execution_id=claimed.execution_id,
                        )
                        payload = claimed.payload
                        db.commit()
                    handler = resolve_job_handler(definition.handler_path)
                    result = handler(payload=payload, context=context)
                    assert result == {
                        "status": "success",
                        "fields": ["original_published_date", "edition_published_date"],
                    }
                    assert handler(payload=payload, context=context) == result
                    with factory() as db:
                        media = db.get(Media, media_id)
                        assert (
                            media is not None
                            and media.original_published_date is None
                            and media.edition_published_date is None
                        )
                        job = get_job(db, job_id)
                        assert job is not None and job.payload["requester_user_id"] == str(
                            requester
                        )
                        admission = job.payload["generation_admissions"][METADATA_STEP_PATH]
                        spec = decode_generation_spec_document(admission["spec"])
                        assert (
                            isinstance(spec.model_tool_plan_snapshot, Present)
                            and spec.model_tool_plan_snapshot.value.plan_id == "MetadataRead"
                        )
                        assert isinstance(
                            spec.admitted_tool_scope, Present
                        ) and spec.admitted_tool_scope.value == FrozenToolScope(
                            admitted_refs=(f"media:{media_id}",), predicates=()
                        )
                        assert str(requester) in admission["intent"]["input"]
                        turns = db.scalars(
                            select(LLMModelTurn).where(
                                LLMModelTurn.generation_id
                                == stable_generation_id(job_id, METADATA_STEP_PATH)
                            )
                        ).all()
                        assert (
                            len(turns) == 1
                            and turns[0].accepted_at is not None
                            and turns[0].completed_at is not None
                        )
                        assert complete_job(
                            db,
                            job_id=job_id,
                            worker_id=context.worker_id,
                            attempt_no=context.attempt_no,
                            result_payload=result,
                        )
                        db.commit()
                    audits = [json.loads(line) for line in audit_path.read_text().splitlines()]
                    assert len(audits) == 1
                    assert (
                        audits[0]["model_tool_plan"] == "MetadataRead"
                        and audits[0]["tool_grant_present"] is True
                    )
                finally:
                    server.shutdown()
                    thread.join(timeout=5)
                    assert not thread.is_alive()
    finally:
        set_active_agent_tool_registry(previous_registry)
        registry.unbind_operations((operation,))
        get_settings.cache_clear()
        with factory() as db:
            if job_id is not None:
                if db.scalar(
                    text("SELECT 1 FROM background_job_capacity_leases WHERE job_id = :id"),
                    {"id": job_id},
                ):
                    clear_heavy_capacity_holder(db, job_id=job_id)
                delete_generations_by_ids(
                    db, generation_ids=(stable_generation_id(job_id, METADATA_STEP_PATH),)
                )
                delete_jobs_by_ids(db, job_ids=(job_id,))
            db.commit()
        cleanup_committed_upload_user(engine, user_id=requester)


@pytest.mark.parametrize(
    "change", ["none", "reader", "index_revision", "index_status", "index_timestamp", "access"]
)
def test_metadata_publication_rechecks_source_versions_and_replays_null_dates(
    db_session: Session, change: str
) -> None:
    db = db_session
    requester = uuid4()
    library_id = ensure_user_and_default_library(
        db, requester, f"metadata-{requester}@example.invalid"
    )
    media = Media(
        kind="web_article",
        title="A work",
        created_by_user_id=requester,
        processing_status=ProcessingStatus.ready_for_reading,
        original_published_date="1900",
        edition_published_date="2000",
    )
    db.add(media)
    db.flush()
    membership = LibraryEntry(library_id=library_id, media_id=media.id)
    db.add(membership)
    first = Fragment(
        media_id=media.id, idx=0, canonical_text="early text " * 1000, html_sanitized="<p>early</p>"
    )
    later = Fragment(
        media_id=media.id, idx=1, canonical_text="old later passage", html_sanitized="<p>old</p>"
    )
    db.add_all([first, later])
    index = ContentIndexState(owner_kind="media", owner_id=media.id, revision=1, status="ready")
    db.add(index)
    db.flush()
    replace_reader_publication(
        db, media_id=media.id, expected_kind="web_article", replace_projection=lambda _: None
    )
    original_sample = get_content_sample(db, media)
    intent = _metadata_generation_intent(
        input=_metadata_user_content(db, media, requester_user_id=requester)
    )
    service = GenerationService(
        catalog=configured_chat_catalog_service(),
        tools=compose_available_product_tool_runtime(),
        policy=generation_policy.GENERATION_POLICY,
    )
    spec = asyncio.run(
        service.freeze_background(
            operation="metadata_enrichment",
            intent=intent,
            prompt_template_revision="metadata-test.v1",
            prompt_payload_ref=ImmutablePromptPayloadRef(
                owner_kind="media_enrichment",
                owner_id=str(media.id),
                revision="metadata-test.v1",
                payload_digest=generation_fact_digest(intent.model_dump(mode="json")),
            ),
            scope=FrozenToolScope(admitted_refs=(f"media:{media.id}",), predicates=()),
        )
    )
    assert enqueue_metadata_enrichment(
        db,
        media_id=media.id,
        requester_user_id=requester,
        request_id=None,
        dedupe_key=f"metadata-proof:{media.id}",
    )
    assert not enqueue_metadata_enrichment(
        db,
        media_id=media.id,
        requester_user_id=requester,
        request_id=None,
        dedupe_key=f"metadata-proof:{media.id}",
    )
    job_id = db.scalar(
        text("SELECT id FROM background_jobs WHERE dedupe_key = :key"),
        {"key": f"metadata-proof:{media.id}"},
    )
    assert job_id is not None
    claimed = claim_job_row(
        db, job_id=job_id, worker_id="metadata-proof", lease_seconds=300, heavy_kinds=()
    )
    assert claimed is not None
    context = JobExecutionContext(
        job_id=job_id,
        worker_id="metadata-proof",
        attempt_no=claimed.attempts,
        resource_class="Light",
        execution_id=claimed.execution_id,
    )
    generation_id = stable_generation_id(job_id, METADATA_STEP_PATH)
    journal = JobGenerationJournal(
        context=context,
        step_path=METADATA_STEP_PATH,
        lock_dispatch=lambda session: get_job(session, job_id),
    )
    journal.prepare_admission(db, generation_id=generation_id, spec=spec, intent=intent)
    completed = _CompletedSuccess(
        enrichment=MetadataEnrichmentOutput(
            title=None,
            authors=None,
            publisher=None,
            description=None,
            original_published_date=None,
            edition_published_date=None,
            language=None,
        ),
        publication_result=absent(),
    )
    job = get_job(db, job_id)
    assert job is not None and job.payload["requester_user_id"] == str(requester)
    assert checkpoint_step_state(
        db,
        ctx=context,
        job=job,
        step_path=METADATA_STEP_PATH,
        state=StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Completed,
            request_fingerprint=present(spec.fingerprint),
            terminal_result=present(encode_step_result(completed)),
        ),
    )
    if change == "reader":

        def replace_later(_media: Media) -> None:
            later.canonical_text = "new later passage"

        replace_reader_publication(
            db, media_id=media.id, expected_kind="web_article", replace_projection=replace_later
        )
    elif change == "index_revision":
        index.revision += 1
    elif change == "index_status":
        index.status = "indexing"
    elif change == "index_timestamp":
        # Transcript indexing republishes atomically without moving revision/status.
        index.updated_at += timedelta(microseconds=1)
        assert (index.revision, index.status) == (1, "ready")
    elif change == "access":
        db.delete(membership)
    db.flush()
    assert get_content_sample(db, media) == original_sample
    result = _publish_completed_transaction(
        db,
        context=context,
        media_id=media.id,
        request_fingerprint=spec.fingerprint,
        completed=completed,
    )
    if change == "none":
        assert result["status"] == "success"
        assert {"original_published_date", "edition_published_date"} <= set(result["fields"])
        assert media.original_published_date is None and media.edition_published_date is None
    else:
        assert result["reason"] == ("media_not_found" if change == "access" else "source_changed")
        assert media.original_published_date == "1900" and media.edition_published_date == "2000"
    persisted = get_job(db, job_id)
    assert persisted is not None
    terminal = read_step_states(persisted)[METADATA_STEP_PATH].terminal_result
    assert isinstance(terminal, Present)
    replay = decode_step_result(terminal.value, _CompletedMetadataResultEnvelope).root
    assert (
        _publish_completed_transaction(
            db,
            context=context,
            media_id=media.id,
            request_fingerprint=spec.fingerprint,
            completed=replay,
        )
        == result
    )
