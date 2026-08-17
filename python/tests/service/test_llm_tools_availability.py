"""Priority proof for keyless tool-runtime availability and Idea admission."""

from __future__ import annotations

import asyncio
from collections.abc import Generator
from typing import Any
from uuid import UUID, uuid4

import pytest
from apps.worker.main import create_worker
from fastapi import FastAPI
from fastapi.testclient import TestClient
from llm_tools import (
    ExecutionContext,
    InvocationPosition,
    ParsedJson,
    Principal,
    Scope,
    ToolExecutor,
    ToolId,
)
from llm_tools.testing import (
    InMemoryBudgetState,
    InMemoryPositionRecorder,
    NeverCancelled,
    RecordingTelemetry,
)
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.config import clear_settings_cache, get_settings
from nexus.db.models import SynthesisArtifact
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.schemas.presence import absent
from nexus.services.artifacts.idea_identity import IdeaKey, canonicalize_idea_text
from nexus.services.artifacts.idea_seeds import find_or_create_idea_subject
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.rate_limit import get_rate_limiter, set_rate_limiter
from tests.testkit.auth import StaticTokenVerifier, UserRecord

_CHAT_TOOL_IDS = (
    "web.search",
    "nexus.search",
    "nexus.resource.read",
    "nexus.document.search",
    "nexus.resource.inspect",
    "nexus.relations.list",
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)


def _keyless_app(db: Session, user: UserRecord) -> tuple[FastAPI, StaticTokenVerifier]:
    verifier = StaticTokenVerifier(user.id, user.email)

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        return ensure_user_and_default_library(db, user_id, email)

    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=False,
            internal_secret=None,
            bootstrap_callback=bootstrap,
        )
    )
    add_request_id_middleware(app, log_requests=False)

    def session() -> Generator[Session, None, None]:
        yield db

    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_repeatable_read_db] = session
    return app, verifier


def _tool_ids(operation: Any) -> tuple[str, ...]:
    return tuple(str(grant.id) for grant in operation.profile.ordered_grants)


def _execute_keyless_web(operation: Any) -> tuple[dict[str, object], Any, Any, Any]:
    tool_id = ToolId("web.search")
    position = InvocationPosition("keyless-chat/web-search")
    recorder = InMemoryPositionRecorder()
    telemetry = RecordingTelemetry()
    context = ExecutionContext(
        plan=operation.plan,
        grant=operation.profile.grant(tool_id),
        catalog_view=operation.plan.catalog_view,
        position=position,
        recorder=recorder,
        effect_id=None,
        budgets=InMemoryBudgetState(operation.profile.run_limits),
        principal=Principal("keyless-availability-proof"),
        scope=Scope("chat"),
        cancellation=NeverCancelled(),
        telemetry=telemetry,
    )
    result = asyncio.run(
        ToolExecutor.execute(
            operation.plan.catalog_view.binding(tool_id),
            ParsedJson(
                {
                    "query": "keyless runtime availability",
                    "freshness_days": None,
                }
            ),
            context,
        )
    )
    return result, recorder, telemetry, position


def _idea_work_counts(db: Session, *, artifact_id: UUID) -> tuple[int, int]:
    builds = int(
        db.scalar(
            text("SELECT count(*) FROM artifact_builds WHERE artifact_id = :artifact_id"),
            {"artifact_id": artifact_id},
        )
        or 0
    )
    jobs = int(
        db.scalar(text("SELECT count(*) FROM background_jobs WHERE kind = 'dossier_build'")) or 0
    )
    return builds, jobs


def test_keyless_boot_preserves_plan_and_refuses_required_web_before_dispatch(
    db_session: Session,
    test_user: UserRecord,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing Brave credentials preserve Chat but refuse Web and Idea work."""
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("WORKER_LANE", raising=False)
    monkeypatch.delenv("WORKER_ALLOWED_JOB_KINDS", raising=False)
    monkeypatch.delenv("NEXUS_ALLOW_WORKER_MAINTENANCE", raising=False)
    clear_settings_cache()
    assert get_settings().brave_search_api_key is None

    app, verifier = _keyless_app(db_session, test_user)
    try:
        with TestClient(
            app,
            headers={"Authorization": f"Bearer {verifier.token}"},
        ) as client:
            assert hasattr(app.state, "tool_runtime"), (
                "the keyless app booted without publishing its immutable tool runtime"
            )
            app_runtime = app.state.tool_runtime
            app_chat = app_runtime.operations["chat"]
            assert _tool_ids(app_chat) == _CHAT_TOOL_IDS

            from nexus.tasks.artifacts import compose_dossier_tool_runtime

            task_runtime = compose_dossier_tool_runtime(None)
            task_chat = task_runtime.operations["chat"]
            assert _tool_ids(task_chat) == _CHAT_TOOL_IDS
            assert task_chat.profile.profile_revision == app_chat.profile.profile_revision
            assert task_chat.plan.plan_revision == app_chat.plan.plan_revision

            result, recorder, telemetry, position = _execute_keyless_web(task_chat)
            assert result == {
                "type": "Failure",
                "error": {"type": "ToolUnavailable"},
            }
            assert recorder.record(position).dispatches == 0, (
                "an unavailable Web binding crossed the provider dispatch boundary"
            )
            assert telemetry.events == [("tool.unavailable", {"tool_id": "web.search"})]

            idea = find_or_create_idea_subject(
                db_session,
                user_id=test_user.id,
                idea_key=IdeaKey(
                    version="v1",
                    title_key=canonicalize_idea_text("Keyless research"),
                    disambiguator_key=absent(),
                ),
                display_title="Keyless research",
            )
            artifact = SynthesisArtifact(
                id=uuid4(),
                subject_scheme="idea",
                subject_id=idea.id,
                audience_scheme="user",
                audience_id=str(test_user.id),
            )
            db_session.add(artifact)
            db_session.flush()
            before = _idea_work_counts(db_session, artifact_id=artifact.id)

            response = client.post(
                f"/artifacts/artifact:{artifact.id}/builds",
                headers={"Idempotency-Key": f"keyless-idea-{uuid4()}"},
                json={"instruction": {"kind": "Absent"}},
            )
            assert response.status_code == 503
            assert response.json()["error"]["code"] == ("E_DOSSIER_WEB_RESEARCH_NOT_CONFIGURED")
            assert _idea_work_counts(db_session, artifact_id=artifact.id) == before, (
                "keyless Idea admission created a build or enqueued a worker job"
            )

            previous_limiter = get_rate_limiter()
            monkeypatch.setenv("WORKER_LANE", "interactive")
            clear_settings_cache()
            try:
                worker = create_worker()
                assert worker.allowed_kinds is not None
                assert {"chat_run", "dossier_build"} <= set(worker.allowed_kinds)
            finally:
                set_rate_limiter(previous_limiter)
    finally:
        clear_settings_cache()
