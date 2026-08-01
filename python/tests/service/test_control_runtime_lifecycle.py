from __future__ import annotations

import json
import os
import secrets
import select
import signal
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import httpx
import pytest
from botocore.exceptions import ClientError
from psycopg import sql

from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    claim_run,
    cleanup_candidates,
    record_created,
    record_planned,
    resource_ledger_path,
    run_bucket_name,
    run_database_name,
    run_lifecycle_lock,
    template_build_database_name,
    template_database_name,
    template_lifecycle_lock,
)
from nexus_test_control.services import (
    _create_database,
    _create_database_raw,
    _drop_database,
    _ensure_template_locked,
    _postgres_admin,
    _s3,
    clean_run,
    ensure_services,
    new_run_id,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
TEST_ENV = {"NEXUS_ENV": "test"}

_INTERRUPTED_RUN = """
import json
import os
import signal
import sys
from pathlib import Path

from nexus_test_control.runtime import EndpointKind
from nexus_test_control.services import (
    create_supabase_user,
    prepare_run,
    start_python_process,
    wait_process_ready,
)

root = Path(sys.argv[1])
run_id = sys.argv[2]
mode = sys.argv[3]
ready_fd = int(sys.argv[4])
environment = {"NEXUS_ENV": "test"}
run = prepare_run(root, environment, run_id=run_id)
payload = {"run_id": run_id, "api_pid": None, "user_id": None, "user_email": None}
if mode == "journey":
    user = create_supabase_user(
        root,
        environment,
        run_id,
        "interrupted-journey",
        run.supabase,
    )
    api = start_python_process(root, environment, run, "api")
    wait_process_ready(root, environment, api, EndpointKind.API, "/health")
    payload.update(api_pid=api.process_group_id, user_id=user.id, user_email=user.email)
os.write(ready_fd, json.dumps(payload, sort_keys=True).encode())
os.close(ready_fd)
signal.pause()
"""


def _spawn_interrupted(
    run_id: str,
    mode: str,
    ready_fd: int,
    log_path: Path,
) -> subprocess.Popen[bytes]:
    child_environment = {**os.environ, "NEXUS_ENV": "test"}
    with log_path.open("wb") as log:
        return subprocess.Popen(
            (
                sys.executable,
                "-c",
                _INTERRUPTED_RUN,
                str(REPO_ROOT),
                run_id,
                mode,
                str(ready_fd),
            ),
            cwd=REPO_ROOT,
            env=child_environment,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            pass_fds=(ready_fd,),
            start_new_session=True,
        )


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)


def _database_state(name: str) -> tuple[bool, bool] | None:
    with _postgres_admin(REPO_ROOT, TEST_ENV) as connection:
        row = connection.execute(
            "SELECT datallowconn, datistemplate FROM pg_database WHERE datname = %s",
            (name,),
        ).fetchone()
    return row


def _drop_finalized_template(name: str) -> None:
    if _database_state(name) is None:
        return
    with _postgres_admin(REPO_ROOT, TEST_ENV) as connection:
        connection.execute(
            sql.SQL("ALTER DATABASE {} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true").format(
                sql.Identifier(name)
            )
        )
    _drop_database(REPO_ROOT, TEST_ENV, name)


def _bucket_exists(name: str) -> bool:
    try:
        _s3(REPO_ROOT, TEST_ENV).head_bucket(Bucket=name)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"404", "NoSuchBucket"}:
            return False
        raise
    return True


def _user_exists(user_id: str, admin_key: str) -> bool:
    credentials = ensure_services(REPO_ROOT, TEST_ENV)
    response = httpx.get(
        f"{credentials.url}/auth/v1/admin/users/{user_id}",
        headers={"Authorization": f"Bearer {admin_key}", "apikey": admin_key},
        timeout=5,
        trust_env=False,
    )
    if response.status_code == 404:
        return False
    response.raise_for_status()
    return True


def _process_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    return True


def _clean_if_owned(run_id: str) -> None:
    if resource_ledger_path(REPO_ROOT, run_id).is_file():
        clean_run(REPO_ROOT, TEST_ENV, run_id)


def _prepare_template_run(
    run_id: str,
    fingerprint: str,
    gate: threading.Barrier,
) -> None:
    claim_run(REPO_ROOT, TEST_ENV, run_id)
    try:
        gate.wait(timeout=30)
        with run_lifecycle_lock(REPO_ROOT, TEST_ENV, run_id):
            with template_lifecycle_lock(REPO_ROOT, TEST_ENV, fingerprint):
                _ensure_template_locked(REPO_ROOT, TEST_ENV, run_id, fingerprint)
                _create_database(
                    REPO_ROOT,
                    TEST_ENV,
                    run_id,
                    Resource(ResourceKind.RUN_DATABASE, run_database_name(run_id)),
                    template_database_name(fingerprint),
                )
    except BaseException:
        clean_run(REPO_ROOT, TEST_ENV, run_id)
        raise


def _clean_incomplete_template(
    run_id: str,
    started: threading.Event,
    done: threading.Event,
) -> None:
    candidates = cleanup_candidates(REPO_ROOT, TEST_ENV, run_id)
    assert [item.resource.kind for item in candidates] == [ResourceKind.TEMPLATE_BUILD]
    started.set()
    try:
        clean_run(REPO_ROOT, TEST_ENV, run_id)
    finally:
        done.set()


def _outer_sentinel() -> tuple[str, str]:
    database_url = os.environ.get("DATABASE_URL")
    bucket = os.environ.get("R2_BUCKET")
    assert database_url and bucket, "service proof requires its controller-owned outer run"
    database = urlparse(database_url).path.removeprefix("/")
    assert database and _database_state(database) == (True, False)
    assert _bucket_exists(bucket)
    return database, bucket


@pytest.mark.parametrize("mode", ("database", "journey"))
def test_interrupted_database_and_journey_runs_clean_only_their_real_resources(
    tmp_path: Path,
    mode: str,
) -> None:
    outer_database, outer_bucket = _outer_sentinel()
    credentials = ensure_services(REPO_ROOT, TEST_ENV)
    run_id = new_run_id()
    ready_read, ready_write = os.pipe()
    log_path = tmp_path / f"{mode}.log"
    process = _spawn_interrupted(run_id, mode, ready_write, log_path)
    os.close(ready_write)
    payload: dict[str, object] = {}
    try:
        readable, _, _ = select.select((ready_read,), (), (), 180)
        assert readable, f"interrupted {mode} controller did not publish ownership"
        raw = os.read(ready_read, 65536)
        assert raw, log_path.read_text(encoding="utf-8", errors="replace")
        payload = json.loads(raw)
        assert _database_state(run_database_name(run_id)) == (True, False)
        assert _bucket_exists(run_bucket_name(run_id))
        api_pid = payload.get("api_pid")
        user_id = payload.get("user_id")
        if mode == "journey":
            assert isinstance(api_pid, int) and _process_exists(api_pid)
            assert isinstance(user_id, str) and _user_exists(user_id, credentials.admin_key)

        os.killpg(process.pid, signal.SIGTERM)
        assert process.wait(timeout=10) == -signal.SIGTERM
        if isinstance(api_pid, int):
            assert _process_exists(api_pid)

        clean_run(REPO_ROOT, TEST_ENV, run_id, supabase=credentials)

        assert _database_state(run_database_name(run_id)) is None
        assert not _bucket_exists(run_bucket_name(run_id))
        if isinstance(api_pid, int):
            assert not _process_exists(api_pid)
        if isinstance(user_id, str):
            assert not _user_exists(user_id, credentials.admin_key)
        assert not resource_ledger_path(REPO_ROOT, run_id).exists()
        assert _database_state(outer_database) == (True, False)
        assert _bucket_exists(outer_bucket)
    finally:
        os.close(ready_read)
        _terminate(process)
        _clean_if_owned(run_id)


def test_template_build_clone_and_incomplete_drop_serialize_on_real_postgres() -> None:
    _outer_sentinel()
    ensure_services(REPO_ROOT, TEST_ENV)
    fingerprint = secrets.token_hex(20)
    template = template_database_name(fingerprint)
    prepare_ids = (new_run_id(), new_run_id())
    drop_id = new_run_id()
    try:
        gate = threading.Barrier(3)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = tuple(
                pool.submit(_prepare_template_run, run_id, fingerprint, gate)
                for run_id in prepare_ids
            )
            gate.wait(timeout=30)
            for future in futures:
                future.result(timeout=180)

        assert _database_state(template) == (False, True)
        for run_id in prepare_ids:
            assert _database_state(run_database_name(run_id)) == (True, False)
            assert _database_state(template_build_database_name(run_id)) is None
            _clean_if_owned(run_id)

        claim_run(REPO_ROOT, TEST_ENV, drop_id)
        build = template_build_database_name(drop_id)
        resource = Resource(ResourceKind.TEMPLATE_BUILD, build)
        record_planned(
            REPO_ROOT,
            TEST_ENV,
            drop_id,
            resource,
            external_id=fingerprint,
        )
        _create_database_raw(REPO_ROOT, TEST_ENV, build, "template0")
        record_created(REPO_ROOT, TEST_ENV, drop_id, resource)
        started = threading.Event()
        done = threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with template_lifecycle_lock(REPO_ROOT, TEST_ENV, fingerprint):
                cleaner = pool.submit(_clean_incomplete_template, drop_id, started, done)
                assert started.wait(timeout=10)
                assert not done.wait(timeout=0.5), (
                    "incomplete-template cleanup bypassed its lifecycle lock"
                )
                assert _database_state(build) == (True, False)
            cleaner.result(timeout=30)

        assert _database_state(build) is None
        assert _database_state(template) == (False, True)
        assert not resource_ledger_path(REPO_ROOT, drop_id).exists()
    finally:
        for run_id in (*prepare_ids, drop_id):
            _clean_if_owned(run_id)
        _drop_finalized_template(template)
