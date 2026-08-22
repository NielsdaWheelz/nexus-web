"""Priority proof: kernel OOM/timeout cannot take down the queue supervisor."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Generator, Sequence
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
    SUPERVISOR_RESIDENT_KIB_LIMIT,
    WORKER_ID,
)
from tests.testkit.unreachable_state import (
    delete_jobs_of_kinds,
    delete_source_probe_owners_by_job_kind,
    release_heavy_capacity_row,
)

_PYTHON_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = _PYTHON_ROOT.parent
# The gated scenarios must outlive the deliberate supervisor kill, so their wall
# limit is far wider than the fast resource-failure scenarios' three seconds.
_RESOURCE_FAILURE_WALL_TIMEOUT_SECONDS = 3.0
_GATED_WALL_TIMEOUT_SECONDS = 60.0
_SUPERVISOR_RUN_TIMEOUT_SECONDS = 45.0
# Parent-death propagation is a pipe EOF plus a kernel signal; a whole second is
# already several orders of magnitude of slack.
_CHILD_DEATH_TIMEOUT_SECONDS = 10.0
# Must exceed the executor TERM grace plus one queue settlement, and stay inside
# the `stop_grace_period: 30s` the deployed service declares.
_SHUTDOWN_TIMEOUT_SECONDS = 20.0
_OBSERVABLE_FILE_TIMEOUT_SECONDS = 30.0


def _supervisor_environment() -> dict[str, str]:
    environment = dict(os.environ)
    prior_pythonpath = environment.get("PYTHONPATH")
    roots = os.pathsep.join((str(_PYTHON_ROOT), str(_REPO_ROOT)))
    environment["PYTHONPATH"] = (
        roots if not prior_pythonpath else f"{roots}{os.pathsep}{prior_pythonpath}"
    )
    user_runtime_directory = Path(f"/run/user/{os.getuid()}")
    user_bus = user_runtime_directory / "bus"
    assert user_bus.exists(), (
        f"cgroup containment proof requires a live user systemd bus at {user_bus}"
    )
    environment["XDG_RUNTIME_DIR"] = str(user_runtime_directory)
    environment["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={user_bus}"
    return environment


def _supervisor_command(
    *,
    supervisor_pid_path: Path,
    supervisor_state_path: Path,
    parser_temp_root: Path,
    wall_timeout_seconds: float,
    lifetime: Sequence[str],
) -> list[str]:
    systemd_run = shutil.which("systemd-run")
    assert systemd_run is not None, "cgroup containment proof requires systemd-run"
    return [
        systemd_run,
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        f"--unit=nexus-containment-{uuid4().hex[:16]}",
        "-p",
        f"MemoryMax={MEMORY_LIMIT_BYTES}",
        "-p",
        "MemorySwapMax=0",
        "-p",
        "OOMPolicy=continue",
        sys.executable,
        "-m",
        "tests.testkit.background_process_containment_probe",
        "--supervisor-pid-path",
        str(supervisor_pid_path),
        "--supervisor-state-path",
        str(supervisor_state_path),
        "--parser-temp-root",
        str(parser_temp_root),
        "--wall-timeout-seconds",
        str(wall_timeout_seconds),
        *lifetime,
    ]


def _read_when_present(path: Path, *, what: str) -> str:
    deadline = time.monotonic() + _OBSERVABLE_FILE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            value = path.read_text(encoding="ascii").strip()
        except OSError:
            value = ""
        if value:
            return value
    raise AssertionError(f"{what} was never observable at {path}")


def _process_is_live(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        status = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except OSError:
        return False
    # An unreaped zombie is a dead process that still answers signal 0.
    return status.rpartition(")")[2].split()[0] != "Z"


def _await_process_exit(pid: int, *, what: str) -> None:
    deadline = time.monotonic() + _CHILD_DEATH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not _process_is_live(pid):
            return
    raise AssertionError(
        f"{what} (pid {pid}) was still alive {_CHILD_DEATH_TIMEOUT_SECONDS}s after its "
        "supervisor died; the child is not bound to supervisor liveness"
    )


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
    gate_path: Path | None = None,
    marker_path: Path | None = None,
    note_block_id: UUID | None = None,
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
    if gate_path is not None:
        payload["gate_path"] = str(gate_path)
    if marker_path is not None:
        payload["marker_path"] = str(marker_path)
    if note_block_id is not None:
        payload["note_block_id"] = str(note_block_id)
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
    supervisor_pid_path = tmp_path / "supervisor.pid"
    supervisor_state_path = tmp_path / "supervisor.json"
    # The kind under proof declares a dead-letter projection, so terminal settlement
    # runs it inside the supervisor. A real repair here proves the supervisor can
    # execute one without loading the note/index service graph.
    dead_letter_note_block_id = uuid4()
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
            note_block_id=dead_letter_note_block_id,
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

    completed = subprocess.run(
        _supervisor_command(
            supervisor_pid_path=supervisor_pid_path,
            supervisor_state_path=supervisor_state_path,
            parser_temp_root=parser_temp_root,
            wall_timeout_seconds=_RESOURCE_FAILURE_WALL_TIMEOUT_SECONDS,
            lifetime=("--exact-jobs", "8"),
        ),
        cwd=_PYTHON_ROOT,
        env=_supervisor_environment(),
        capture_output=True,
        text=True,
        timeout=_SUPERVISOR_RUN_TIMEOUT_SECONDS,
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
    assert int(supervisor_state["resident_kib"]) <= SUPERVISOR_RESIDENT_KIB_LIMIT
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
        dead_letter_index = oracle.execute(
            text(
                """
                SELECT status, status_reason
                FROM content_index_states
                WHERE owner_kind = 'note_block' AND owner_id = :owner_id
                """
            ),
            {"owner_id": dead_letter_note_block_id},
        ).one_or_none()

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
    assert dead_letter_index is not None, (
        "the supervisor did not apply the kind's dead-letter projection inside its "
        "terminal transition"
    )
    assert dead_letter_index[0] == "failed"
    assert str(dead_letter_index[1]).startswith("E_INTERNAL: ")


def _seed_gated_probe(
    engine: Engine,
    *,
    tmp_path: Path,
    parser_temp_root: Path,
) -> tuple[UUID, UUID, UUID, Path, Path, Path]:
    """Publish one probe job whose child blocks on a gate file until released."""
    viewer_id = uuid4()
    pid_path = tmp_path / "gated-child.pid"
    gate_path = tmp_path / "gate"
    marker_path = tmp_path / "gate-released"
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"containment-{viewer_id}@example.invalid",
        )
        job_id, attempt_id, media_id = _enqueue_source_probe(
            db,
            viewer_id=viewer_id,
            mode="Gate",
            priority=0,
            pid_path=pid_path,
            parser_temp_root=parser_temp_root,
            gate_path=gate_path,
            marker_path=marker_path,
        )
        db.commit()
    return job_id, attempt_id, media_id, pid_path, gate_path, marker_path


def _forget_containment_probe_rows(engine: Engine) -> None:
    with Session(engine) as db:
        release_heavy_capacity_row(db)
        delete_source_probe_owners_by_job_kind(db, kind=PROBE_KIND)
        delete_jobs_of_kinds(db, kinds=(PROBE_KIND,))
        db.commit()


def test_supervisor_death_kills_its_gated_child_before_any_stale_write(
    engine: Engine,
    tmp_path: Path,
) -> None:
    """Risk: a SIGKILLed supervisor must not leave an orphan holding a live claim."""
    parser_temp_root = tmp_path / "parser-temp"
    parser_temp_root.mkdir()
    supervisor_pid_path = tmp_path / "supervisor.pid"
    supervisor_state_path = tmp_path / "supervisor.json"
    job_id, attempt_id, media_id, pid_path, gate_path, marker_path = _seed_gated_probe(
        engine,
        tmp_path=tmp_path,
        parser_temp_root=parser_temp_root,
    )

    supervisor = subprocess.Popen(
        _supervisor_command(
            supervisor_pid_path=supervisor_pid_path,
            supervisor_state_path=supervisor_state_path,
            parser_temp_root=parser_temp_root,
            wall_timeout_seconds=_GATED_WALL_TIMEOUT_SECONDS,
            lifetime=("--exact-jobs", "1"),
        ),
        cwd=_PYTHON_ROOT,
        env=_supervisor_environment(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        supervisor_pid = int(_read_when_present(supervisor_pid_path, what="supervisor pid"))
        child_pid = int(_read_when_present(pid_path, what="gated child pid"))
        os.kill(supervisor_pid, signal.SIGKILL)

        _await_process_exit(child_pid, what="the gated child")
        gate_path.write_text("open", encoding="ascii")
        assert not marker_path.exists(), (
            "a child whose supervisor is dead still committed its gated write"
        )
        _await_process_exit(supervisor_pid, what="the SIGKILLed supervisor")
        assert not supervisor_state_path.exists(), (
            "the supervisor finished its run instead of dying mid-child"
        )

        with Session(engine) as oracle:
            job = oracle.execute(
                text(
                    """
                    SELECT status, attempts, claimed_by, error_code, result
                    FROM background_jobs
                    WHERE id = :job_id
                    """
                ),
                {"job_id": job_id},
            ).one()
            attempt_status = oracle.scalar(
                text("SELECT status FROM media_source_attempts WHERE id = :attempt_id"),
                {"attempt_id": attempt_id},
            )
            media_status = oracle.scalar(
                text("SELECT processing_status FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            )
        assert tuple(job) == ("running", 1, WORKER_ID, None, None), (
            f"the orphaned child mutated its own queue row: {tuple(job)!r}"
        )
        assert attempt_status == "running"
        assert media_status == ProcessingStatus.extracting.value
    finally:
        supervisor.kill()
        supervisor.wait(timeout=_SHUTDOWN_TIMEOUT_SECONDS)
        _forget_containment_probe_rows(engine)


def test_supervisor_sigterm_returns_its_gated_job_without_burning_an_attempt(
    engine: Engine,
    tmp_path: Path,
) -> None:
    """Risk: a redeploy mid-Heavy-job must release the claim, not hard-kill it."""
    parser_temp_root = tmp_path / "parser-temp"
    parser_temp_root.mkdir()
    supervisor_pid_path = tmp_path / "supervisor.pid"
    supervisor_state_path = tmp_path / "supervisor.json"
    job_id, attempt_id, media_id, pid_path, gate_path, marker_path = _seed_gated_probe(
        engine,
        tmp_path=tmp_path,
        parser_temp_root=parser_temp_root,
    )

    supervisor = subprocess.Popen(
        _supervisor_command(
            supervisor_pid_path=supervisor_pid_path,
            supervisor_state_path=supervisor_state_path,
            parser_temp_root=parser_temp_root,
            wall_timeout_seconds=_GATED_WALL_TIMEOUT_SECONDS,
            lifetime=("--until-shutdown",),
        ),
        cwd=_PYTHON_ROOT,
        env=_supervisor_environment(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        supervisor_pid = int(_read_when_present(supervisor_pid_path, what="supervisor pid"))
        child_pid = int(_read_when_present(pid_path, what="gated child pid"))
        os.kill(supervisor_pid, signal.SIGTERM)

        assert supervisor.wait(timeout=_SHUTDOWN_TIMEOUT_SECONDS) == 0, (
            "the supervisor did not exit cleanly inside its stop grace period"
        )
        _await_process_exit(child_pid, what="the gated child")
        gate_path.write_text("open", encoding="ascii")
        assert not marker_path.exists(), (
            "a terminated child still committed its gated write after shutdown"
        )
        assert supervisor_state_path.exists(), (
            "the supervisor exited before completing its own shutdown path"
        )

        with Session(engine) as oracle:
            job = oracle.execute(
                text(
                    """
                    SELECT status, attempts, claimed_by, lease_expires_at,
                           error_code, last_error, result
                    FROM background_jobs
                    WHERE id = :job_id
                    """
                ),
                {"job_id": job_id},
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
            attempt_status = oracle.scalar(
                text("SELECT status FROM media_source_attempts WHERE id = :attempt_id"),
                {"attempt_id": attempt_id},
            )
            media_status = oracle.scalar(
                text("SELECT processing_status FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            )
        assert tuple(job) == ("pending", 0, None, None, None, None, None), (
            "a shutdown-interrupted job must return to pending with its retry budget "
            f"intact; observed {tuple(job)!r}"
        )
        assert tuple(capacity) == (None, None, None, None), (
            f"shutdown did not release the Heavy capacity lease: {tuple(capacity)!r}"
        )
        assert attempt_status == "running"
        assert media_status == ProcessingStatus.extracting.value
    finally:
        supervisor.kill()
        supervisor.wait(timeout=_SHUTDOWN_TIMEOUT_SECONDS)
        _forget_containment_probe_rows(engine)
