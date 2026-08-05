"""Contract proofs for the opt-in Android authenticated visual lane.

Risk focus (testing-standards §4): auth/privacy/secret leakage and the
fail-closed device boundary. These proofs exercise the pure validators, the
auth-session broker request shape, the redacted evidence manifest, and the
NOT_RUN/FAIL/PASS classification without a physical device — the device
boundary itself runs only under the explicit ``android-visual`` capability.
"""

import hashlib
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

import pytest

from nexus.services.auth_handoff_codes import _hash as server_challenge_hash
from nexus_test_control import android_visual as av
from nexus_test_control.cli import AndroidVisualRequest, parse_command
from nexus_test_control.model import (
    DEFERRED_CAPABILITY_OWNER,
    WORKFLOW_REGISTRY,
    Capability,
    RunStatus,
    SelectionScope,
    Workflow,
)

HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
RUN_ID = "0123456789abcdef"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ("git", *args), cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _worktree(tmp_path: Path, *, branch: str = "nexus-work", dirty: bool = False) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "dev@example.invalid")
    _git(repo, "config", "user.name", "Dev")
    (repo / "README.md").write_text("nexus\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "init")
    _git(repo, "branch", "-m", branch)
    if dirty:
        (repo / "README.md").write_text("nexus edited\n", encoding="utf-8")
    return repo


def _visual_environment(repo: Path, **overrides: str) -> dict[str, str]:
    environment = {
        "NEXUS_ENV": "test",
        "NEXUS_ANDROID_VISUAL_SHA": _git(repo, "rev-parse", "HEAD"),
        "NEXUS_ANDROID_VISUAL_PATH": "/reader/library",
        "NEXUS_ANDROID_VISUAL_DEVICE": "primary",
    }
    environment.update(overrides)
    return environment


# --- Ownership: opt-in only, never in an automated workflow ------------------


def test_android_visual_workflow_requires_only_its_own_capability() -> None:
    requirements = WORKFLOW_REGISTRY[Workflow.ANDROID_VISUAL].requirements
    assert requirements == (av_requirement := requirements[0],) and len(requirements) == 1
    assert av_requirement.capability is Capability.ANDROID_VISUAL
    assert av_requirement.scope is SelectionScope.COMPLETE


def test_android_visual_is_absent_from_every_automated_and_deferred_lane() -> None:
    for workflow in (
        Workflow.CHANGED,
        Workflow.CONFIDENCE,
        Workflow.PR,
        Workflow.FULL,
        Workflow.NIGHTLY,
        Workflow.RELEASE,
    ):
        capabilities = {
            requirement.capability for requirement in WORKFLOW_REGISTRY[workflow].requirements
        }
        assert Capability.ANDROID_VISUAL not in capabilities, workflow.value
    assert Capability.ANDROID_VISUAL not in DEFERRED_CAPABILITY_OWNER


# --- CLI: strict argument validation ----------------------------------------


def test_cli_parses_head_sha_owned_path_and_defaults_device_to_primary() -> None:
    command = parse_command(["android-visual", "--sha", HEAD_SHA, "--path", "/reader/x"])
    assert command.workflow is Workflow.ANDROID_VISUAL
    assert command.android_visual == AndroidVisualRequest(HEAD_SHA, "/reader/x", "primary")


def test_cli_rejects_a_sha_that_is_not_forty_lowercase_hex() -> None:
    for bad_sha in ("HEAD", "abc", HEAD_SHA.upper(), HEAD_SHA + "0"):
        with pytest.raises(SystemExit):
            parse_command(["android-visual", "--sha", bad_sha, "--path", "/x"])


@pytest.mark.parametrize(
    "bad_path",
    [
        "https://evil.example/reader",
        "//evil.example/reader",
        "/reader/../../etc/passwd",
        "reader/library",
        "/reader?next=/admin",
        "/reader#top",
        "/reader\\admin",
    ],
)
def test_cli_rejects_a_path_that_escapes_the_app_origin(bad_path: str) -> None:
    with pytest.raises(SystemExit):
        parse_command(["android-visual", "--sha", HEAD_SHA, "--path", bad_path])


def test_cli_rejects_an_unconfigured_device_alias() -> None:
    with pytest.raises(SystemExit):
        parse_command(["android-visual", "--sha", HEAD_SHA, "--path", "/x", "--device", "laptop"])


def test_cli_requires_both_sha_and_path() -> None:
    with pytest.raises(SystemExit):
        parse_command(["android-visual", "--path", "/x"])
    with pytest.raises(SystemExit):
        parse_command(["android-visual", "--sha", HEAD_SHA])


# --- Broker: stable identity and the exact handoff contract -----------------


def test_device_account_email_and_id_are_stable_and_test_namespaced() -> None:
    assert av.device_account_email("primary") == "nexus+android-visual+primary@example.invalid"
    assert av.device_account_id("primary") == av.device_account_id("primary")
    assert isinstance(av.device_account_id("primary"), UUID)
    with pytest.raises(ValueError):
        av.device_account_email("laptop")


def test_handoff_challenge_equals_the_servers_own_verifier_hash() -> None:
    # Oracle independence: the challenge the broker mints must equal the hash the
    # existing consume route computes, or the device could never sign in.
    verifier = "verifier-abc123_DEF-456"
    assert av.handoff_challenge(verifier) == server_challenge_hash(verifier)
    assert av.handoff_challenge(verifier) == hashlib.sha256(verifier.encode()).hexdigest()


def test_launch_uri_carries_the_code_and_verifier_as_query_only() -> None:
    uri = av.handoff_launch_uri("http://127.0.0.1:3000", "nx_hand_CODE", "VERIF/IER+X")
    parts = urlsplit(uri)
    assert (parts.scheme, parts.netloc, parts.path) == ("http", "127.0.0.1:3000", "/auth/handoff")
    query = parse_qs(parts.query)
    assert query == {"code": ["nx_hand_CODE"], "hv": ["VERIF/IER+X"]}


def test_mint_request_carries_bearer_internal_header_and_the_challenge() -> None:
    url, headers, body = av.mint_handoff_request(
        "http://127.0.0.1:8000", "internal-secret", "ACCESS", "REFRESH", "VERIF"
    )
    assert url == "http://127.0.0.1:8000/auth/handoff-codes"
    assert headers["Authorization"] == "Bearer ACCESS"
    assert headers["X-Nexus-Internal"] == "internal-secret"
    assert headers["X-Request-ID"]
    assert body == {
        "access_token": "ACCESS",
        "refresh_token": "REFRESH",
        "challenge": av.handoff_challenge("VERIF"),
    }


@pytest.mark.parametrize("path", ["/", "/reader/library", "/reader/abc-123_view", "/a%20b"])
def test_validate_owned_path_accepts_owned_same_origin_paths(path: str) -> None:
    assert av.validate_owned_path(path) == path


@pytest.mark.parametrize(
    "path",
    ["", "reader", "//host/x", "/x?y=1", "/x#f", "/../x", "http://x/y", "/x\\y", "/x'y"],
)
def test_validate_owned_path_rejects_foreign_or_unsafe_paths(path: str) -> None:
    with pytest.raises(ValueError):
        av.validate_owned_path(path)


def test_device_session_established_requires_a_non_login_page_on_the_owned_origin() -> None:
    origin = "http://127.0.0.1:3000"
    assert av.device_session_established(
        [{"type": "page", "url": f"{origin}/reader/library?x=1"}], origin
    )
    # A signed-out device is redirected to /login → the proof must fail.
    assert not av.device_session_established(
        [{"type": "page", "url": f"{origin}/login?next=%2F"}], origin
    )
    assert not av.device_session_established(
        [{"type": "page", "url": f"{origin}/auth/handoff?code=x"}], origin
    )
    # A foreign origin (e.g. a production build) must not satisfy a local check.
    assert not av.device_session_established(
        [{"type": "page", "url": "https://nexus.example.com/reader/library"}], origin
    )
    assert not av.device_session_established(
        [{"type": "worker", "url": f"{origin}/reader/library"}], origin
    )
    assert not av.device_session_established("not-a-list", origin)


def test_device_session_code_hash_equals_the_servers_stored_code_hash() -> None:
    # The fail-closed 'handoff consumed' gate polls for a row whose code_hash the
    # server wrote with its own _hash(code). If these drift, the gate fails open.
    session = _device_session()
    assert session.code_hash == server_challenge_hash(session.code)
    assert session.code_hash == hashlib.sha256(session.code.encode()).hexdigest()


# --- Native fingerprint: rebuild only when native inputs change --------------


def _fake_android_tree(root: Path) -> None:
    app = root / "apps/android/app/src/main"
    app.mkdir(parents=True)
    (root / "apps/android/app/build.gradle.kts").write_text("plugins {}\n", encoding="utf-8")
    (app / "Main.kt").write_text("package app.nexus.android\n", encoding="utf-8")
    build_output = root / "apps/android/app/build/outputs/apk/debug"
    build_output.mkdir(parents=True)
    (build_output / "app-debug.apk").write_bytes(b"ignored-binary")


def test_native_input_fingerprint_is_sensitive_to_sources_and_flags(tmp_path: Path) -> None:
    _fake_android_tree(tmp_path)
    flags = {"nexusAndroidDebugBaseUrl": "http://127.0.0.1:3000"}
    base = av.native_input_fingerprint(tmp_path, flags)
    assert base == av.native_input_fingerprint(tmp_path, flags)

    (tmp_path / "apps/android/app/src/main/Main.kt").write_text("package x\n", encoding="utf-8")
    assert av.native_input_fingerprint(tmp_path, flags) != base

    reverted = av.native_input_fingerprint(tmp_path, flags)
    (tmp_path / "apps/android/app/src/main/Main.kt").write_text(
        "package app.nexus.android\n", encoding="utf-8"
    )
    assert av.native_input_fingerprint(tmp_path, flags) == base
    assert reverted != base  # the intermediate source really was fingerprinted


def test_native_input_fingerprint_ignores_build_outputs(tmp_path: Path) -> None:
    _fake_android_tree(tmp_path)
    flags = {"nexusAndroidDebugBaseUrl": "http://127.0.0.1:3000"}
    before = av.native_input_fingerprint(tmp_path, flags)
    (tmp_path / "apps/android/app/build/outputs/apk/debug/app-debug.apk").write_bytes(b"rebuilt")
    assert av.native_input_fingerprint(tmp_path, flags) == before


def test_native_input_fingerprint_changes_with_a_debug_flag(tmp_path: Path) -> None:
    _fake_android_tree(tmp_path)
    a = av.native_input_fingerprint(tmp_path, {"nexusAndroidDebugBaseUrl": "http://127.0.0.1:3000"})
    b = av.native_input_fingerprint(tmp_path, {"nexusAndroidDebugBaseUrl": "http://127.0.0.1:4000"})
    assert a != b


# --- Worktree source identity -----------------------------------------------


def test_worktree_source_records_head_and_no_diff_when_clean(tmp_path: Path) -> None:
    repo = _worktree(tmp_path)
    source = av.worktree_source(repo)
    assert source["branch"] == "nexus-work"
    assert source["head_sha"] == _git(repo, "rev-parse", "HEAD")
    assert source["dirty"] is False
    assert source["diff_sha256"] is None


def test_worktree_source_fingerprints_a_dirty_worktree_and_is_sensitive(tmp_path: Path) -> None:
    repo = _worktree(tmp_path, dirty=True)
    source = av.worktree_source(repo)
    assert source["dirty"] is True
    assert isinstance(source["diff_sha256"], str) and len(source["diff_sha256"]) == 64
    (repo / "README.md").write_text("nexus edited differently\n", encoding="utf-8")
    assert av.worktree_source(repo)["diff_sha256"] != source["diff_sha256"]


def test_worktree_source_refuses_an_operation_in_progress(tmp_path: Path) -> None:
    repo = _worktree(tmp_path)
    (repo / ".git/MERGE_HEAD").write_text(_git(repo, "rev-parse", "HEAD") + "\n", encoding="utf-8")
    with pytest.raises(av._Fail):
        av.worktree_source(repo)


# --- Evidence manifest: never leaks a secret --------------------------------


def _device_session() -> av.DeviceSession:
    return av.DeviceSession(
        alias="primary",
        user_id=UUID("22222222-2222-5222-8222-222222222222"),
        email="nexus+android-visual+primary@example.invalid",
        access_token="ACCESS-TOKEN-SECRET-eyJ",
        refresh_token="REFRESH-TOKEN-SECRET",
        code="nx_hand_CODE-SECRET",
        verifier="VERIFIER-SECRET",
    )


def test_visual_manifest_records_the_contract_and_leaks_no_secret(tmp_path: Path) -> None:
    session = _device_session()
    results = tmp_path / "test-results/runs" / RUN_ID
    results.mkdir(parents=True)
    relative = av._write_manifest(
        tmp_path,
        RUN_ID,
        source={"branch": "nexus-work", "head_sha": HEAD_SHA, "dirty": False, "diff_sha256": None},
        device={"api_level": "34", "webview_version": "14", "package": av.DEBUG_PACKAGE},
        serial="192.168.1.5:5555",
        reverse={3000: 41234, 8000: 48000},
        runtime_ports={"web": 41234, "api": 48000, "supabase": 49999},
        api_log=f"test-results/runs/{RUN_ID}/api.log",
        web_log=f"test-results/runs/{RUN_ID}/web.log",
        apk={"variant": "debug", "input_fingerprint": "a" * 64, "installed_fingerprint": "a" * 64},
        session=session,
        requested_path="/reader/library",
        screenshot=f"test-results/runs/{RUN_ID}/android-visual-screen.png",
        logcat=f"test-results/runs/{RUN_ID}/android-visual-logcat.txt",
    )
    raw = (tmp_path / relative).read_text(encoding="utf-8")
    for secret in session.secrets():
        assert secret not in raw, "manifest leaked a broker secret"

    manifest = json.loads(raw)
    assert manifest["schema_version"] == av.MANIFEST_VERSION
    assert manifest["auth"] == {
        "account_alias": "primary",
        "user_id": str(session.user_id),
        "handoff_consumed": True,
        "session_origin": "http://127.0.0.1:3000",
    }
    assert manifest["transport"]["reverse_mappings"] == {
        "tcp:3000": "tcp:41234",
        "tcp:8000": "tcp:48000",
    }
    assert manifest["source"]["head_sha"] == HEAD_SHA
    assert manifest["visual"]["requested_path"] == "/reader/library"


def test_manifest_redaction_scrubs_a_secret_that_would_otherwise_survive() -> None:
    # Sensitivity: prove the redaction layer the manifest relies on actually
    # removes a bearer token both as a raw value and behind a token-named key.
    from nexus_test_control.evidence import redact_json

    redacted = redact_json(
        {"note": "carrying ACCESS-TOKEN-SECRET-eyJ", "access_token": "ACCESS-TOKEN-SECRET-eyJ"},
        ("ACCESS-TOKEN-SECRET-eyJ",),
    )
    assert "ACCESS-TOKEN-SECRET-eyJ" not in json.dumps(redacted)


# --- Fail-closed classification (no physical device) ------------------------


def test_run_android_visual_fails_when_sha_is_not_head(tmp_path: Path) -> None:
    repo = _worktree(tmp_path)
    environment = _visual_environment(repo, NEXUS_ANDROID_VISUAL_SHA="f" * 40)
    outcome = av.run_android_visual(repo, environment, run_id=RUN_ID)
    assert outcome.status is RunStatus.FAIL
    assert "HEAD" in outcome.detail


def test_run_android_visual_fails_on_the_main_branch(tmp_path: Path) -> None:
    repo = _worktree(tmp_path, branch="main")
    outcome = av.run_android_visual(repo, _visual_environment(repo), run_id=RUN_ID)
    assert outcome.status is RunStatus.FAIL
    assert "main" in outcome.detail


def test_run_android_visual_fails_on_a_foreign_path(tmp_path: Path) -> None:
    repo = _worktree(tmp_path)
    environment = _visual_environment(repo, NEXUS_ANDROID_VISUAL_PATH="https://evil.example/x")
    outcome = av.run_android_visual(repo, environment, run_id=RUN_ID)
    assert outcome.status is RunStatus.FAIL


def test_run_android_visual_not_run_when_adb_is_absent(tmp_path: Path) -> None:
    repo = _worktree(tmp_path)
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    # No SDK and an empty PATH ⇒ no adb ⇒ the lane stops before touching any lock,
    # service, or device and reports NOT_RUN, never PASS.
    environment = _visual_environment(repo, PATH=str(empty))
    outcome = av.run_android_visual(repo, environment, run_id=RUN_ID)
    assert outcome.status is RunStatus.NOT_RUN
    assert "adb" in outcome.detail.lower()


def _serial_env(serial: str | None = None) -> dict[str, str]:
    env = {"NEXUS_ENV": "test", "PATH": os.environ.get("PATH", "")}
    if serial is not None:
        env["NEXUS_DEVICE_SERIAL"] = serial
    return env


def _fake_adb(tmp_path: Path, name: str, rows: list[str]) -> Path:
    directory = tmp_path / name
    directory.mkdir()
    listing = directory / "devices.txt"
    listing.write_text(
        "List of devices attached\n" + "".join(row + "\n" for row in rows), encoding="utf-8"
    )
    adb = directory / "adb"
    adb.write_text(
        f'#!/bin/sh\nif [ "$1" = "devices" ]; then cat "{listing}"; fi\n', encoding="utf-8"
    )
    adb.chmod(0o755)
    return adb


def test_resolve_serial_uses_the_single_authorized_device_when_no_serial_configured(
    tmp_path: Path,
) -> None:
    adb = _fake_adb(tmp_path, "one", ["10.0.0.5:5555\tdevice"])
    assert av.resolve_serial(adb, "primary", _serial_env(), tmp_path) == "10.0.0.5:5555"


def test_resolve_serial_fails_closed_on_zero_or_multiple_unconfigured_devices(
    tmp_path: Path,
) -> None:
    none = _fake_adb(tmp_path, "none", [])
    with pytest.raises(av._NotRun):
        av.resolve_serial(none, "primary", _serial_env(), tmp_path)
    many = _fake_adb(tmp_path, "many", ["10.0.0.5:5555\tdevice", "10.0.0.6:5555\tdevice"])
    with pytest.raises(av._NotRun):
        av.resolve_serial(many, "primary", _serial_env(), tmp_path)


def test_resolve_serial_rejects_a_configured_serial_that_is_not_authorized(tmp_path: Path) -> None:
    adb = _fake_adb(tmp_path, "unauth", ["10.0.0.5:5555\tunauthorized"])
    with pytest.raises(av._NotRun):
        av.resolve_serial(adb, "primary", _serial_env(serial="10.0.0.5:5555"), tmp_path)


def test_run_android_visual_refuses_a_non_test_product_environment(tmp_path: Path) -> None:
    repo = _worktree(tmp_path)
    environment = _visual_environment(repo, NEXUS_ENV="production")
    outcome = av.run_android_visual(repo, environment, run_id=RUN_ID)
    assert outcome.status is RunStatus.NOT_RUN
    assert "test environment" in outcome.detail
