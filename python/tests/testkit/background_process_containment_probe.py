"""Executable real-cgroup target for the background containment service proof."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from pathlib import Path

from apps.worker.main import register_shutdown_signal_handlers
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import BACKGROUND_WORKER_MEMORY_LIMIT_BYTES
from nexus.db.engine import get_engine
from nexus.jobs.process_executor import BackgroundProcessExecutor, ValidatedCgroup
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker

PROBE_KIND = "background_source_process_containment_probe"
WORKER_ID = "cgroup-process-containment-supervisor"
MEMORY_LIMIT_BYTES = BACKGROUND_WORKER_MEMORY_LIMIT_BYTES
SUPERVISOR_RESIDENT_KIB_LIMIT = 96 * 1024

# Any of these in the supervisor's module table means a parser, provider, storage,
# or task graph leaked across the process boundary -- through a handler dispatch or
# through the dead-letter transition, which runs in the supervisor by design.
_FORBIDDEN_MODULE_NAMES = frozenset(
    {
        "anthropic",
        "boto3",
        "botocore",
        "httpx",
        "lxml",
        "nexus.services.content_indexing",
        "nexus.services.podcasts.backfill",
        "nexus.services.podcasts.sync",
        "nexus.services.rate_limit",
        "nexus.services.semantic_chunks",
        "nexus.storage.client",
        "openai",
        "provider_runtime",
        "tests.testkit.background_process_probe_handler",
    }
)


def _session_factory() -> sessionmaker[Session]:
    return sessionmaker(
        bind=get_engine(),
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )


def _resident_kib() -> int:
    for line in Path("/proc/self/status").read_text(encoding="ascii").splitlines():
        if line.startswith("VmRSS:"):
            value, unit = line.removeprefix("VmRSS:").split()
            if unit != "kB":
                raise AssertionError("supervisor VmRSS has an unsupported unit")
            return int(value)
    raise AssertionError("supervisor VmRSS is unavailable")


def _forbidden_preloaded_modules() -> list[str]:
    return sorted(
        name
        for name in sys.modules
        if name in _FORBIDDEN_MODULE_NAMES
        or name.startswith("nexus.tasks.")
        or name.startswith(("nexus.services.pdf_", "nexus.services.epub_"))
    )


def _run(
    *,
    supervisor_pid_path: Path,
    supervisor_state_path: Path,
    parser_temp_root: Path,
    wall_timeout_seconds: float,
    exact_jobs: int | None,
) -> int:
    supervisor_pid_path.write_text(str(os.getpid()), encoding="ascii")
    stop_event = threading.Event()
    register_shutdown_signal_handlers(stop_event)
    executor = BackgroundProcessExecutor(
        cgroup=ValidatedCgroup.for_current_process(
            Path("/sys/fs/cgroup"),
            expected_memory_limit_bytes=MEMORY_LIMIT_BYTES,
        ),
        result_max_bytes=64 * 1024,
        term_grace_seconds=0.1,
        child_oom_score_adj=750,
        parser_temp_root=parser_temp_root,
    )
    definition = JobDefinition(
        kind=PROBE_KIND,
        handler_path="tests.testkit.background_process_probe_handler:run_containment_probe",
        resource_class="Heavy",
        wall_timeout_seconds=wall_timeout_seconds,
        resource_failure_projection="SourceAttemptMedia",
        child_exit_cleanup="SourceAttemptParserTemp",
        # Terminal settlement runs the kind's dead-letter projection in this
        # process, so the forbidden-module assertion covers that path too.
        dead_letter_projection="NoteContentIndex",
    )
    worker = JobWorker(
        session_factory=_session_factory(),
        worker_id=WORKER_ID,
        registry={PROBE_KIND: definition},
        allowed_kinds=(PROBE_KIND,),
        heartbeat_interval_seconds=0.1,
        process_executor=executor,
        stop_event=stop_event,
    )
    if exact_jobs is None:
        worker.run_forever()
    else:
        for _expected_job in range(exact_jobs):
            if not worker.run_once():
                raise AssertionError("containment supervisor did not claim its expected probe job")
    supervisor_state_path.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "resident_kib": _resident_kib(),
                "forbidden_preloaded_modules": _forbidden_preloaded_modules(),
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="ascii",
    )
    return 0


def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--supervisor-pid-path", type=Path, required=True)
    parser.add_argument("--supervisor-state-path", type=Path, required=True)
    parser.add_argument("--parser-temp-root", type=Path, required=True)
    parser.add_argument("--wall-timeout-seconds", type=float, required=True)
    lifetime = parser.add_mutually_exclusive_group(required=True)
    lifetime.add_argument("--exact-jobs", type=int)
    lifetime.add_argument("--until-shutdown", action="store_true")
    args = parser.parse_args()
    return _run(
        supervisor_pid_path=args.supervisor_pid_path,
        supervisor_state_path=args.supervisor_state_path,
        parser_temp_root=args.parser_temp_root,
        wall_timeout_seconds=args.wall_timeout_seconds,
        exact_jobs=None if args.until_shutdown else args.exact_jobs,
    )


if __name__ == "__main__":
    raise SystemExit(_main())
