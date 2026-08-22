"""Priority risk `android-player-protocol-skew`: the production release gate.

A new web candidate may mutate the host or Vercel only after GitHub's canonical
`releases/latest` pointer names one stable signed Android release whose
manifest-v2 player protocol identity equals the raw repository corpus. Durable
attempts resume, settle, and verify from the installed immutable bundle without
any GitHub dependency.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tests.testkit.production_deploy import (
    BOUND_DEPLOYMENT_ID,
    CURRENT_DEPLOYMENT_ID,
    ProductionDeployHarness,
)

REPO_ROOT = Path(__file__).parents[3]
CORPUS = REPO_ROOT / "testdata/android/player-protocol.json"
SOURCE_SHA = "1" * 40
CURRENT_SHA = "a" * 40
STABLE_TAG = "android-v0.2.14"
LATEST_RELEASE_API = "repos/NielsdaWheelz/nexus-web/releases/latest"


def _release_module() -> ModuleType:
    path = REPO_ROOT / "deploy/hetzner/release.py"
    spec = importlib.util.spec_from_file_location("nexus_android_player_release_gate", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _stable_manifest(player_protocol: dict[str, object]) -> dict[str, object]:
    version_name = STABLE_TAG.removeprefix("android-v")
    apk_digest = "d" * 64
    apk_names = ("nexus-android.apk", f"nexus-android-{version_name}.apk")
    return {
        "version": 2,
        "run_id": "android-release-test",
        "git_sha": "e" * 40,
        "tag": STABLE_TAG,
        "package": "app.nexus.android",
        "version_code": 17,
        "version_name": version_name,
        "signer_sha256": "c" * 64,
        "source_apk_sha256": apk_digest,
        "player_protocol": player_protocol,
        "assets": {
            name: (apk_digest if name in apk_names else "b" * 64)
            for name in (*apk_names, *(f"{name}.sha256" for name in apk_names))
        },
    }


def _write_manifest(path: Path, manifest: dict[str, object]) -> Path:
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


def test_release_manifest_decoder_accepts_only_the_exact_corpus_identity(
    tmp_path: Path,
) -> None:
    release = _release_module()
    corpus_identity = {
        "version": 2,
        "contract_sha256": hashlib.sha256(CORPUS.read_bytes()).hexdigest(),
    }
    path = _write_manifest(tmp_path / "release-manifest.json", _stable_manifest(corpus_identity))

    accepted = release.load_android_release_manifest(
        path,
        corpus=CORPUS,
        expected_tag=STABLE_TAG,
    )

    assert accepted.player_protocol.as_json() == corpus_identity


@pytest.mark.parametrize(
    ("manifest", "message"),
    [
        (
            _stable_manifest({"version": 2, "contract_sha256": "a" * 64}),
            "differs from the corpus",
        ),
        (
            _stable_manifest({"version": 1, "contract_sha256": "a" * 64}),
            "protocol version is unsupported",
        ),
        (
            {**_stable_manifest({"version": 2, "contract_sha256": "a" * 64}), "version": 1},
            "manifest version is unsupported",
        ),
        (
            {**_stable_manifest({"version": 2, "contract_sha256": "a" * 64}), "version": 2.0},
            "manifest version is unsupported",
        ),
        (
            {**_stable_manifest({"version": 2, "contract_sha256": "a" * 64}), "tag": "android-v0.0.1"},
            "tag differs from the selected stable release",
        ),
    ],
    ids=(
        "digest-skew",
        "player-protocol-v1",
        "manifest-v1",
        "manifest-version-float",
        "foreign-tag",
    ),
)
def test_release_manifest_decoder_rejects_noncurrent_or_legacy_manifests(
    tmp_path: Path,
    manifest: dict[str, object],
    message: str,
) -> None:
    release = _release_module()
    path = _write_manifest(tmp_path / "release-manifest.json", manifest)

    with pytest.raises(release.ReleaseDefect, match=message):
        release.load_android_release_manifest(path, corpus=CORPUS, expected_tag=STABLE_TAG)


def _inspect(
    *,
    status: str,
    phase: str | None = None,
    authoritative_bound_id: str | None = None,
) -> dict[str, object]:
    current_sha = SOURCE_SHA if status == "current" else CURRENT_SHA
    return {
        "current_sha": current_sha,
        "current_vercel_deployment_id": CURRENT_DEPLOYMENT_ID,
        "failed_vercel_deployment_ids": [],
        "forward_fix_sha": None,
        "phase": phase,
        "predecessor_sha": current_sha if (phase is not None or status == "new") else None,
        "status": status,
        "vercel_deployment_id": authoritative_bound_id,
    }


def _harness(tmp_path: Path, inspect: dict[str, object]) -> ProductionDeployHarness:
    return ProductionDeployHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        source_sha=SOURCE_SHA,
        host_inspect=inspect,
        authoritative_id=(
            str(inspect["vercel_deployment_id"])
            if inspect["status"] == "current"
            else CURRENT_DEPLOYMENT_ID
        ),
    )


def _events(state: dict[str, Any], command: str) -> list[list[str]]:
    return [event["arguments"] for event in state["events"] if event["command"] == command]


def _joined_events(state: dict[str, Any], command: str) -> list[str]:
    return [" ".join(arguments) for arguments in _events(state, command)]


def _github_contacts(state: dict[str, Any]) -> list[list[str]]:
    return [
        *_events(state, "gh"),
        *[arguments for arguments in _events(state, "git") if "fetch" in arguments],
    ]


def _assert_no_host_or_provider_mutation(state: dict[str, Any]) -> None:
    assert _events(state, "scp") == [], "bundle transfer began before the release gate"
    assert _events(state, "node") == [], "Vercel CLI ran before the release gate"
    assert _events(state, "curl") == [], "Vercel/production HTTP ran before the release gate"
    mutating_ssh = [
        command
        for command in _joined_events(state, "ssh")
        if not (
            "sudo test -x /opt/nexus/releases/" in command
            or " inspect --source-sha " in f" {command} "
        )
    ]
    assert mutating_ssh == [], f"host mutation began before the release gate: {mutating_ssh}"


@pytest.mark.parametrize(
    ("mode", "message"),
    [
        ("absent", "latest stable Android release manifest could not be retrieved"),
        ("malformed", "latest stable Android release manifest is incompatible with this source"),
        (
            "protocol-mismatch",
            "latest stable Android release manifest is incompatible with this source",
        ),
        ("wrong-tag", "latest stable Android release manifest is incompatible with this source"),
    ],
)
@pytest.mark.parametrize("bundle_installed", (False, True), ids=("fresh-host", "installed-bundle"))
def test_stable_android_manifest_preflight_stops_before_the_first_host_or_provider_mutation(
    tmp_path: Path,
    mode: str,
    message: str,
    bundle_installed: bool,
) -> None:
    harness = _harness(tmp_path, _inspect(status="new"))
    harness.update_state(android_manifest_mode=mode, bundle_installed=bundle_installed)

    failed = harness.run()

    assert failed.returncode != 0, "release proceeded past an incompatible stable Android manifest"
    assert message in failed.stderr
    state = harness.state()
    _assert_no_host_or_provider_mutation(state)
    ssh = _joined_events(state, "ssh")
    probes = ["sudo test -x /opt/nexus/releases/"]
    if bundle_installed:
        probes.append(" inspect --source-sha ")
    assert len(ssh) == len(probes)
    for command, probe in zip(ssh, probes, strict=True):
        assert probe in f" {command} "


def test_stable_android_manifest_preflight_uses_the_update_page_latest_pointer(
    tmp_path: Path,
) -> None:
    harness = _harness(tmp_path, _inspect(status="new"))

    completed = harness.run()

    assert completed.returncode == 0, completed.stderr
    state = harness.state()
    api_calls = [
        arguments
        for arguments in _events(state, "gh")
        if arguments[:1] == ["api"] and arguments[-1] == LATEST_RELEASE_API
    ]
    assert api_calls == [["api", LATEST_RELEASE_API]]
    downloads = [
        arguments for arguments in _events(state, "gh") if arguments[:2] == ["release", "download"]
    ]
    assert len(downloads) == 1
    assert downloads[0][2] == STABLE_TAG
    fetches = [arguments for arguments in _events(state, "git") if "fetch" in arguments]
    assert fetches, "a new candidate must prove it is origin/main"


@pytest.mark.parametrize(
    "updates",
    (
        {"draft": True},
        {"prerelease": True},
        {"tag_name": "web-v999.0.0"},
        {"assets": []},
        {
            "assets": [
                {"name": "release-manifest.json"},
                {"name": "release-manifest.json"},
            ]
        },
    ),
    ids=("draft", "prerelease", "non-android", "manifest-absent", "manifest-ambiguous"),
)
def test_stable_android_manifest_preflight_rejects_an_invalid_latest_pointer(
    tmp_path: Path,
    updates: dict[str, object],
) -> None:
    harness = _harness(tmp_path, _inspect(status="new"))
    latest = harness.state()["latest_android_release"]
    assert isinstance(latest, dict)
    harness.update_state(latest_android_release={**latest, **updates})

    failed = harness.run()

    assert failed.returncode != 0, "release proceeded past an invalid releases/latest pointer"
    assert "GitHub latest must be one stable Android release with one manifest" in failed.stderr
    state = harness.state()
    assert [
        arguments for arguments in _events(state, "gh") if arguments[:2] == ["release", "download"]
    ] == []
    _assert_no_host_or_provider_mutation(state)


@pytest.mark.parametrize(
    ("inspect", "include_provider_credentials"),
    [
        (
            _inspect(
                status="resume",
                phase="AwaitingFrontendPromotion",
                authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            ),
            True,
        ),
        (
            _inspect(
                status="resume",
                phase="RollbackRequired",
                authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            ),
            False,
        ),
        (
            _inspect(
                status="current",
                phase="Succeeded",
                authoritative_bound_id=CURRENT_DEPLOYMENT_ID,
            ),
            True,
        ),
    ],
    ids=("resume", "settlement", "current"),
)
def test_durable_attempt_paths_never_consult_github(
    tmp_path: Path,
    inspect: dict[str, object],
    include_provider_credentials: bool,
) -> None:
    harness = _harness(tmp_path, inspect)
    harness.update_state(android_manifest_mode="protocol-mismatch")

    completed = harness.run(include_provider_credentials=include_provider_credentials)

    state = harness.state()
    assert _github_contacts(state) == [], (
        f"{inspect['status']} consulted GitHub: {_github_contacts(state)}"
    )
    if inspect["phase"] == "RollbackRequired":
        assert completed.returncode != 0
        assert "durable failure settlement unexpectedly returned success" in completed.stderr
    else:
        assert completed.returncode == 0, completed.stderr
