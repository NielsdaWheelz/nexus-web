import base64
import hashlib
import json
import logging
import os
import select
import signal
import socket
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import cast

import httpx
import pytest

import nexus_test_control.services as services
from nexus_test_control.build import StandaloneBuild
from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    EndpointKind,
    RuntimeContractError,
    RuntimePorts,
    claim_run,
    embedding_peer_state_dir,
    extension_profile_identity,
    initialize_runtime,
    migration_database_name,
    process_resource_identity,
    read_ledger,
    read_runtime,
    record_created,
    record_planned,
    run_bucket_name,
    run_database_name,
)
from nexus_test_control.services import (
    TEST_EXTENSION_ID,
    TEST_EXTENSION_PUBLIC_KEY,
    SupabaseCredentials,
    _database_url,
    _parse_supabase_status,
    _start_owned_process,
    _supabase_credentials_from_status,
    _write_supabase_config,
    clean_owned_runtime,
    clean_run,
    finish_embedding_peer_state,
    materialize_embedding_peer,
    new_run_id,
    prepare_embedding_peer_state,
    run_environment,
    start_python_process,
    start_web_process,
    wait_process_ready,
)
from nexus_test_control.services import TestRun as OwnedRun
from nexus_test_control.services import (
    TestUser as ScenarioUser,
)
from nexus_test_control.services import (
    test_environment as local_test_environment,
)

TEST_ENV = {"NEXUS_ENV": "test"}
RUN_ID = "0123456789abcdef"


def _ports() -> RuntimePorts:
    return RuntimePorts(
        15432, 19000, 25421, 25422, 25423, 25424, 25425, 18000, 18001, 13000, 19091, 19092
    )


def _process_is_running(process_id: int) -> bool:
    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    if sys.platform == "linux":
        try:
            status = (Path("/proc") / str(process_id) / "status").read_text(encoding="utf-8")
        except FileNotFoundError:
            return False
        state = next((line for line in status.splitlines() if line.startswith("State:")), "")
        return "Z (zombie)" not in state
    return True


def test_port_probe_rejects_an_existing_dual_stack_wildcard_listener() -> None:
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as holder:
        holder.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        holder.bind(("::", 0))
        holder.listen()

        port = int(holder.getsockname()[1])

        assert not services._port_available(port), (
            "an existing dual-stack listener was misclassified as an available test port"
        )


def _owned_run(
    tmp_path: Path,
    *,
    migration: bool = True,
    ports: RuntimePorts | None = None,
) -> OwnedRun:
    initialize_runtime(tmp_path, TEST_ENV, ports or _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    resources = [
        Resource(ResourceKind.RUN_DATABASE, run_database_name(RUN_ID)),
        Resource(ResourceKind.BUCKET, run_bucket_name(RUN_ID)),
    ]
    if migration:
        resources.append(Resource(ResourceKind.MIGRATION_DATABASE, migration_database_name(RUN_ID)))
    for resource in resources:
        record_planned(tmp_path, TEST_ENV, RUN_ID, resource)
        record_created(tmp_path, TEST_ENV, RUN_ID, resource)
    return OwnedRun(
        run_id=RUN_ID,
        database_url=_database_url(tmp_path, TEST_ENV, run_database_name(RUN_ID)),
        migration_database_url=(
            _database_url(tmp_path, TEST_ENV, migration_database_name(RUN_ID))
            if migration
            else None
        ),
        bucket=run_bucket_name(RUN_ID),
        supabase=SupabaseCredentials(
            "http://127.0.0.1:25421",
            "public-anon-key",
            "must-not-escape",
        ),
    )


def _empty_owned_run(tmp_path: Path) -> OwnedRun:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    return OwnedRun(
        run_id=RUN_ID,
        database_url=_database_url(tmp_path, TEST_ENV, run_database_name(RUN_ID)),
        migration_database_url=None,
        bucket=run_bucket_name(RUN_ID),
        supabase=SupabaseCredentials(
            "http://127.0.0.1:25421", "public-anon-key", "must-not-escape"
        ),
    )


def _created_embedding_peer_paths(tmp_path: Path, run: OwnedRun) -> dict[str, Path]:
    state = prepare_embedding_peer_state(tmp_path, TEST_ENV, run)
    paths = {
        "ca.pem": state / "ca.pem",
        "server-key.pem": state / "server-key.pem",
        "requests.jsonl": state / "requests.jsonl",
    }
    for path in paths.values():
        path.write_text("owned fixture\n", encoding="utf-8")
    finish_embedding_peer_state(tmp_path, TEST_ENV, run.run_id)
    return paths


def test_run_ids_are_exact_opaque_test_ownership_ids() -> None:
    first = new_run_id()
    second = new_run_id()

    assert len(first) == 16
    assert int(first, 16) >= 0
    assert first != second


def test_owned_process_unblocks_sigterm_before_exec_and_stops_gracefully(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    mask_path = tmp_path / "signal-mask.txt"
    script = (
        "import pathlib, signal, sys; "
        "mask = signal.pthread_sigmask(signal.SIG_BLOCK, set()); "
        "pathlib.Path(sys.argv[1]).write_text(str(signal.SIGTERM in mask)); "
        "signal.pause()"
    )
    started = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "api",
        (sys.executable, "-c", script, str(mask_path)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        for _attempt in range(500):
            if mask_path.is_file():
                break
            threading.Event().wait(0.01)
        assert mask_path.read_text(encoding="utf-8") == "False"

        clean_run(tmp_path, TEST_ENV, RUN_ID)

        assert not services._process_birth_identity_matches(
            started.process_group_id,
            started.process_start_token,
        ), "the original owned process identity survived graceful cleanup"
    finally:
        if services._process_birth_identity_matches(
            started.process_group_id,
            started.process_start_token,
        ):
            os.killpg(started.process_group_id, signal.SIGKILL)


def test_owned_process_cleanup_rejects_a_different_owner_without_signaling(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    started = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "api",
        (sys.executable, "-c", "import signal; signal.pause()"),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        with pytest.raises(RuntimeContractError, match="no longer belongs"):
            services._stop_process_group(
                tmp_path,
                started.process_group_id,
                started.process_start_token,
                started.run_id,
                "b" * 32,
                process_resource_identity(RUN_ID, "api"),
            )

        os.kill(started.process_group_id, 0)
    finally:
        clean_run(tmp_path, TEST_ENV, RUN_ID)


def test_owned_process_cleanup_waits_for_exact_birth_owner_to_finish_startup(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    owner_token = "a" * 32
    ready_path = tmp_path / "owner-startup-ready"
    release_path = tmp_path / "owner-startup-release"
    marker_path: Path | None = None
    child_environment = {
        **os.environ,
        "NEXUS_ENV": "test",
        "NEXUS_TEST_RUN_ID": RUN_ID,
    }
    child_environment.pop("NEXUS_TEST_PROCESS_OWNER", None)
    child_environment.pop("NEXUS_TEST_PROCESS_OWNER_FD", None)
    if sys.platform == "darwin":
        marker_path = services._process_owner_marker(tmp_path, RUN_ID, owner_token)
        script = (
            "import os,pathlib,signal,sys,time\n"
            "pathlib.Path(sys.argv[1]).write_text('ready')\n"
            "release=pathlib.Path(sys.argv[2])\n"
            "while not release.is_file():\n"
            "    time.sleep(0.01)\n"
            "owner_fd=os.open(sys.argv[3],os.O_RDONLY)\n"
            "signal.pause()\n"
        )
        command = (
            sys.executable,
            "-c",
            script,
            str(ready_path),
            str(release_path),
            str(marker_path),
        )
    else:
        assert sys.platform == "linux"
        script = (
            "import os,pathlib,signal,sys,time\n"
            "pathlib.Path(sys.argv[1]).write_text('ready')\n"
            "release=pathlib.Path(sys.argv[2])\n"
            "while not release.is_file():\n"
            "    time.sleep(0.01)\n"
            "environment=dict(os.environ)\n"
            "environment['NEXUS_TEST_PROCESS_OWNER']=sys.argv[3]\n"
            "os.execvpe(sys.executable,"
            "(sys.executable,'-c','import signal; signal.pause()'),environment)\n"
        )
        command = (
            sys.executable,
            "-c",
            script,
            str(ready_path),
            str(release_path),
            owner_token,
        )
    resource = Resource(ResourceKind.PROCESS, process_resource_identity(RUN_ID, "api"))
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        resource,
        external_id=owner_token,
        command=command,
    )
    if marker_path is not None:
        marker_path.parent.mkdir(parents=True, exist_ok=True)
        marker_path.touch(mode=0o600, exist_ok=False)
    process = subprocess.Popen(
        command,
        cwd=tmp_path,
        env=child_environment,
        start_new_session=True,
    )
    try:
        start_token = services._process_start_token(process.pid)
        record_created(
            tmp_path,
            TEST_ENV,
            RUN_ID,
            resource,
            process_group_id=process.pid,
            process_start_token=start_token,
        )
        for _attempt in range(500):
            if ready_path.is_file():
                break
            threading.Event().wait(0.01)
        assert ready_path.read_text(encoding="utf-8") == "ready"
        assert process.pid not in services._owned_process_group_map(
            tmp_path,
            RUN_ID,
            owner_token,
        )
        assert services._process_birth_identity_matches(process.pid, start_token)

        caplog.set_level(logging.DEBUG, logger=services.__name__)
        with ThreadPoolExecutor(max_workers=1) as executor:
            cleanup = executor.submit(clean_run, tmp_path, TEST_ENV, RUN_ID)
            pending_observation = None
            for _attempt in range(500):
                pending_observation = next(
                    (
                        record
                        for record in caplog.records
                        if getattr(record, "event", None)
                        == "nexus_test.process_owner_visibility_pending"
                    ),
                    None,
                )
                if pending_observation is not None or cleanup.done():
                    break
                threading.Event().wait(0.01)
            release_path.touch(exist_ok=False)
            cleanup_error = cleanup.exception(timeout=5)

        assert pending_observation is not None, (
            "cleanup never observed exact birth while ownership was hidden"
        )
        assert getattr(pending_observation, "process_group_id", None) == process.pid
        assert getattr(pending_observation, "resource_identity", None) == resource.identity
        assert getattr(pending_observation, "run_id", None) == RUN_ID
        assert cleanup_error is None, f"cleanup rejected transitional ownership: {cleanup_error}"
        process.wait(timeout=3)
        assert not _process_is_running(process.pid)
        assert read_runtime(tmp_path).owned_run_ids == ()
    finally:
        release_path.touch(exist_ok=True)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        if marker_path is not None:
            marker_path.unlink(missing_ok=True)


def test_clean_reaps_an_exact_created_process_that_exits_before_owner_scan(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    ready_path = tmp_path / "exiting-owner-ready"
    release_path = tmp_path / "exiting-owner-release"
    script = (
        "import pathlib,sys,time\n"
        "pathlib.Path(sys.argv[1]).write_text('ready')\n"
        "release=pathlib.Path(sys.argv[2])\n"
        "while not release.is_file():\n"
        "    time.sleep(0.01)\n"
    )
    started = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "api",
        (sys.executable, "-c", script, str(ready_path), str(release_path)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    exit_observer = None
    try:
        if sys.platform == "darwin":
            exit_observer = select.kqueue()
            exit_observer.control(
                [
                    select.kevent(
                        started.process_group_id,
                        filter=select.KQ_FILTER_PROC,
                        flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_CLEAR,
                        fflags=select.KQ_NOTE_EXIT,
                    )
                ],
                0,
                0,
            )
        for _attempt in range(500):
            if ready_path.is_file():
                break
            threading.Event().wait(0.01)
        assert ready_path.read_text(encoding="utf-8") == "ready"
        release_path.touch(exist_ok=False)
        for _attempt in range(500):
            if exit_observer is not None:
                exited = bool(exit_observer.control(None, 1, 0))
            else:
                exited = (
                    os.waitid(
                        os.P_PID,
                        started.process_group_id,
                        os.WEXITED | os.WNOHANG | os.WNOWAIT,
                    )
                    is not None
                )
            if exited:
                break
            threading.Event().wait(0.01)
        else:
            pytest.fail("owned child did not exit without being reaped")

        clean_run(tmp_path, TEST_ENV, RUN_ID)

        if sys.platform == "linux":
            with pytest.raises(ChildProcessError):
                os.waitid(
                    os.P_PID,
                    started.process_group_id,
                    os.WEXITED | os.WNOHANG | os.WNOWAIT,
                )
        else:
            assert not _process_is_running(started.process_group_id)
        assert read_runtime(tmp_path).owned_run_ids == ()
    finally:
        if exit_observer is not None:
            exit_observer.close()
        try:
            os.killpg(started.process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(started.process_group_id, 0)
        except ChildProcessError:
            pass


def test_clean_stops_owned_children_after_the_recorded_group_leader_exits(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    child_path = tmp_path / "child-pid.txt"
    leader_script = (
        "import os,pathlib,signal,subprocess,sys; "
        "owner_fd=os.environ.get('NEXUS_TEST_PROCESS_OWNER_FD'); "
        "inherited=() if owner_fd is None else (int(owner_fd),); "
        "child=subprocess.Popen((sys.executable,'-c','import signal; signal.pause()'),"
        "pass_fds=inherited); "
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); "
        "signal.pause()"
    )
    started = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "api",
        (sys.executable, "-c", leader_script, str(child_path)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    child_pid = 0
    try:
        for _attempt in range(500):
            if child_path.is_file():
                child_pid = int(child_path.read_text(encoding="utf-8"))
                break
            threading.Event().wait(0.01)
        assert child_pid > 1

        os.kill(started.process_group_id, signal.SIGTERM)
        os.waitpid(started.process_group_id, 0)
        os.kill(child_pid, 0)

        clean_run(tmp_path, TEST_ENV, RUN_ID)

        assert not _process_is_running(child_pid)
    finally:
        try:
            os.killpg(started.process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_clean_recovers_a_process_killed_between_spawn_and_created_record(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    owner_token = "a" * 32
    command = (sys.executable, "-c", "import signal; signal.pause()")
    resource = Resource(ResourceKind.PROCESS, process_resource_identity(RUN_ID, "api"))
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        resource,
        external_id=owner_token,
        command=command,
    )
    owner_descriptor: int | None = None
    inherited_descriptors: tuple[int, ...] = ()
    if sys.platform == "darwin":
        owner_marker = services._process_owner_marker(tmp_path, RUN_ID, owner_token)
        owner_marker.parent.mkdir(parents=True, exist_ok=True)
        owner_descriptor = os.open(
            owner_marker,
            os.O_CREAT | os.O_EXCL | os.O_RDONLY,
            0o600,
        )
        inherited_descriptors = (owner_descriptor,)
    try:
        process = subprocess.Popen(
            command,
            env={
                **os.environ,
                "NEXUS_ENV": "test",
                "NEXUS_TEST_PROCESS_OWNER": owner_token,
                "NEXUS_TEST_RUN_ID": RUN_ID,
            },
            start_new_session=True,
            pass_fds=inherited_descriptors,
        )
    finally:
        if owner_descriptor is not None:
            os.close(owner_descriptor)
    try:
        clean_run(tmp_path, TEST_ENV, RUN_ID)

        process.wait(timeout=3)
        assert not (tmp_path / ".nexus-test/runs" / RUN_ID).exists()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def test_clean_recovers_planned_children_after_the_group_leader_exits(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    owner_token = "a" * 32
    child_path = tmp_path / "planned-child-pid.txt"
    leader_script = (
        "import os,pathlib,signal,subprocess,sys; "
        "owner_fd=os.environ.get('NEXUS_TEST_PROCESS_OWNER_FD'); "
        "inherited=() if owner_fd is None else (int(owner_fd),); "
        "child=subprocess.Popen((sys.executable,'-c','import signal; signal.pause()'),"
        "pass_fds=inherited); "
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); "
        "signal.pause()"
    )
    command = (sys.executable, "-c", leader_script, str(child_path))
    resource = Resource(ResourceKind.PROCESS, process_resource_identity(RUN_ID, "api"))
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        resource,
        external_id=owner_token,
        command=command,
    )
    owner_descriptor: int | None = None
    inherited_descriptors: tuple[int, ...] = ()
    owner_environment: dict[str, str] = {}
    if sys.platform == "darwin":
        owner_marker = services._process_owner_marker(tmp_path, RUN_ID, owner_token)
        owner_marker.parent.mkdir(parents=True, exist_ok=True)
        owner_descriptor = os.open(
            owner_marker,
            os.O_CREAT | os.O_EXCL | os.O_RDONLY,
            0o600,
        )
        inherited_descriptors = (owner_descriptor,)
        owner_environment["NEXUS_TEST_PROCESS_OWNER_FD"] = str(owner_descriptor)
    try:
        leader = subprocess.Popen(
            command,
            env={
                **os.environ,
                "NEXUS_ENV": "test",
                "NEXUS_TEST_PROCESS_OWNER": owner_token,
                "NEXUS_TEST_RUN_ID": RUN_ID,
                **owner_environment,
            },
            start_new_session=True,
            pass_fds=inherited_descriptors,
        )
    finally:
        if owner_descriptor is not None:
            os.close(owner_descriptor)
    child_pid = 0
    try:
        for _attempt in range(500):
            if child_path.is_file():
                child_pid = int(child_path.read_text(encoding="utf-8"))
                break
            threading.Event().wait(0.01)
        assert child_pid > 1

        os.kill(leader.pid, signal.SIGTERM)
        leader.wait(timeout=3)
        os.kill(child_pid, 0)

        clean_run(tmp_path, TEST_ENV, RUN_ID)

        assert not _process_is_running(child_pid)
    finally:
        try:
            os.killpg(leader.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_clean_uses_immutable_identity_when_owned_process_rewrites_argv(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    command = (
        "/bin/bash",
        "-c",
        'exec -a nexus-mutated-title "$1" -c "import signal; signal.pause()"',
        "owned-process",
        sys.executable,
    )
    started = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "web",
        command,
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    command_line = b""
    try:
        for _attempt in range(500):
            if sys.platform == "linux":
                command_line = (
                    Path("/proc") / str(started.process_group_id) / "cmdline"
                ).read_bytes()
            else:
                command_line = subprocess.run(
                    (
                        "/bin/ps",
                        "-ww",
                        "-p",
                        str(started.process_group_id),
                        "-o",
                        "command=",
                    ),
                    check=True,
                    capture_output=True,
                ).stdout
            if b"/bin/bash" not in command_line:
                break
            threading.Event().wait(0.01)
        assert b"/bin/bash" not in command_line

        clean_run(tmp_path, TEST_ENV, RUN_ID)

        assert not services._process_birth_identity_matches(
            started.process_group_id,
            started.process_start_token,
        ), "the original argv-rewriting process identity survived cleanup"
    finally:
        if services._process_birth_identity_matches(
            started.process_group_id,
            started.process_start_token,
        ):
            os.killpg(started.process_group_id, signal.SIGKILL)


def test_readiness_rejects_listener_outside_owned_process_group(tmp_path: Path) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as allocator:
        allocator.bind(("127.0.0.1", 0))
        port = int(allocator.getsockname()[1])
    initialize_runtime(tmp_path, TEST_ENV, replace(_ports(), web=port))
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    stale = subprocess.Popen(
        (sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"),
        cwd=tmp_path,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    owned = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "web",
        (sys.executable, "-c", "import signal; signal.pause()"),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        for _attempt in range(500):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    break
            threading.Event().wait(0.01)
        else:
            pytest.fail("foreign listener did not start")

        with pytest.raises(RuntimeContractError, match="did not become ready"):
            wait_process_ready(
                tmp_path,
                TEST_ENV,
                owned,
                endpoint=EndpointKind.WEB,
                path="/",
                timeout_seconds=0.2,
            )
    finally:
        try:
            clean_run(tmp_path, TEST_ENV, RUN_ID)
        finally:
            try:
                os.killpg(stale.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stale.wait()


def test_readiness_rejects_an_owned_listener_that_returns_unauthorized(tmp_path: Path) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as allocator:
        allocator.bind(("127.0.0.1", 0))
        port = int(allocator.getsockname()[1])
    initialize_runtime(tmp_path, TEST_ENV, replace(_ports(), web=port))
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    server = (
        "import http.server,sys; "
        "handler=type('Unauthorized',(http.server.BaseHTTPRequestHandler,),{"
        "'do_GET':lambda self:(self.send_response(401),self.end_headers()),"
        "'log_message':lambda *args:None}); "
        "http.server.ThreadingHTTPServer(('127.0.0.1',int(sys.argv[1])),handler).serve_forever()"
    )
    owned = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "web",
        (sys.executable, "-c", server, str(port)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        with pytest.raises(RuntimeContractError, match="did not become ready"):
            wait_process_ready(
                tmp_path,
                TEST_ENV,
                owned,
                endpoint=EndpointKind.WEB,
                path="/",
                timeout_seconds=0.2,
            )
    finally:
        clean_run(tmp_path, TEST_ENV, RUN_ID)


def test_mcp_readiness_accepts_only_an_exact_owned_loopback_unauthorized_listener(
    tmp_path: Path,
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as allocator:
        allocator.bind(("127.0.0.1", 0))
        port = int(allocator.getsockname()[1])
    initialize_runtime(tmp_path, TEST_ENV, replace(_ports(), agent_tools_mcp=port))
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    server = (
        "import http.server,sys; "
        "handler=type('Unauthorized',(http.server.BaseHTTPRequestHandler,),{"
        "'do_GET':lambda self:(self.send_response(401),self.end_headers()),"
        "'log_message':lambda *args:None}); "
        "http.server.ThreadingHTTPServer(('127.0.0.1',int(sys.argv[1])),handler).serve_forever()"
    )
    owned = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "worker-interactive",
        (sys.executable, "-c", server, str(port)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        wait_process_ready(
            tmp_path,
            TEST_ENV,
            owned,
            EndpointKind.AGENT_TOOLS_MCP,
            "/internal/agent-tools/mcp",
        )
    finally:
        clean_run(tmp_path, TEST_ENV, RUN_ID)


def test_mcp_readiness_rejects_an_owned_wildcard_unauthorized_listener(
    tmp_path: Path,
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as allocator:
        allocator.bind(("127.0.0.1", 0))
        port = int(allocator.getsockname()[1])
    initialize_runtime(tmp_path, TEST_ENV, replace(_ports(), agent_tools_mcp=port))
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    server = (
        "import http.server,sys; "
        "handler=type('Unauthorized',(http.server.BaseHTTPRequestHandler,),{"
        "'do_GET':lambda self:(self.send_response(401),self.end_headers()),"
        "'log_message':lambda *args:None}); "
        "http.server.ThreadingHTTPServer(('0.0.0.0',int(sys.argv[1])),handler).serve_forever()"
    )
    owned = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "worker-interactive",
        (sys.executable, "-c", server, str(port)),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        for _attempt in range(500):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    break
            threading.Event().wait(0.01)
        else:
            pytest.fail("owned wildcard listener did not start")

        with pytest.raises(RuntimeContractError, match="did not become ready"):
            wait_process_ready(
                tmp_path,
                TEST_ENV,
                owned,
                EndpointKind.AGENT_TOOLS_MCP,
                "/internal/agent-tools/mcp",
                timeout_seconds=0.2,
            )
    finally:
        clean_run(tmp_path, TEST_ENV, RUN_ID)


def test_darwin_listener_attestation_selects_only_the_exact_loopback_address() -> None:
    output = "p123\nf10\nn127.0.0.1:18001\np456\nf11\nn*:18001\np789\nf12\nn127.0.0.1:18002\n"

    assert services._parse_darwin_lsof_listener_process_ids(
        output,
        host="127.0.0.1",
        port=18001,
    ) == (123,)


@pytest.mark.parametrize(
    "path",
    (
        "/internal/agent-tools/mcp?alias=1",
        "/internal/agent-tools/mcp/",
        "/internal/agent-tools/mcp#alias",
    ),
)
def test_mcp_readiness_rejects_path_aliases_before_contact(tmp_path: Path, path: str) -> None:
    process = services.StartedProcess(
        "worker-interactive",
        99999,
        "1",
        RUN_ID,
        "0" * 32,
        "unused.log",
    )

    with pytest.raises(RuntimeContractError, match="literal path"):
        wait_process_ready(
            tmp_path,
            TEST_ENV,
            process,
            EndpointKind.AGENT_TOOLS_MCP,
            path,
        )


def test_mcp_readiness_rejects_a_string_endpoint_alias_before_contact(tmp_path: Path) -> None:
    process = services.StartedProcess(
        "worker-interactive",
        99999,
        "1",
        RUN_ID,
        "0" * 32,
        "unused.log",
    )

    with pytest.raises(RuntimeContractError, match="typed endpoint"):
        wait_process_ready(
            tmp_path,
            TEST_ENV,
            process,
            cast(EndpointKind, "agent-tools-mcp"),
            "/internal/agent-tools/mcp",
        )


def test_mcp_readiness_rejects_a_relabelled_noninteractive_ledger_process(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    owned = _start_owned_process(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "api",
        (sys.executable, "-c", "import signal; signal.pause()"),
        cwd=tmp_path,
        process_environment={"NEXUS_TEST_RUN_ID": RUN_ID},
    )
    try:
        with pytest.raises(RuntimeContractError, match="exact created worker-interactive"):
            wait_process_ready(
                tmp_path,
                TEST_ENV,
                replace(owned, role="worker-interactive"),
                EndpointKind.AGENT_TOOLS_MCP,
                "/internal/agent-tools/mcp",
            )
    finally:
        clean_run(tmp_path, TEST_ENV, RUN_ID)


def test_process_identity_grace_requires_immutable_birth_identity_and_time() -> None:
    assert services._process_identity_pending(birth_matches=True, now=1, deadline=2)
    assert not services._process_identity_pending(birth_matches=False, now=1, deadline=2)
    assert not services._process_identity_pending(birth_matches=True, now=2, deadline=2)


def test_caller_resource_configuration_is_rejected_and_secrets_have_safe_reprs() -> None:
    assert local_test_environment({}) == TEST_ENV
    for environment in (
        {"NEXUS_ENV": "prod"},
        {"DATABASE_URL": "postgresql://production.example/app"},
        {"SUPABASE_DB_URL": "postgresql://production.example/postgres"},
        {"R2_ENDPOINT_URL": "https://production.example"},
        {"SUPABASE_JWKS_URL": "https://production.example/jwks"},
        {"AWS_ENDPOINT_URL_S3": "https://production.example"},
        {"PGHOST": "production.example"},
        {"SUPABASE_ACCESS_TOKEN": "production-token"},
        {"NEXUS_AGENT_TOOLS_MCP_LISTEN": "0.0.0.0:8001"},
        {"NEXUS_AGENT_TOOLS_MCP_ORIGIN": ("https://production.example/internal/agent-tools/mcp")},
        {"WORKER_LANE": "interactive"},
        {"OUTBOUND_HTTP_PROXY_URL": "https://production.example"},
        {"PODCAST_INDEX_BASE_URL": "https://production.example"},
        {"NEXUS_TEST_STATIC_DNS": '{"production.example":"93.184.216.34"}'},
        {"NODE_OPTIONS": "--import=/tmp/foreign.mjs"},
        {"DOCKER_HOST": "tcp://production.example:2376"},
        {"DOCKER_CONTEXT": "production"},
    ):
        with pytest.raises(RuntimeContractError):
            local_test_environment(environment)
    assert "admin-secret" not in repr(
        SupabaseCredentials("http://127.0.0.1:25421", "anon", "admin-secret")
    )
    assert "password-secret" not in repr(
        ScenarioUser(
            "12345678-1234-4123-8123-123456789abc",
            "test@example.invalid",
            "password-secret",
        )
    )


@pytest.mark.parametrize(
    ("role", "setting", "value"),
    (
        ("worker-interactive", "WORKER_LANE", "background"),
        ("worker-interactive", "NEXUS_AGENT_TOOLS_MCP_LISTEN", "127.0.0.1:28001"),
        (
            "worker-interactive",
            "NEXUS_AGENT_TOOLS_MCP_ORIGIN",
            "http://127.0.0.1:28001/internal/agent-tools/mcp",
        ),
        ("worker-background", "WORKER_LANE", "interactive"),
        ("worker-background", "NEXUS_AGENT_TOOLS_MCP_LISTEN", "0.0.0.0:28001"),
        (
            "worker-background",
            "NEXUS_AGENT_TOOLS_MCP_ORIGIN",
            "http://127.0.0.1:28001/internal/agent-tools/mcp",
        ),
    ),
)
def test_worker_rejects_a_runtime_topology_override_before_spawn(
    tmp_path: Path,
    role: str,
    setting: str,
    value: str,
) -> None:
    run = _owned_run(tmp_path, migration=False)

    with pytest.raises(RuntimeContractError, match="runtime topology is controller-owned"):
        start_python_process(
            tmp_path,
            TEST_ENV,
            run,
            role,
            overrides={setting: value},
        )

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


def test_supabase_status_parser_ignores_cli_noise_and_keeps_only_required_values() -> None:
    status = _parse_supabase_status(
        "Stopped services: [studio]\n"
        '{"API_URL":"http://127.0.0.1:25421","ANON_KEY":"public",'
        '"SECRET_KEY":"admin","DB_URL":"must-not-leak"}\n'
    )

    assert status == {
        "API_URL": "http://127.0.0.1:25421",
        "ANON_KEY": "public",
        "SECRET_KEY": "admin",
    }


def test_supabase_status_parser_accepts_the_service_role_admin_key() -> None:
    status = _parse_supabase_status(
        '{"API_URL":"http://127.0.0.1:25421","ANON_KEY":"public","SERVICE_ROLE_KEY":"admin"}\n'
    )

    assert status["SERVICE_ROLE_KEY"] == "admin"


def test_supabase_credentials_use_the_recorded_url_when_cli_omits_api_url() -> None:
    credentials = _supabase_credentials_from_status(
        {"ANON_KEY": "public", "SECRET_KEY": "admin"},
        "http://127.0.0.1:25421",
    )

    assert credentials.url == "http://127.0.0.1:25421"
    assert credentials.anon_key == "public"


def test_supabase_credentials_reject_a_cli_url_outside_the_recorded_runtime() -> None:
    with pytest.raises(RuntimeContractError, match="does not match"):
        _supabase_credentials_from_status(
            {
                "API_URL": "https://production.example",
                "ANON_KEY": "public",
                "SECRET_KEY": "admin",
            },
            "http://127.0.0.1:25421",
        )


def test_supabase_start_failure_reports_redacted_output_and_container_state() -> None:
    error = subprocess.CalledProcessError(
        1,
        ("supabase", "start"),
        output=(
            "DB URL: postgresql://postgres:db-password@127.0.0.1:25422/postgres\n"
            '{"ANON_KEY":"anon-secret"}\n'
        ),
        stderr=("JWT secret: jwt-secret\nsupabase_auth_test container logs: auth failed"),
    )

    message = services._supabase_start_failure_message(
        error,
        "supabase_auth_test\tExited (1)\tpublic.ecr.aws/supabase/gotrue:latest\n",
    )

    assert "local Supabase failed to start" in message
    assert "supabase_auth_test\tExited (1)" in message
    assert "auth failed" in message
    assert "[REDACTED]" in message
    assert "db-password" not in message
    assert "anon-secret" not in message
    assert "jwt-secret" not in message


def test_admin_invite_records_ownership_before_provider_creation_and_returns_email_only(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    email = f"nexus+{RUN_ID}+auth-session@example.invalid"
    user_id = "12345678-1234-4123-8123-123456789abc"
    admin_key = "controller-only-admin-key"

    def provider(request: httpx.Request) -> httpx.Response:
        [planned] = read_ledger(tmp_path, RUN_ID).entries
        assert planned.resource == Resource(ResourceKind.SUPABASE_USER, email)
        assert planned.scenario_id == "auth-session"
        assert planned.phase.value == "planned"
        assert planned.external_id is None
        assert request.method == "POST"
        assert request.url.path == "/auth/v1/invite"
        assert request.headers["authorization"] == f"Bearer {admin_key}"
        assert request.headers["apikey"] == admin_key
        assert json.loads(request.content) == {
            "email": email,
            "data": {
                "nexus_test_run_id": RUN_ID,
                "nexus_test_scenario": "auth-session",
            },
        }
        return httpx.Response(200, json={"id": user_id, "email": email})

    client_type = httpx.Client
    transport = httpx.MockTransport(provider)

    def provider_client(*, trust_env: bool, timeout: int) -> httpx.Client:
        return client_type(transport=transport, trust_env=trust_env, timeout=timeout)

    monkeypatch.setattr(httpx, "Client", provider_client)

    invited = services.invite_supabase_user(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        "auth-session",
        SupabaseCredentials("http://127.0.0.1:25421", "public", admin_key),
    )

    assert invited.email == email
    assert not hasattr(invited, "id")
    assert not hasattr(invited, "password")
    assert admin_key not in repr(invited)
    [created] = read_ledger(tmp_path, RUN_ID).entries
    assert created.phase.value == "created"
    assert created.external_id == user_id


def test_cleanup_recovers_provider_created_invite_left_planned(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    email = f"nexus+{RUN_ID}+auth-session@example.invalid"
    user_id = "12345678-1234-4123-8123-123456789abc"
    admin_key = "controller-only-admin-key"
    resource = Resource(ResourceKind.SUPABASE_USER, email)
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        resource,
        scenario_id="auth-session",
    )
    calls: list[tuple[str, str]] = []
    listed_pages: list[int] = []

    def provider(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == f"Bearer {admin_key}"
        assert request.headers["apikey"] == admin_key
        if request.method == "GET" and request.url.path == "/auth/v1/admin/users":
            page = int(request.url.params["page"])
            listed_pages.append(page)
            assert request.url.params["per_page"] == "1000"
            if page == 1:
                return httpx.Response(
                    200,
                    json={
                        "users": [
                            {
                                "id": f"00000000-0000-4000-8000-{index:012x}",
                                "email": f"unrelated-{index}@example.invalid",
                                "user_metadata": {},
                            }
                            for index in range(1000)
                        ]
                    },
                )
            assert page == 2
            return httpx.Response(
                200,
                json={
                    "users": [
                        {
                            "id": user_id,
                            "email": email,
                            "user_metadata": {
                                "nexus_test_run_id": RUN_ID,
                                "nexus_test_scenario": "auth-session",
                            },
                        }
                    ]
                },
            )
        if request.url.path == f"/auth/v1/admin/users/{user_id}":
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={
                        "id": user_id,
                        "email": email,
                        "user_metadata": {
                            "nexus_test_run_id": RUN_ID,
                            "nexus_test_scenario": "auth-session",
                        },
                    },
                )
            if request.method == "DELETE":
                return httpx.Response(204)
        raise AssertionError(f"unexpected Supabase cleanup request: {request.method}")

    client_type = httpx.Client
    transport = httpx.MockTransport(provider)

    def provider_client(*, trust_env: bool, timeout: int) -> httpx.Client:
        return client_type(transport=transport, trust_env=trust_env, timeout=timeout)

    monkeypatch.setattr(httpx, "Client", provider_client)

    clean_run(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        supabase=SupabaseCredentials(
            "http://127.0.0.1:25421",
            "public",
            admin_key,
        ),
    )

    assert calls == [
        ("GET", "/auth/v1/admin/users"),
        ("GET", "/auth/v1/admin/users"),
        ("GET", f"/auth/v1/admin/users/{user_id}"),
        ("DELETE", f"/auth/v1/admin/users/{user_id}"),
    ]
    assert listed_pages == [1, 2]
    assert not (tmp_path / ".nexus-test" / "runs" / RUN_ID).exists()


def test_supabase_status_parser_rejects_non_json() -> None:
    with pytest.raises(RuntimeContractError, match="not JSON"):
        _parse_supabase_status("Supabase is unavailable")


def test_supabase_workdir_contains_generated_config_and_exact_email_template_assets(
    tmp_path: Path,
) -> None:
    (tmp_path / "supabase").mkdir()
    (tmp_path / "supabase" / "config.toml").write_text(
        "\n".join(
            (
                'project_id = "nexus"',
                "[api]",
                "port = 54321",
                "[db]",
                "port = 54322",
                "shadow_port = 54320",
                "[studio]",
                "port = 54323",
                "[inbucket]",
                "port = 54324",
                "[auth]",
                'site_url = "http://localhost:3000"',
                'jwt_issuer = "http://127.0.0.1:54321/auth/v1"',
                'additional_redirect_urls = ["http://localhost:3000/auth/callback"]',
                "[auth.email.template.invite]",
                'content_path = "./supabase/templates/invite.html"',
                "[auth.email.template.recovery]",
                'content_path = "./supabase/templates/recovery.html"',
            )
        )
        + "\n"
    )
    source_templates = tmp_path / "supabase" / "templates"
    source_templates.mkdir()
    invite_template = b"<p>Accept this Nexus invitation.</p>\n"
    recovery_template = b"<p>Continue this Nexus password reset.</p>\n"
    (source_templates / "invite.html").write_bytes(invite_template)
    (source_templates / "recovery.html").write_bytes(recovery_template)
    runtime = initialize_runtime(tmp_path, TEST_ENV, _ports())

    _write_supabase_config(tmp_path)

    generated = Path(runtime.supabase_workdir) / "supabase" / "config.toml"
    text = generated.read_text()
    assert f'project_id = "{runtime.compose_project}"' in text
    assert "port = 25421" in text
    assert "port = 25422" in text
    assert "shadow_port = 25425" in text
    assert "port = 25423" in text
    assert "port = 25424" in text
    assert 'site_url = "http://127.0.0.1:13000"' in text
    assert 'jwt_issuer = "http://127.0.0.1:25421/auth/v1"' in text
    assert '"http://127.0.0.1:13000/auth/callback"' in text
    generated_templates = generated.parent / "templates"
    assert (generated_templates / "invite.html").read_bytes() == invite_template
    assert (generated_templates / "recovery.html").read_bytes() == recovery_template


def test_application_database_url_selects_the_installed_psycopg_driver(tmp_path: Path) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())

    assert _database_url(tmp_path, TEST_ENV, "nexus_run_0123456789abcdef").startswith(
        "postgresql+psycopg://127.0.0.1:15432/"
    )


def test_run_environment_contains_only_exact_local_resources_and_no_admin_key(
    tmp_path: Path,
) -> None:
    run = _owned_run(tmp_path)

    environment = run_environment(tmp_path, TEST_ENV, run)

    assert environment["DATABASE_URL"] == run.database_url
    assert environment["NEXUS_MIGRATION_DATABASE_URL"] == run.migration_database_url
    assert environment["R2_BUCKET"] == run.bucket
    assert environment["NEXT_PUBLIC_SUPABASE_URL"] == "http://127.0.0.1:25421"
    assert environment["NEXT_PUBLIC_SUPABASE_ANON_KEY"] == "public-anon-key"
    assert environment["OPENAI_API_KEY"] == "nexus-test-fixture-openai-key"
    assert environment["NEXUS_RUNTIME_IDENTITY_FILE"] == str(
        tmp_path / ".nexus-test/runtime-identity.json"
    )
    assert environment["PARSER_TEMP_ROOT"] == str(
        tmp_path / "test-results/runs/0123456789abcdef/parser-tmp"
    )
    assert environment["NEXUS_EXTENSION_REDIRECT_ORIGINS"] == (
        f"https://{TEST_EXTENSION_ID}.chromiumapp.org"
    )
    assert environment["NEXUS_TEST_STATIC_DNS"] == '{"www.nasa.gov":"93.184.216.34"}'
    assert environment["OUTBOUND_HTTP_PROXY_URL"] == "http://127.0.0.1:19091"
    assert environment["PODCASTS_ENABLED"] == "true"
    assert environment["PODCAST_INDEX_API_KEY"] == "nexus-test-fixture-podcast-key"
    assert environment["PODCAST_INDEX_API_SECRET"] == "nexus-test-fixture-podcast-secret"
    assert environment["PODCAST_INDEX_BASE_URL"] == "http://127.0.0.1:19091"
    assert "must-not-escape" not in repr(environment)
    assert not {
        "SERVICE_ROLE_KEY",
        "SUPABASE_AUTH_ADMIN_KEY",
        "SUPABASE_SERVICE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
    }.intersection(environment)


def test_embedding_peer_materializes_one_exact_client_identity(tmp_path: Path) -> None:
    run = _empty_owned_run(tmp_path)

    peer = materialize_embedding_peer(tmp_path, TEST_ENV, run)

    assert peer.state == embedding_peer_state_dir(tmp_path, RUN_ID)
    assert peer.certificate.read_bytes().startswith(b"-----BEGIN CERTIFICATE-----")
    assert peer.key.read_bytes().startswith(b"-----BEGIN PRIVATE KEY-----")
    assert peer.key.stat().st_mode & 0o777 == 0o600
    assert peer.audit.read_bytes() == b""
    assert peer.client_environment() == {
        "NEXUS_TEST_STATIC_DNS": (
            '{"api.openai.com":{"address":"127.0.0.1","port":19092},"www.nasa.gov":"93.184.216.34"}'
        ),
        "NEXUS_TEST_TLS_CA_CERT": str(peer.certificate),
    }

    clean_run(tmp_path, TEST_ENV, RUN_ID)
    assert not peer.state.exists()


@pytest.mark.parametrize(
    "run",
    (
        OwnedRun(
            RUN_ID,
            "postgresql+psycopg://production.example/nexus",
            None,
            run_bucket_name(RUN_ID),
            SupabaseCredentials("http://127.0.0.1:25421", "anon", "admin"),
        ),
        OwnedRun(
            RUN_ID,
            "postgresql+psycopg://127.0.0.1:15432/other",
            None,
            "production-library",
            SupabaseCredentials("https://production.example", "anon", "admin"),
        ),
    ),
    ids=("public-database", "foreign-owned-resources"),
)
def test_python_child_rejects_unpersisted_or_public_run_resources_before_spawn(
    tmp_path: Path,
    run: OwnedRun,
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied_port:
        occupied_port.bind(("127.0.0.1", 0))
        occupied_port.listen()
        api_port = int(occupied_port.getsockname()[1])
        persisted = _owned_run(
            tmp_path,
            migration=False,
            ports=replace(_ports(), api=api_port),
        )
        poisoned = replace(
            run,
            database_url=run.database_url,
            migration_database_url=persisted.migration_database_url,
        )

        with pytest.raises(RuntimeContractError, match="exact persisted local test run"):
            start_python_process(tmp_path, TEST_ENV, poisoned, "api")

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


def test_provider_child_rejects_missing_owned_fixture_before_port_admission(
    tmp_path: Path,
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied_port:
        occupied_port.bind(("127.0.0.1", 0))
        occupied_port.listen()
        provider_port = int(occupied_port.getsockname()[1])
        run = _owned_run(
            tmp_path,
            migration=False,
            ports=replace(_ports(), provider_openai=provider_port),
        )

        with pytest.raises(RuntimeContractError, match="requires its exact created state owner"):
            start_python_process(tmp_path, TEST_ENV, run, "provider-openai")

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


@pytest.mark.parametrize(
    "substituted_name",
    (
        "NEXUS_TEST_OPENAI_CERTIFICATE",
        "NEXUS_TEST_OPENAI_KEY",
        "NEXUS_TEST_OPENAI_AUDIT",
    ),
)
def test_embedding_peer_rejects_each_substituted_path_before_recording_a_process(
    tmp_path: Path,
    substituted_name: str,
) -> None:
    run = _empty_owned_run(tmp_path)
    _created_embedding_peer_paths(tmp_path, run)
    foreign = tmp_path / f"foreign-{substituted_name.casefold()}"
    foreign.write_text("foreign fixture\n", encoding="utf-8")

    with pytest.raises(RuntimeContractError, match="environment is controller-owned"):
        start_python_process(
            tmp_path,
            TEST_ENV,
            run,
            "provider-openai",
            overrides={substituted_name: str(foreign)},
        )

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


@pytest.mark.parametrize("defect", ("missing", "directory", "symlink"))
def test_embedding_peer_rejects_each_invalid_owned_file_before_recording_a_process(
    tmp_path: Path,
    defect: str,
) -> None:
    run = _owned_run(tmp_path, migration=False)
    certificate = _created_embedding_peer_paths(tmp_path, run)["ca.pem"]
    certificate.unlink()
    if defect == "directory":
        certificate.mkdir()
    elif defect == "symlink":
        foreign = tmp_path / "foreign-certificate.pem"
        foreign.write_text("foreign fixture\n", encoding="utf-8")
        certificate.symlink_to(foreign)

    with pytest.raises(RuntimeContractError, match="exact files|non-owned file"):
        start_python_process(tmp_path, TEST_ENV, run, "provider-openai")

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


def test_clean_recovers_an_interrupted_embedding_peer_preparation(tmp_path: Path) -> None:
    run = _empty_owned_run(tmp_path)
    state = prepare_embedding_peer_state(tmp_path, TEST_ENV, run)
    (state / "requests.jsonl").write_text("partial\n", encoding="utf-8")

    clean_run(tmp_path, TEST_ENV, RUN_ID)

    assert not state.exists()
    assert not embedding_peer_state_dir(tmp_path, RUN_ID).parent.exists()


def test_web_child_rejects_public_supabase_before_recording_or_spawning_process(
    tmp_path: Path,
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied_port:
        occupied_port.bind(("127.0.0.1", 0))
        occupied_port.listen()
        web_port = int(occupied_port.getsockname()[1])
        run = _owned_run(
            tmp_path,
            migration=False,
            ports=replace(_ports(), web=web_port),
        )
        poisoned = replace(
            run,
            supabase=SupabaseCredentials("https://production.example", "anon", "admin"),
        )
        artifact = tmp_path / ".nexus-test/builds" / ("a" * 64)
        artifact.mkdir(parents=True)
        server = artifact / "server.js"
        server.write_text("throw new Error('must not run')\n", encoding="utf-8")

        with pytest.raises(RuntimeContractError, match="exact persisted local test run"):
            start_web_process(
                tmp_path,
                TEST_ENV,
                poisoned,
                StandaloneBuild("a" * 64, artifact, server),
            )

    assert not any(
        entry.resource.kind is ResourceKind.PROCESS
        for entry in read_ledger(tmp_path, RUN_ID).entries
    )


def test_cleanup_repairs_an_interrupted_empty_claim_and_releases_exact_ownership(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    runtime_path = tmp_path / ".nexus-test/runtime.json"
    interrupted = json.loads(runtime_path.read_text(encoding="utf-8"))
    interrupted["owned_run_ids"] = [RUN_ID]
    runtime_path.write_text(json.dumps(interrupted), encoding="utf-8")

    clean_run(tmp_path, TEST_ENV, RUN_ID)

    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    assert runtime["owned_run_ids"] == []
    assert not (tmp_path / ".nexus-test/runs" / RUN_ID).exists()


def test_cleanup_attempts_every_resource_and_retains_only_failed_ownership(
    tmp_path: Path,
) -> None:
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    claim_run(tmp_path, TEST_ENV, RUN_ID)
    recoverable = Resource(
        ResourceKind.EXTENSION_PROFILE,
        extension_profile_identity(RUN_ID, "recoverable"),
    )
    unsafe = Resource(
        ResourceKind.EXTENSION_PROFILE,
        extension_profile_identity(RUN_ID, "unsafe"),
    )
    record_planned(
        tmp_path,
        TEST_ENV,
        RUN_ID,
        recoverable,
        scenario_id="recoverable",
    )
    record_planned(tmp_path, TEST_ENV, RUN_ID, unsafe, scenario_id="unsafe")
    recoverable_path = tmp_path / recoverable.identity
    recoverable_path.mkdir(parents=True)
    foreign = tmp_path / "foreign-profile"
    foreign.mkdir()
    sentinel = foreign / "sentinel.txt"
    sentinel.write_text("preserve\n", encoding="utf-8")
    unsafe_path = tmp_path / unsafe.identity
    unsafe_path.symlink_to(foreign, target_is_directory=True)

    with pytest.raises(ExceptionGroup, match=f"run {RUN_ID} cleanup failed"):
        clean_run(tmp_path, TEST_ENV, RUN_ID)

    assert not recoverable_path.exists()
    assert sentinel.read_text(encoding="utf-8") == "preserve\n"
    assert [entry.resource for entry in read_ledger(tmp_path, RUN_ID).entries] == [unsafe]

    unsafe_path.unlink()
    unsafe_path.mkdir()
    clean_run(tmp_path, TEST_ENV, RUN_ID)
    assert not (tmp_path / ".nexus-test/runs" / RUN_ID).exists()


def test_extension_redirect_id_is_derived_from_the_staged_public_key() -> None:
    digest = hashlib.sha256(base64.b64decode(TEST_EXTENSION_PUBLIC_KEY)).digest()
    extension_id = "".join(
        chr(ord("a") + nibble) for byte in digest[:16] for nibble in (byte >> 4, byte & 15)
    )

    assert extension_id == TEST_EXTENSION_ID


def test_clean_removes_only_the_exact_recorded_workspace_runtime(tmp_path: Path) -> None:
    runtime = initialize_runtime(tmp_path, TEST_ENV, _ports())
    supabase_config = Path(runtime.supabase_workdir) / "supabase/config.toml"
    supabase_config.parent.mkdir(parents=True)
    supabase_config.write_text("project_id = 'test'\n", encoding="utf-8")
    foreign = tmp_path / "foreign-sentinel"
    foreign.write_text("preserve", encoding="utf-8")
    commands: list[tuple[str, ...]] = []

    def run_command(command: tuple[str, ...], *, cwd: Path) -> subprocess.CompletedProcess[str]:
        assert cwd == tmp_path
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    assert clean_owned_runtime(tmp_path, TEST_ENV, command_runner=run_command) == ()

    assert commands == [
        (
            "supabase",
            "--workdir",
            runtime.supabase_workdir,
            "stop",
            "--project-id",
            runtime.compose_project,
            "--no-backup",
            "--yes",
        ),
        (
            "docker",
            "compose",
            "--project-name",
            runtime.compose_project,
            "--file",
            str(tmp_path / "docker" / "docker-compose.test.yml"),
            "down",
            "--volumes",
            "--remove-orphans",
        ),
    ]
    assert not (tmp_path / ".nexus-test").exists()
    assert foreign.read_text(encoding="utf-8") == "preserve"


def test_clean_upgrades_then_removes_the_exact_previous_runtime(
    tmp_path: Path,
) -> None:
    runtime = initialize_runtime(tmp_path, TEST_ENV, _ports())
    runtime_path = tmp_path / ".nexus-test/runtime.json"
    previous = json.loads(runtime_path.read_text(encoding="utf-8"))
    previous["version"] = 3
    del previous["ports"]["agent_tools_mcp"]
    runtime_path.write_text(json.dumps(previous), encoding="utf-8")
    commands: list[tuple[str, ...]] = []

    def run_command(command: tuple[str, ...], *, cwd: Path) -> subprocess.CompletedProcess[str]:
        assert cwd == tmp_path
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    assert (
        clean_owned_runtime(
            tmp_path,
            TEST_ENV,
            command_runner=run_command,
            port_available=lambda port: port == 18001,
        )
        == ()
    )

    assert [command[0] for command in commands] == ["docker"]
    assert not (tmp_path / ".nexus-test").exists()
    assert runtime.compose_project in commands[0]


def test_clean_attempts_compose_and_retains_ownership_when_supabase_stop_fails(
    tmp_path: Path,
) -> None:
    runtime = initialize_runtime(tmp_path, TEST_ENV, _ports())
    supabase_config = Path(runtime.supabase_workdir) / "supabase/config.toml"
    supabase_config.parent.mkdir(parents=True)
    supabase_config.write_text("project_id = 'test'\n", encoding="utf-8")
    commands: list[tuple[str, ...]] = []

    def run_command(command: tuple[str, ...], *, cwd: Path) -> subprocess.CompletedProcess[str]:
        assert cwd == tmp_path
        commands.append(command)
        if command[0] == "supabase":
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, "", "")

    with pytest.raises(RuntimeContractError, match="Supabase teardown failed"):
        clean_owned_runtime(tmp_path, TEST_ENV, command_runner=run_command)

    assert [command[0] for command in commands] == ["supabase", "docker"]
    assert (tmp_path / ".nexus-test/runtime.json").is_file()
