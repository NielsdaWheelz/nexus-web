"""Subsequent release preflight recognizes ordinary Compose Codex services."""

import stat
from pathlib import Path
from types import SimpleNamespace

import pytest
from deploy.hetzner import release


@pytest.mark.parametrize(
    "project, service, oneoff, accepted",
    [
        ("nexus", "nexus-codex-agent-host", "False", True),
        ("nexus", "codex-egress-policy", "False", True),
        ("foreign", "nexus-codex-agent-host", "False", False),
        ("nexus", "unknown", "False", False),
        ("nexus", "nexus-codex-agent-host", None, False),
    ],
)
def test_host_preflight_recognizes_running_codex_compose_labels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    project: str,
    service: str,
    oneoff: str | None,
    accepted: bool,
) -> None:
    host = release.HostRelease(release.ReleasePaths.under(tmp_path))
    monkeypatch.setattr(host, "_host_text", lambda *_args: "memory")
    monkeypatch.setattr(
        host,
        "_host_memory_bytes",
        lambda: {"MemTotal": 2 * 1024**3, "MemAvailable": 1024**3, "SwapTotal": 1024**3},
    )
    monkeypatch.setattr(host, "_host_memory_pressure", lambda: {"some": 0.0, "full": 0.0})
    monkeypatch.setattr(
        Path,
        "lstat",
        lambda _path: SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=10001, st_gid=10001),
    )
    monkeypatch.setattr(release.shutil, "disk_usage", lambda _path: SimpleNamespace(free=1024**3))
    container_id = "a" * 64
    monkeypatch.setattr(
        release, "_stdout", lambda args: container_id if args[:2] == ("docker", "ps") else ""
    )
    monkeypatch.setattr(
        release,
        "_inspect_one",
        lambda *_args: {
            "Config": {
                "Labels": {
                    "com.docker.compose.project": project,
                    "com.docker.compose.service": service,
                    "com.docker.compose.oneoff": oneoff,
                }
            },
            "State": {"OOMKilled": False},
            "RestartCount": 0,
        },
    )

    if accepted:
        host._preflight_host_capacity({}, writers_running=True)
    else:
        with pytest.raises(release.ReleaseBlocked, match="unknown running container"):
            host._preflight_host_capacity({}, writers_running=True)
