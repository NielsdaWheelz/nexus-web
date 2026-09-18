"""Postgres queue worker entrypoint."""

from __future__ import annotations

import os
import signal
import socket
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, cast
from uuid import UUID

from apps.worker.health import (
    WORKER_HEALTH_PROGRESS_INTERVAL_SECONDS,
    WorkerHeartbeatPublisher,
    WorkerLane,
)
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import (
    BACKGROUND_WORKER_MEMORY_LIMIT_BYTES,
    Environment,
    Settings,
    get_settings,
    parse_agent_tools_mcp_listen,
)
from nexus.db.session import create_session_factory
from nexus.job_topology import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
    MAINTENANCE_JOB_KINDS,
    PRODUCTION_ENABLED_JOB_KINDS,
)
from nexus.jobs.process_executor import (
    BackgroundProcessExecutor,
    BackgroundProcessProtocolDefect,
    ParserTempPruned,
    ValidatedCgroup,
)
from nexus.jobs.registry import get_default_registry, get_task_contract_digest
from nexus.jobs.worker import JobWorker
from nexus.logging import configure_logging, get_logger
from nexus.runtime_health import get_runtime_identity, is_database_ready

logger = get_logger(__name__)

if TYPE_CHECKING:
    import uvicorn

    from nexus.services.agent_tools_mcp import ActiveAgentToolRegistry

_MCP_LISTENER_START_TIMEOUT_SECONDS = 10.0


def _worker_readiness_check(
    *,
    lane: WorkerLane,
    settings: Settings,
    expected_database_revision: str,
    required_listener: threading.Thread | None = None,
) -> bool:
    """Verify the lane-owned runtime contract before publishing progress."""
    if lane == "interactive" and (required_listener is None or not required_listener.is_alive()):
        return False
    if lane == "background":
        try:
            ValidatedCgroup.for_current_process(
                settings.background_process_cgroup_root,
                expected_memory_limit_bytes=BACKGROUND_WORKER_MEMORY_LIMIT_BYTES,
            )
        except BackgroundProcessProtocolDefect:
            return False
    reconciler_max_age_seconds = (
        2 * int(settings.ingest_reconcile_schedule_seconds)
        if settings.nexus_env in (Environment.STAGING, Environment.PROD)
        else None
    )
    return is_database_ready(
        database_url=settings.database_url,
        expected_revision=expected_database_revision,
        reconciler_max_age_seconds=reconciler_max_age_seconds,
    )


def _supervise_required_listener(
    listener: threading.Thread,
    *,
    stop_event: threading.Event,
    shutdown_requested: threading.Event,
) -> None:
    """Stop the worker if its required sibling listener exits unexpectedly."""

    listener.join()
    if not shutdown_requested.is_set():
        stop_event.set()


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def _start_agent_tools_listener(
    *,
    settings: Settings,
    session_factory: sessionmaker[Session],
) -> tuple[uvicorn.Server, threading.Thread, ActiveAgentToolRegistry]:
    """Start the interactive worker's sessionless MCP listener.

    Authorities are registered by the active generation owner; the listener
    itself owns no ORM state and remains usable across worker jobs.
    """
    import uvicorn

    from nexus.services.agent_tools_mcp import (
        ActiveAgentToolRegistry,
        create_agent_tools_mcp_app,
    )
    from nexus.services.codex_generation_client import CodexGenerationClient

    host, port = parse_agent_tools_mcp_listen(settings.agent_tools_mcp_listen)
    registry = ActiveAgentToolRegistry(session_factory=session_factory)
    control = CodexGenerationClient(settings.codex_agent_socket)

    async def policy_violation(generation_id: UUID) -> None:
        await control.policy_violation(generation_id)

    app = create_agent_tools_mcp_app(
        registry=registry,
        signing_key=settings.effective_agent_tool_grant_signing_key,
        on_policy_violation=policy_violation,
        settings=settings,
    )
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=host,
            port=port,
            log_config=None,
            access_log=False,
        )
    )
    thread = threading.Thread(target=server.run, name="agent-tools-mcp", daemon=True)
    thread.start()
    deadline = time.monotonic() + _MCP_LISTENER_START_TIMEOUT_SECONDS
    while not server.started:
        if not thread.is_alive():
            raise RuntimeError("agent-tools MCP listener exited during startup")
        if time.monotonic() >= deadline:
            server.should_exit = True
            thread.join(timeout=1)
            raise RuntimeError("agent-tools MCP listener did not become ready")
        time.sleep(0.01)
    return server, thread, registry


def register_shutdown_signal_handlers(stop_event: threading.Event) -> None:
    """Bind SIGINT/SIGTERM to the worker's one cooperative shutdown signal.

    The worker loop observes this event between jobs and the process executor
    observes it while a child is running, so a redeploy terminates the child,
    releases its claim and Heavy capacity, and exits inside the stop grace period.
    """

    def _handle_signal(signum: int, _frame: object) -> None:
        logger.info("postgres_worker_shutdown_signal", signal=signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)


def create_worker(
    *,
    stop_event: threading.Event | None = None,
    successful_cycle_callback: Callable[[], None] | None = None,
) -> JobWorker:
    # The entrypoint binds SIGINT/SIGTERM to its own event before construction
    # and passes it; a caller that never drives cooperative shutdown (a topology
    # inspection) gets a private event so it need not fabricate one.
    if stop_event is None:
        stop_event = threading.Event()
    settings = get_settings()
    if settings.worker_lane == "interactive":
        # Validate the listener before constructing a worker or accepting jobs;
        # F owns the actual process/server wiring.
        parse_agent_tools_mcp_listen(settings.agent_tools_mcp_listen)
    registry = get_default_registry()
    if settings.worker_lane == "interactive":
        allowed_kinds = INTERACTIVE_WORKER_JOB_KINDS
    elif settings.worker_lane == "background":
        allowed_kinds = BACKGROUND_WORKER_JOB_KINDS
    elif settings.worker_lane == "maintenance":
        allowed_kinds = tuple(
            value.strip()
            for value in (settings.worker_allowed_job_kinds or "").split(",")
            if value.strip()
        )
    else:
        raise RuntimeError(
            "WORKER_LANE must be interactive, background, or an explicitly gated maintenance."
        )

    registered_kinds = set(registry)
    declared_kinds = set(PRODUCTION_ENABLED_JOB_KINDS) | set(MAINTENANCE_JOB_KINDS)
    if registered_kinds != declared_kinds:
        missing = declared_kinds - registered_kinds
        undeclared = registered_kinds - declared_kinds
        raise RuntimeError(
            "Worker topology must cover the registry exactly; "
            f"missing={sorted(missing)}, undeclared={sorted(undeclared)}"
        )

    unknown_kinds = set(allowed_kinds) - registered_kinds
    if unknown_kinds:
        raise RuntimeError(f"Unknown worker job kinds: {', '.join(sorted(unknown_kinds))}")

    session_factory = create_session_factory()
    process_executor: BackgroundProcessExecutor | None = None
    if settings.worker_lane == "background":
        process_executor = BackgroundProcessExecutor(
            cgroup=ValidatedCgroup.for_current_process(
                settings.background_process_cgroup_root,
                expected_memory_limit_bytes=BACKGROUND_WORKER_MEMORY_LIMIT_BYTES,
            ),
            result_max_bytes=settings.background_process_result_max_bytes,
            term_grace_seconds=settings.background_process_term_grace_seconds,
            child_oom_score_adj=settings.background_process_oom_score_adj,
            parser_temp_root=settings.parser_temp_root,
        )
    else:
        # Interactive and explicitly gated maintenance handlers remain in-process.
        from nexus.services.generation_policy import validate_policy
        from nexus.services.rate_limit import RateLimiter, set_rate_limiter

        validate_policy()
        set_rate_limiter(
            RateLimiter(
                session_factory=session_factory,
                rpm_limit=settings.rate_limit_rpm,
            )
        )
    return JobWorker(
        session_factory=session_factory,
        worker_id=_worker_id(),
        registry=registry,
        poll_interval_seconds=settings.worker_poll_interval_seconds,
        idle_backoff_max_seconds=settings.worker_idle_backoff_max_seconds,
        scheduler_interval_seconds=settings.worker_scheduler_interval_seconds,
        heartbeat_interval_seconds=settings.worker_heartbeat_interval_seconds,
        default_lease_seconds=settings.worker_lease_seconds,
        db_failure_backoff_seconds=settings.worker_db_failure_backoff_seconds,
        db_failure_backoff_max_seconds=settings.worker_db_failure_backoff_max_seconds,
        allowed_kinds=tuple(sorted(allowed_kinds)),
        successful_cycle_callback=successful_cycle_callback,
        successful_cycle_interval_seconds=(
            WORKER_HEALTH_PROGRESS_INTERVAL_SECONDS
            if successful_cycle_callback is not None
            else None
        ),
        process_executor=process_executor,
        stop_event=stop_event,
    )


def main() -> None:
    configure_logging()
    stop_event = threading.Event()
    register_shutdown_signal_handlers(stop_event)

    settings = get_settings()
    identity = get_runtime_identity()
    mcp_listener: tuple[uvicorn.Server, threading.Thread, ActiveAgentToolRegistry] | None = None
    mcp_supervisor: threading.Thread | None = None
    mcp_shutdown_requested = threading.Event()
    publisher: WorkerHeartbeatPublisher | None = None
    if settings.worker_lane in ("interactive", "background"):
        lane = cast(WorkerLane, settings.worker_lane)
        allowed_job_kinds = (
            INTERACTIVE_WORKER_JOB_KINDS if lane == "interactive" else BACKGROUND_WORKER_JOB_KINDS
        )
        publisher = WorkerHeartbeatPublisher(
            lane=lane,
            allowed_job_kinds=tuple(sorted(allowed_job_kinds)),
            source_sha=identity.source_sha,
            expected_database_revision=identity.expected_database_revision,
            expected_oracle_manifest_digest=identity.expected_oracle_manifest_digest,
            task_contract_digest=get_task_contract_digest(),
            readiness_check=lambda: _worker_readiness_check(
                lane=lane,
                settings=settings,
                expected_database_revision=identity.expected_database_revision,
                required_listener=mcp_listener[1] if mcp_listener is not None else None,
            ),
        )
        if publisher is not None:
            publisher.clear()

    worker = create_worker(
        stop_event=stop_event,
        successful_cycle_callback=publisher.publish if publisher is not None else None,
    )
    if settings.worker_lane == "interactive":
        mcp_listener = _start_agent_tools_listener(
            settings=settings,
            session_factory=create_session_factory(),
        )
        from nexus.services.agent_tools_mcp import set_active_agent_tool_registry

        set_active_agent_tool_registry(mcp_listener[2])
        mcp_supervisor = threading.Thread(
            target=_supervise_required_listener,
            kwargs={
                "listener": mcp_listener[1],
                "stop_event": stop_event,
                "shutdown_requested": mcp_shutdown_requested,
            },
            name="agent-tools-mcp-supervisor",
            daemon=True,
        )
        mcp_supervisor.start()
    if settings.worker_lane == "background":
        process_executor = worker.process_executor
        if process_executor is None:
            # justify-defect: create_worker always equips the background lane.
            raise AssertionError("background worker has no child process executor")
        prune = process_executor.prune_stale_parser_temp(
            settings.parser_temp_root,
            worker_id=worker.worker_id,
            shutdown=stop_event,
            failure_backoff_seconds=settings.worker_db_failure_backoff_seconds,
            failure_backoff_max_seconds=settings.worker_db_failure_backoff_max_seconds,
        )
        if isinstance(prune, ParserTempPruned):
            logger.info(
                "parser_temp_startup_pruned",
                removed_directories=prune.removed_directories,
            )
        else:
            logger.info("parser_temp_startup_prune_interrupted", worker_id=worker.worker_id)
    logger.info(
        "postgres_worker_started",
        worker_id=worker.worker_id,
        lane=settings.worker_lane,
        source_sha=identity.source_sha,
        task_contract_digest=get_task_contract_digest(),
        allowed_job_kinds=list(worker.allowed_kinds or ()),
    )
    try:
        worker.run_forever()
    finally:
        if mcp_listener is not None:
            mcp_shutdown_requested.set()
            mcp_listener[0].should_exit = True
            mcp_listener[1].join(timeout=10)
            if mcp_listener[1].is_alive():
                raise RuntimeError("agent-tool listener did not stop within its shutdown bound")
            if mcp_supervisor is None:
                raise AssertionError("agent-tool listener has no supervisor")
            mcp_supervisor.join(timeout=1)
            if mcp_supervisor.is_alive():
                raise RuntimeError("agent-tool listener supervisor did not stop")
            from nexus.services.agent_tools_mcp import set_active_agent_tool_registry

            set_active_agent_tool_registry(None)
        if publisher is not None:
            publisher.clear()
        logger.info("postgres_worker_stopped", worker_id=worker.worker_id)


if __name__ == "__main__":
    main()
