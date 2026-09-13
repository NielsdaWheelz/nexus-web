from __future__ import annotations

import importlib.util
import json
import shutil
import signal
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

from tests.testkit.host_oracle_reconcile import HostOracleReconcileHarness

REPO_ROOT = Path(__file__).parents[3]
SOURCE_SHA = "1" * 40
REPAIR_SHA = "2" * 40
OTHER_SHA = "3" * 40
ORACLE_DIGEST = "sha256:" + "a" * 64
CONFIG_DIGEST = "b" * 64
ORACLE_PHASES = (
    "Prepared",
    "WritersStopped",
    "Unpublished",
    "SupportReconciled",
    "Published",
    "RuntimeRestored",
    "Succeeded",
)


def _release_module() -> ModuleType:
    path = REPO_ROOT / "deploy/hetzner/release.py"
    spec = importlib.util.spec_from_file_location("nexus_oracle_host_release", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _containers(module: ModuleType):
    return {
        service: module.ContainerEvidence(
            container_id=character * 64,
            image="sha256:" + character * 64,
            config_sha256=character * 64,
        )
        for service, character in (
            ("api", "3"),
            ("worker-interactive", "4"),
            ("worker-background", "5"),
        )
    }


def _prepared(module: ModuleType):
    return module.OracleAttempt.prepared(
        source_sha=SOURCE_SHA,
        expected_manifest_digest=ORACLE_DIGEST,
        config_path=f"/etc/nexus/config/{CONFIG_DIGEST}.env",
        config_sha256=CONFIG_DIGEST,
        prior_marker=module.OracleMarkerPresent(
            manifest_digest="sha256:" + "c" * 64,
            embedding_provider="openai",
            embedding_model="text-embedding-3-small",
        ),
        containers=_containers(module),
        now="2026-08-06T12:00:00Z",
    )


def _status_payload(*, published: bool = True) -> dict[str, object]:
    return {
        "status": "published" if published else "ready_unpublished",
        "manifest_digest": ORACLE_DIGEST,
        "embedding_provider": "openai",
        "embedding_model": "text-embedding-3-small",
        "support_ready": True,
        "published": published,
        "publication": (
            {
                "corpus_key": "current",
                "manifest_digest": ORACLE_DIGEST,
                "embedding_provider": "openai",
                "embedding_model": "text-embedding-3-small",
            }
            if published
            else None
        ),
        "errors": [],
        "removals": {
            "work_keys": [],
            "anchor_keys": [],
            "plate_source_urls": [],
        },
        "counts": {
            "works": 3,
            "ready_media": 3,
            "anchors": 5,
            "resolved_anchors": 5,
            "plates": 2,
            "ready_plates": 2,
        },
    }


@pytest.fixture
def host_oracle_reconcile_harness(
    tmp_path: Path,
) -> Iterator[HostOracleReconcileHarness]:
    with HostOracleReconcileHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        source_sha=SOURCE_SHA,
        oracle_digest=ORACLE_DIGEST,
    ) as harness:
        yield harness


def _result(completed) -> str:
    value = json.loads(completed.stdout)
    assert isinstance(value, dict)
    result = value.get("result")
    assert isinstance(result, str)
    return result


def _assert_exact_writer_calls(
    harness: HostOracleReconcileHarness,
    calls: list[list[str]],
) -> None:
    expected = set(harness.writer_ids())
    assert calls
    assert all(set(call) == expected and len(call) == len(expected) for call in calls)


def _assert_same_target_convergence(harness: HostOracleReconcileHarness) -> None:
    state = harness.state()
    assert harness.attempt()["phase"] == "Succeeded"
    assert state["markers"] == list(ORACLE_PHASES)
    assert state["effect_order"] == ["unpublish", "reconcile-support", "publish"]
    assert state["unsafe_effects"] == {
        "publish": 1,
        "reconcile-support": 1,
        "unpublish": 1,
    }
    assert state["jobs"] == {}
    assert state["oracle"] == {
        "publication": {
            "corpus_key": "current",
            "embedding_model": "text-embedding-3-small",
            "embedding_provider": "openai",
            "manifest_digest": ORACLE_DIGEST,
        },
        "published": True,
        "support_ready": True,
    }
    assert all(
        state["containers"][service]["running"]
        for service in (
            "api",
            "worker-interactive",
            "worker-background",
        )
    )
    _assert_exact_writer_calls(harness, state["stop_calls"])
    _assert_exact_writer_calls(harness, state["start_calls"])
    assert not tuple(harness.attempt_path.parent.glob("*.partial"))

    before = {
        "effect_invocations": dict(state["effect_invocations"]),
        "start_calls": list(state["start_calls"]),
        "stop_calls": list(state["stop_calls"]),
        "unsafe_effects": dict(state["unsafe_effects"]),
    }
    no_op = harness.run_reconcile()
    assert no_op.returncode == 0, no_op.stderr
    assert _result(no_op) == "NoOp"
    after = harness.state()
    assert {
        "effect_invocations": after["effect_invocations"],
        "start_calls": after["start_calls"],
        "stop_calls": after["stop_calls"],
        "unsafe_effects": after["unsafe_effects"],
    } == before


@pytest.mark.parametrize("phase", ORACLE_PHASES)
def test_host_oracle_reconcile_replays_every_durable_phase_after_sigkill(
    host_oracle_reconcile_harness: HostOracleReconcileHarness,
    phase: str,
) -> None:
    harness = host_oracle_reconcile_harness

    interrupted = harness.run_reconcile(interrupt_phase=phase)

    assert interrupted.returncode == -signal.SIGKILL, (
        f"expected process death at {phase}; stdout={interrupted.stdout!r}; "
        f"stderr={interrupted.stderr!r}"
    )
    assert harness.attempt()["phase"] == phase

    replayed = harness.run_reconcile(interrupt_phase=phase)

    assert replayed.returncode == 0, replayed.stderr
    assert _result(replayed) == ("NoOp" if phase == "Succeeded" else "Succeeded")
    state = harness.state()
    assert state["effect_invocations"] == {
        "publish": 1,
        "reconcile-support": 1,
        "unpublish": 1,
    }
    assert len(state["stop_calls"]) == 1
    assert len(state["start_calls"]) == 1
    _assert_same_target_convergence(harness)


@pytest.mark.parametrize(
    ("effect", "persisted_phase"),
    (
        ("unpublish", "WritersStopped"),
        ("reconcile-support", "Unpublished"),
        ("publish", "SupportReconciled"),
        ("runtime-restore", "Published"),
    ),
)
def test_host_oracle_reconcile_converges_after_success_before_phase_write(
    host_oracle_reconcile_harness: HostOracleReconcileHarness,
    effect: str,
    persisted_phase: str,
) -> None:
    harness = host_oracle_reconcile_harness

    interrupted = harness.run_reconcile(interrupt_after_effect=effect)

    assert interrupted.returncode == -signal.SIGKILL, (
        f"expected process death after {effect}; stdout={interrupted.stdout!r}; "
        f"stderr={interrupted.stderr!r}"
    )
    assert harness.attempt()["phase"] == persisted_phase
    interrupted_state = harness.state()
    assert interrupted_state["jobs"] == {}
    if effect in interrupted_state["unsafe_effects"]:
        assert interrupted_state["unsafe_effects"][effect] == 1
    else:
        assert all(
            interrupted_state["containers"][service]["running"]
            for service in ("api", "worker-interactive", "worker-background")
        )

    replayed = harness.run_reconcile(interrupt_after_effect=effect)

    assert replayed.returncode == 0, replayed.stderr
    assert _result(replayed) == "Succeeded"
    state = harness.state()
    if effect in state["effect_invocations"]:
        assert state["effect_invocations"][effect] == 2
    assert len(state["stop_calls"]) == (2 if effect == "runtime-restore" else 1)
    assert len(state["start_calls"]) == (2 if effect == "runtime-restore" else 1)
    _assert_same_target_convergence(harness)


def test_oracle_attempt_is_a_strict_linear_durable_union() -> None:
    release = _release_module()
    attempt = _prepared(release)

    with pytest.raises(release.ReleaseDefect, match="Oracle transition"):
        attempt.advance(
            release.OraclePhase.SupportReconciled,
            now="2026-08-06T12:01:00Z",
        )

    for phase in (
        release.OraclePhase.WritersStopped,
        release.OraclePhase.Unpublished,
        release.OraclePhase.SupportReconciled,
        release.OraclePhase.Published,
        release.OraclePhase.RuntimeRestored,
        release.OraclePhase.Succeeded,
    ):
        attempt = attempt.advance(phase, now="2026-08-06T12:01:00Z")

    encoded = release._canonical_json(attempt.as_json())
    decoded = release.OracleAttempt.from_json(json.loads(encoded))

    assert decoded == attempt
    assert decoded.terminal
    assert decoded.target_name == f"{SOURCE_SHA}-{'a' * 64}"

    malformed = attempt.as_json()
    malformed["unexpected"] = True
    with pytest.raises(release.ReleaseDefect, match="Oracle attempt fields"):
        release.OracleAttempt.from_json(malformed)


def test_oracle_attempt_defers_config_root_binding_to_the_host(tmp_path: Path) -> None:
    release = _release_module()
    config_path = tmp_path / "etc/nexus/config" / f"{CONFIG_DIGEST}.env"

    attempt = release.OracleAttempt.prepared(
        source_sha=SOURCE_SHA,
        expected_manifest_digest=ORACLE_DIGEST,
        config_path=str(config_path),
        config_sha256=CONFIG_DIGEST,
        prior_marker=release.OracleMarkerAbsent(),
        containers=_containers(release),
        now="2026-08-06T12:00:00Z",
    )

    assert attempt.config_path == str(config_path)


def test_nonterminal_oracle_attempt_blocks_every_other_host_mutation(
    tmp_path: Path,
) -> None:
    release = _release_module()
    store = release.ReleaseStore(release.ReleasePaths.under(tmp_path))
    attempt = _prepared(release)
    store.create_oracle_attempt(attempt)

    assert store.active_oracle_attempt() == attempt
    with pytest.raises(release.ReleaseBlocked, match="Oracle attempt"):
        store.assert_no_oracle_attempt()
    with pytest.raises(release.ReleaseBlocked, match=SOURCE_SHA):
        store.require_oracle_target(OTHER_SHA, ORACLE_DIGEST)

    resumed = store.require_oracle_target(SOURCE_SHA, ORACLE_DIGEST)
    assert resumed == attempt

    for phase in (
        release.OraclePhase.WritersStopped,
        release.OraclePhase.Unpublished,
        release.OraclePhase.SupportReconciled,
        release.OraclePhase.Published,
        release.OraclePhase.RuntimeRestored,
        release.OraclePhase.Succeeded,
    ):
        attempt = attempt.advance(phase, now="2026-08-06T12:02:00Z")
        store.replace_oracle_attempt(attempt)

    assert store.active_oracle_attempt() is None
    assert store.assert_no_oracle_attempt() is None


def test_nonterminal_oracle_attempt_blocks_app_release_and_config_publication(
    tmp_path: Path,
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    store = release.ReleaseStore(paths)
    store.create_oracle_attempt(_prepared(release))
    host = release.HostRelease(paths)

    with pytest.raises(release.ReleaseBlocked, match="Oracle attempt"):
        host.apply(
            source_sha=OTHER_SHA,
            deployment_id="dpl_1234567890",
            production_host="nexus.example.test",
        )
    with pytest.raises(release.ReleaseBlocked, match="Oracle attempt"):
        host.finalize(
            source_sha=OTHER_SHA,
            deployment_id="dpl_1234567890",
        )

    source = tmp_path / "next.env"
    source.write_text("NEXUS_ENV=production\n", encoding="utf-8")
    with pytest.raises(release.ReleaseBlocked, match="Oracle attempt"):
        release.publish_config(source, store, next_source_sha=OTHER_SHA)


def test_oracle_status_decoder_accepts_only_exact_healthy_publication() -> None:
    release = _release_module()
    payload = _status_payload()

    status = release.parse_oracle_status(release._canonical_json(payload))

    assert status.is_exact_publication(ORACLE_DIGEST)
    assert status.prior_marker == release.OracleMarkerPresent(
        manifest_digest=ORACLE_DIGEST,
        embedding_provider="openai",
        embedding_model="text-embedding-3-small",
    )

    payload["unexpected"] = True
    with pytest.raises(release.ReleaseDefect, match="Oracle status fields"):
        release.parse_oracle_status(release._canonical_json(payload))

    unpublished = release.parse_oracle_status(
        release._canonical_json(_status_payload(published=False))
    )
    assert not unpublished.is_exact_publication(ORACLE_DIGEST)
    assert unpublished.prior_marker == release.OracleMarkerAbsent()

    drifted_payload = _status_payload(published=False)
    drifted_payload["publication"] = {
        "corpus_key": "current",
        "manifest_digest": "sha256:" + "d" * 64,
        "embedding_provider": "openai",
        "embedding_model": "text-embedding-3-small",
    }
    drifted = release.parse_oracle_status(release._canonical_json(drifted_payload))
    assert isinstance(drifted.prior_marker, release.OracleMarkerPresent)
    assert not drifted.is_exact_publication(ORACLE_DIGEST)


def test_oracle_attempt_state_is_canonical_and_power_loss_safe(tmp_path: Path) -> None:
    release = _release_module()
    store = release.ReleaseStore(release.ReleasePaths.under(tmp_path))
    attempt = _prepared(release)
    store.create_oracle_attempt(attempt)
    path = store.paths.oracle_attempts / f"{attempt.target_name}.json"

    assert path.read_bytes() == release._canonical_json(attempt.as_json())
    assert not tuple(store.paths.oracle_attempts.glob("*.partial"))

    path.write_text(json.dumps(attempt.as_json()), encoding="utf-8")
    with pytest.raises(release.ReleaseDefect, match="canonical JSON"):
        store.load_oracle_attempt(SOURCE_SHA, ORACLE_DIGEST)


@pytest.mark.parametrize(
    "effect",
    ("unpublish", "reconcile-support", "publish", "runtime-restore"),
)
def test_fixed_oracle_controller_replays_target_attempt_after_crash(
    host_oracle_reconcile_harness: HostOracleReconcileHarness,
    effect: str,
) -> None:
    harness = host_oracle_reconcile_harness
    defective = harness.run_reconcile(interrupt_phase="Prepared")
    assert defective.returncode == -signal.SIGKILL, defective.stderr
    assert harness.attempt()["phase"] == "Prepared"

    installed = harness.install_repair()
    assert installed.returncode == 0, installed.stderr
    binding = harness.repair()
    assert binding == json.loads(installed.stdout)
    assert binding["target_source_sha"] == SOURCE_SHA
    assert binding["target_manifest_digest"] == ORACLE_DIGEST
    assert binding["expected_database_revision"] == "0211"
    assert binding["repair_source_sha"] == REPAIR_SHA
    assert harness.repair_path.read_bytes() == _release_module()._canonical_json(binding)
    before_repair_execution = len(harness.state()["oracle_execution_sources"])

    interrupted = harness.run_reconcile(repair=True, interrupt_after_effect=effect)
    assert interrupted.returncode == -signal.SIGKILL, (
        f"expected repaired controller death after {effect}; "
        f"stdout={interrupted.stdout!r}; stderr={interrupted.stderr!r}"
    )
    replayed = harness.run_reconcile(repair=True, interrupt_after_effect=effect)
    assert replayed.returncode == 0, replayed.stderr
    assert _result(replayed) == "Succeeded"

    state = harness.state()
    assert harness.attempt()["phase"] == "Succeeded"
    assert state["markers"] == list(ORACLE_PHASES)
    repaired_executions = state["oracle_execution_sources"][before_repair_execution:]
    assert repaired_executions
    repair_candidate = json.loads(
        (harness.repair_bundle / "candidate-manifest.json").read_text(encoding="utf-8")
    )
    assert all(
        execution["api_image"] == repair_candidate["images"]["api"]
        and execution["worker_image"] == repair_candidate["images"]["worker"]
        and execution["compose_file"]
        == str(harness.root / "opt/nexus/releases" / SOURCE_SHA / "docker-compose.yml")
        for execution in repaired_executions
    )
    repair_job_prefix = f"nexus-oracle-{SOURCE_SHA}-repair-{REPAIR_SHA}-"
    assert any(
        repair_job_prefix in argument for command in state["commands"] for argument in command
    )
    _assert_exact_writer_calls(harness, state["stop_calls"])
    _assert_exact_writer_calls(harness, state["start_calls"])

    release = _release_module()
    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    assert store.current_sha() == SOURCE_SHA
    assert store.load_attempt(REPAIR_SHA) is None
    assert store.load_record(REPAIR_SHA) is None
    assert store.load_oracle_repair(SOURCE_SHA, ORACLE_DIGEST) is not None

    explicit_no_op = harness.run_reconcile(repair=True)
    assert explicit_no_op.returncode == 0, explicit_no_op.stderr
    assert _result(explicit_no_op) == "NoOp"
    implicit_replay = harness.run_reconcile()
    assert implicit_replay.returncode != 0
    assert "immutable repair binding" in implicit_replay.stderr


def test_oracle_repair_binding_is_create_only_and_preserves_application_state(
    host_oracle_reconcile_harness: HostOracleReconcileHarness,
    tmp_path: Path,
) -> None:
    harness = host_oracle_reconcile_harness
    defective = harness.run_reconcile(interrupt_phase="Prepared")
    assert defective.returncode == -signal.SIGKILL, defective.stderr
    state_before_install = harness.state()

    installed = harness.install_repair()
    assert installed.returncode == 0, installed.stderr
    assert harness.state()["effect_invocations"] == state_before_install["effect_invocations"]
    assert harness.attempt()["phase"] == "Prepared"
    installed_bundle = harness.root / "opt/nexus/releases" / REPAIR_SHA
    assert sorted(
        path.relative_to(installed_bundle).as_posix()
        for path in installed_bundle.rglob("*")
        if path.is_file()
    ) == [
        "Caddyfile",
        "candidate-manifest.json",
        "docker-compose.yml",
        "python/nexus/__init__.py",
        "python/nexus/release_artifact.py",
        "release.py",
    ]

    repeated = harness.install_repair()
    assert repeated.returncode == 0, repeated.stderr
    assert json.loads(repeated.stdout) == harness.repair()

    alternate = tmp_path / "alternate-repair"
    shutil.copytree(harness.repair_bundle, alternate)
    manifest_path = alternate / "candidate-manifest.json"
    manifest_path.chmod(0o644)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["source_sha"] = OTHER_SHA
    manifest["source_ci_run_id"] = 37
    manifest["publisher_run_id"] = 38
    release = _release_module()
    manifest_path.write_bytes(release._canonical_json(manifest))
    rejected = harness.install_repair(bundle=alternate)
    assert rejected.returncode != 0
    assert REPAIR_SHA in rejected.stderr

    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    assert store.current_sha() == SOURCE_SHA
    assert store.load_record(REPAIR_SHA) is None
    assert store.load_record(OTHER_SHA) is None
    stored_repair = store.load_oracle_repair(SOURCE_SHA, ORACLE_DIGEST)
    assert stored_repair is not None
    assert stored_repair.repair_source_sha == REPAIR_SHA


def test_oracle_repair_cli_requires_explicit_target_and_execution_sources() -> None:
    parser = _release_module()._parser()

    install = parser.parse_args(
        [
            "install-oracle-repair-bundle",
            "--source",
            "/tmp/repair",
            "--target-source-sha",
            SOURCE_SHA,
        ]
    )
    assert install.source == Path("/tmp/repair")
    assert install.target_source_sha == SOURCE_SHA

    reconcile = parser.parse_args(
        [
            "reconcile-oracle",
            "--source-sha",
            SOURCE_SHA,
            "--execution-source-sha",
            REPAIR_SHA,
        ]
    )
    assert reconcile.source_sha == SOURCE_SHA
    assert reconcile.execution_source_sha == REPAIR_SHA


def test_oracle_entrypoint_is_thin_and_invokes_only_the_immutable_controller() -> None:
    script = (REPO_ROOT / "deploy/hetzner/reconcile-oracle.sh").read_text(encoding="utf-8")

    assert "reconcile-oracle --source-sha" in script
    assert "--repair-source-sha" in script
    assert "install-oracle-repair-bundle" in script
    assert "--execution-source-sha" in script
    assert 'REMOTE_BUNDLE="/opt/nexus/releases/${EXECUTION_SOURCE_SHA}"' in script
    assert 'REMOTE_CONTROLLER="${REMOTE_BUNDLE}/release.py"' in script
    assert '"PYTHONPATH=${REMOTE_BUNDLE}/python"' in script
    assert "nexus.ops.oracle_reconcile" not in script
    assert "rsync" not in script
