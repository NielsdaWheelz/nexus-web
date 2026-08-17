"""Executable real-cgroup target for the background containment service proof."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from sqlalchemy.orm import Session, sessionmaker

from nexus.db.engine import get_engine
from nexus.jobs.process_executor import BackgroundProcessExecutor, ValidatedCgroup
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker

PROBE_KIND = "background_source_process_containment_probe"
WORKER_ID = "cgroup-process-containment-supervisor"
MEMORY_LIMIT_BYTES = 448 * 1024 * 1024


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


def _run(supervisor_state_path: Path, parser_temp_root: Path, expected_jobs: int) -> int:
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
        wall_timeout_seconds=3,
        resource_failure_projection="SourceAttemptMedia",
        child_exit_cleanup="SourceAttemptParserTemp",
    )
    worker = JobWorker(
        session_factory=_session_factory(),
        worker_id=WORKER_ID,
        registry={PROBE_KIND: definition},
        allowed_kinds=(PROBE_KIND,),
        heartbeat_interval_seconds=0.1,
        process_executor=executor,
    )
    for _expected_job in range(expected_jobs):
        if not worker.run_once():
            raise AssertionError("containment supervisor did not claim its expected probe job")
    forbidden_preloaded_modules = sorted(
        name
        for name in sys.modules
        if name == "tests.testkit.background_process_probe_handler"
        or name.startswith("nexus.tasks.")
        or name.startswith(("nexus.services.pdf_", "nexus.services.epub_"))
        or name
        in {
            "anthropic",
            "boto3",
            "botocore",
            "nexus.services.llm_profiles",
            "nexus.services.rate_limit",
            "nexus.storage.client",
            "openai",
            "provider_runtime",
        }
    )
    supervisor_state_path.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "resident_kib": _resident_kib(),
                "forbidden_preloaded_modules": forbidden_preloaded_modules,
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="ascii",
    )
    return 0


def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--supervisor-state-path", type=Path, required=True)
    parser.add_argument("--parser-temp-root", type=Path, required=True)
    parser.add_argument("--expected-jobs", type=int, required=True)
    args = parser.parse_args()
    return _run(args.supervisor_state_path, args.parser_temp_root, args.expected_jobs)


if __name__ == "__main__":
    raise SystemExit(_main())
