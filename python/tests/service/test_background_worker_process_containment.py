"""Priority proof: kernel OOM/timeout cannot take down the queue supervisor."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Generator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.jobs.queue import complete_job, enqueue_job
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.ingest_recovery import get_ingest_recovery_health
from tests.testkit.background_process_containment_probe import (
    MEMORY_LIMIT_BYTES,
    PROBE_KIND,
    WORKER_ID,
)
from tests.testkit.unreachable_state import (
    delete_jobs_of_kinds,
    delete_source_probe_owners_by_job_kind,
    release_heavy_capacity_row,
)

_PYTHON_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module", autouse=True)
def clean_containment_jobs(engine: Engine) -> Generator[None, None, None]:
    try:
        yield
    finally:
        with Session(engine) as db:
            release_heavy_capacity_row(db)
            delete_source_probe_owners_by_job_kind(db, kind=PROBE_KIND)
            delete_jobs_of_kinds(db, kinds=(PROBE_KIND,))
            db.commit()


def _enqueue_source_probe(
    db: Session,
    *,
    viewer_id: UUID,
    mode: str,
    priority: int,
    pid_path: Path | None,
    parser_temp_root: Path,
    descendant_pid_path: Path | None = None,
    published_path: Path | None = None,
) -> tuple[UUID, UUID, UUID]:
    media_id = uuid4()
    attempt_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.pdf.value,
            title=f"{mode} containment probe",
            processing_status=ProcessingStatus.extracting,
            created_by_user_id=viewer_id,
        )
    )
    attempt = MediaSourceAttempt(
        id=attempt_id,
        media_id=media_id,
        created_by_user_id=viewer_id,
        source_type="uploaded_pdf_file",
        attempt_no=1,
        run_count=1,
        status="running",
        intent_key=f"containment:{attempt_id}",
        processing_stage="Extract",
    )
    db.add(attempt)
    payload: dict[str, object] = {
        "mode": mode,
        "media_id": str(media_id),
        "attempt_id": str(attempt_id),
        "parser_temp_root": str(parser_temp_root),
    }
    if pid_path is not None:
        payload["pid_path"] = str(pid_path)
    if descendant_pid_path is not None:
        payload["descendant_pid_path"] = str(descendant_pid_path)
    if published_path is not None:
        payload["published_path"] = str(published_path)
    job = enqueue_job(
        db,
        kind=PROBE_KIND,
        payload=payload,
        priority=priority,
        max_attempts=3,
    )
    attempt.job_id = job.id
    db.flush()
    return job.id, attempt_id, media_id


def _assert_process_absent(pid_path: Path) -> int:
    pid = int(pid_path.read_text(encoding="ascii"))
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    return pid


def test_kernel_oom_and_timeout_are_terminally_fenced_before_next_fresh_child(
    engine: Engine,
    tmp_path: Path,
) -> None:
    """Risk: one hostile document must not kill, retry, or outlive its supervisor."""
    viewer_id = uuid4()
    timeout_pid_path = tmp_path / "timed-out-child.pid"
    timeout_descendant_pid_path = tmp_path / "timed-out-descendant.pid"
    memory_pid_path = tmp_path / "oom-child.pid"
    published_timeout_pid_path = tmp_path / "published-timed-out-child.pid"
    published_memory_pid_path = tmp_path / "published-oom-child.pid"
    published_exit_pid_path = tmp_path / "published-exited-child.pid"
    published_timeout_path = tmp_path / "published-before-timeout"
    published_memory_path = tmp_path / "published-before-oom"
    published_exit_path = tmp_path / "published-before-exit"
    parser_temp_root = tmp_path / "parser-temp"
    parser_temp_root.mkdir()
    unrelated_parser_owner = parser_temp_root / str(uuid4())
    unrelated_parser_owner.mkdir()
    (unrelated_parser_owner / "keep").write_text("unrelated", encoding="ascii")
    supervisor_state_path = tmp_path / "supervisor.json"
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"containment-{viewer_id}@example.invalid",
        )
        timeout_job_id, timeout_attempt_id, timeout_media_id = _enqueue_source_probe(
            db,
            viewer_id=viewer_id,
            mode="Timeout",
            priority=0,
            pid_path=timeout_pid_path,
            parser_temp_root=parser_temp_root,
            descendant_pid_path=timeout_descendant_pid_path,
        )
        memory_job_id, memory_attempt_id, memory_media_id = _enqueue_source_probe(
            db,
            viewer_id=viewer_id,
            mode="Memory",
            priority=1,
            pid_path=memory_pid_path,
            parser_temp_root=parser_temp_root,
        )
        structure_job_id, structure_attempt_id, structure_media_id = _enqueue_source_probe(
            db,
            viewer_id=viewer_id,
            mode="ModeledStructure",
            priority=2,
            pid_path=None,
            parser_temp_root=parser_temp_root,
        )
        output_job_id, output_attempt_id, output_media_id = _enqueue_source_probe(
            db,
            viewer_id=viewer_id,
            mode="ModeledOutput",
            priority=3,
            pid_path=None,
            parser_temp_root=parser_temp_root,
        )
        published_timeout_job_id, published_timeout_attempt_id, published_timeout_media_id = (
            _enqueue_source_probe(
                db,
                viewer_id=viewer_id,
                mode="PublishThenTimeout",
                priority=4,
                pid_path=published_timeout_pid_path,
                parser_temp_root=parser_temp_root,
                published_path=published_timeout_path,
            )
        )
        published_memory_job_id, published_memory_attempt_id, published_memory_media_id = (
            _enqueue_source_probe(
                db,
                viewer_id=viewer_id,
                mode="PublishThenMemory",
                priority=5,
                pid_path=published_memory_pid_path,
                parser_temp_root=parser_temp_root,
                published_path=published_memory_path,
            )
        )
        published_exit_job_id, published_exit_attempt_id, published_exit_media_id = (
            _enqueue_source_probe(
                db,
                viewer_id=viewer_id,
                mode="PublishThenExit",
                priority=6,
                pid_path=published_exit_pid_path,
                parser_temp_root=parser_temp_root,
                published_path=published_exit_path,
            )
        )
        success_job_id, _success_attempt_id, _success_media_id = _enqueue_source_probe(
            db,
            viewer_id=viewer_id,
            mode="Succeed",
            priority=7,
            pid_path=None,
            parser_temp_root=parser_temp_root,
        )
        db.commit()

    systemd_run = shutil.which("systemd-run")
    assert systemd_run is not None, "cgroup containment proof requires systemd-run"
    unit = f"nexus-containment-{uuid4().hex[:16]}"
    environment = dict(os.environ)
    prior_pythonpath = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = (
        str(_PYTHON_ROOT)
        if not prior_pythonpath
        else f"{_PYTHON_ROOT}{os.pathsep}{prior_pythonpath}"
    )
    user_runtime_directory = Path(f"/run/user/{os.getuid()}")
    user_bus = user_runtime_directory / "bus"
    assert user_bus.exists(), (
        f"cgroup containment proof requires a live user systemd bus at {user_bus}"
    )
    environment["XDG_RUNTIME_DIR"] = str(user_runtime_directory)
    environment["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={user_bus}"
    completed = subprocess.run(
        [
            systemd_run,
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            f"--unit={unit}",
            "-p",
            f"MemoryMax={MEMORY_LIMIT_BYTES}",
            "-p",
            "MemorySwapMax=0",
            "-p",
            "OOMPolicy=continue",
            sys.executable,
            "-m",
            "tests.testkit.background_process_containment_probe",
            "--supervisor-state-path",
            str(supervisor_state_path),
            "--parser-temp-root",
            str(parser_temp_root),
            "--expected-jobs",
            "8",
        ],
        cwd=_PYTHON_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    assert completed.returncode == 0, (
        "cgroup-capable containment supervisor failed; "
        f"stdout={completed.stdout[-2000:]!r}, stderr={completed.stderr[-2000:]!r}"
    )

    supervisor_state = json.loads(supervisor_state_path.read_text(encoding="ascii"))
    supervisor_pid = int(supervisor_state["pid"])
    with pytest.raises(ProcessLookupError):
        os.kill(supervisor_pid, 0)
    assert int(supervisor_state["resident_kib"]) <= 96 * 1024
    assert supervisor_state["forbidden_preloaded_modules"] == []
    timeout_pid = _assert_process_absent(timeout_pid_path)
    timeout_descendant_pid = _assert_process_absent(timeout_descendant_pid_path)
    memory_pid = _assert_process_absent(memory_pid_path)
    published_timeout_pid = _assert_process_absent(published_timeout_pid_path)
    published_memory_pid = _assert_process_absent(published_memory_pid_path)
    published_exit_pid = _assert_process_absent(published_exit_pid_path)
    assert published_timeout_path.read_text(encoding="ascii") == "published"
    assert published_memory_path.read_text(encoding="ascii") == "published"
    assert published_exit_path.read_text(encoding="ascii") == "published"
    for attempt_id in (
        timeout_attempt_id,
        memory_attempt_id,
        structure_attempt_id,
        output_attempt_id,
        published_timeout_attempt_id,
        published_memory_attempt_id,
        published_exit_attempt_id,
        _success_attempt_id,
    ):
        assert not (parser_temp_root / str(attempt_id)).exists()
    assert (unrelated_parser_owner / "keep").read_text(encoding="ascii") == "unrelated"

    with Session(engine) as oracle:
        failures = oracle.execute(
            text(
                """
                SELECT j.id, j.status, j.attempts, j.claimed_by, j.lease_expires_at,
                       j.error_code, j.result,
                       a.status, a.error_code, a.finished_at,
                       m.processing_status, m.failure_stage, m.last_error_code, m.failed_at
                FROM background_jobs AS j
                JOIN media_source_attempts AS a ON a.job_id = j.id
                JOIN media AS m ON m.id = a.media_id
                WHERE j.id IN (
                    :timeout_job_id,
                    :memory_job_id,
                    :structure_job_id,
                    :output_job_id
                )
                ORDER BY j.priority ASC
                """
            ),
            {
                "timeout_job_id": timeout_job_id,
                "memory_job_id": memory_job_id,
                "structure_job_id": structure_job_id,
                "output_job_id": output_job_id,
            },
        ).all()
        published_successes = oracle.execute(
            text(
                """
                SELECT j.id, j.status, j.attempts, j.claimed_by, j.lease_expires_at,
                       j.error_code, j.result,
                       a.status, a.error_code, a.finished_at,
                       m.processing_status, m.last_error_code,
                       (SELECT count(*) FROM fragments f WHERE f.media_id = m.id),
                       (SELECT status FROM content_index_states cis
                        WHERE cis.owner_kind = 'media' AND cis.owner_id = m.id),
                       (SELECT revision FROM content_index_states cis
                        WHERE cis.owner_kind = 'media' AND cis.owner_id = m.id)
                FROM background_jobs AS j
                JOIN media_source_attempts AS a ON a.job_id = j.id
                JOIN media AS m ON m.id = a.media_id
                WHERE j.id IN (:timeout_job_id, :memory_job_id, :exit_job_id)
                ORDER BY j.priority ASC
                """
            ),
            {
                "timeout_job_id": published_timeout_job_id,
                "memory_job_id": published_memory_job_id,
                "exit_job_id": published_exit_job_id,
            },
        ).all()
        success = oracle.execute(
            text(
                """
                SELECT status, attempts, claimed_by, lease_expires_at, result
                FROM background_jobs
                WHERE id = :job_id
                """
            ),
            {"job_id": success_job_id},
        ).one()
        capacity = oracle.execute(
            text(
                """
                SELECT job_id, worker_id, attempt_no, lease_expires_at
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                """
            )
        ).one()
        stale_timeout_completion = complete_job(
            oracle,
            job_id=timeout_job_id,
            worker_id=WORKER_ID,
            result_payload={"kind": "StalePublish"},
        )
        stale_memory_completion = complete_job(
            oracle,
            job_id=memory_job_id,
            worker_id=WORKER_ID,
            result_payload={"kind": "StalePublish"},
        )
        stale_exit_completion = complete_job(
            oracle,
            job_id=published_exit_job_id,
            worker_id=WORKER_ID,
            result_payload={"kind": "StalePublish"},
        )
        recovery_health = get_ingest_recovery_health(oracle)

    assert len(failures) == 4
    for row, dimension, job_id, attempt_id, media_id in (
        (failures[0], "Time", timeout_job_id, timeout_attempt_id, timeout_media_id),
        (failures[1], "Memory", memory_job_id, memory_attempt_id, memory_media_id),
        (failures[2], "Structure", structure_job_id, structure_attempt_id, structure_media_id),
        (failures[3], "Output", output_job_id, output_attempt_id, output_media_id),
    ):
        assert row[0] == job_id
        assert row[1] == "dead", (
            f"resource failure did not settle terminally: row={tuple(row)!r}; "
            f"supervisor stderr={completed.stderr[-2000:]!r}"
        )
        assert row[2] == 1
        assert row[3] is None and row[4] is None
        assert row[5] == "E_RESOURCE_LIMIT"
        assert row[6] == {"kind": "ResourceFailure", "dimension": dimension}, (
            "resource-limited source settlement lost its exact dimension"
        )
        assert row[7] == "failed"
        assert row[8] == "E_RESOURCE_LIMIT"
        assert row[9] is not None
        assert row[10] == "failed"
        assert row[11] == "extract"
        assert row[12] == "E_RESOURCE_LIMIT"
        assert row[13] is not None
        assert attempt_id is not None and media_id is not None

    assert len(published_successes) == 3
    for row, job_id, attempt_id, media_id, child_exit in (
        (
            published_successes[0],
            published_timeout_job_id,
            published_timeout_attempt_id,
            published_timeout_media_id,
            {"kind": "ResourceFailure", "dimension": "Time"},
        ),
        (
            published_successes[1],
            published_memory_job_id,
            published_memory_attempt_id,
            published_memory_media_id,
            {"kind": "ResourceFailure", "dimension": "Memory"},
        ),
        (
            published_successes[2],
            published_exit_job_id,
            published_exit_attempt_id,
            published_exit_media_id,
            None,
        ),
    ):
        assert row[0] == job_id
        assert row[1] == "succeeded"
        assert row[2] == 1
        assert row[3] is None and row[4] is None
        assert row[5] is None
        expected_result: dict[str, object] = {"kind": "SourceProjectionSucceeded"}
        if child_exit is not None:
            expected_result["child_exit"] = child_exit
        assert row[6] == expected_result
        assert row[7] == "succeeded"
        assert row[8] is None and row[9] is not None
        assert row[10] == "ready_for_reading" and row[11] is None
        assert row[12] == 1
        assert row[13] == "pending" and row[14] == 1
        assert attempt_id is not None and media_id is not None

    assert success.status == "succeeded"
    assert success.attempts == 1
    assert success.claimed_by is None and success.lease_expires_at is None
    success_child_pid = int(success.result["child_pid"])
    assert success.result["kind"] == "ProbeSucceeded"
    assert (
        len(
            {
                supervisor_pid,
                timeout_pid,
                timeout_descendant_pid,
                memory_pid,
                published_timeout_pid,
                published_memory_pid,
                published_exit_pid,
                success_child_pid,
            }
        )
        == 8
    )
    assert tuple(capacity) == (None, None, None, None)
    assert stale_timeout_completion is False
    assert stale_memory_completion is False
    assert stale_exit_completion is False
    assert recovery_health["resource_limited_source_job_count"] == 6
