from __future__ import annotations

import json
import subprocess
from pathlib import Path

import nexus_test_control.services as services
from nexus_test_control.runtime import RuntimePorts, initialize_runtime, read_runtime

TEST_ENV = {"NEXUS_ENV": "test"}
DEFAULT_PORTS = RuntimePorts(
    15432,
    19000,
    25421,
    25422,
    25423,
    25424,
    25425,
    18000,
    18001,
    13000,
    19091,
    19092,
    19093,
)


def test_linked_worktree_runtimes_reserve_every_persisted_port(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    linked = tmp_path / "linked"
    repository.mkdir()
    (repository / "README.md").write_text("fixture\n", encoding="utf-8")
    for command in (
        ("git", "init", "--quiet"),
        ("git", "config", "user.email", "nexus-test@example.test"),
        ("git", "config", "user.name", "Nexus Test"),
        ("git", "add", "README.md"),
        ("git", "commit", "--quiet", "-m", "fixture"),
        ("git", "worktree", "add", "--quiet", "--detach", str(linked), "HEAD"),
    ):
        subprocess.run(command, cwd=repository, check=True)
    initialize_runtime(linked, TEST_ENV, DEFAULT_PORTS)
    linked_runtime_path = linked / ".nexus-test/runtime.json"
    linked_runtime = json.loads(linked_runtime_path.read_text(encoding="utf-8"))
    linked_runtime["version"] = 5
    linked_runtime["ports"].update(
        {
            "agent_tools_mcp": 18001,
            "provider_api": 19093,
        }
    )
    linked_runtime_path.write_text(json.dumps(linked_runtime), encoding="utf-8")
    linked_ports = frozenset(linked_runtime["ports"].values())

    allocated = services._allocate_ports(repository, port_available=lambda _port: True)
    assert set(allocated.as_dict().values()).isdisjoint(linked_ports), (
        "a linked worktree's durable port reservation was reused"
    )

    initialize_runtime(repository, TEST_ENV, DEFAULT_PORTS)
    runtime_path = repository / ".nexus-test/runtime.json"
    previous = json.loads(runtime_path.read_text(encoding="utf-8"))
    previous["version"] = 4
    del previous["ports"]["provider_api"]
    runtime_path.write_text(json.dumps(previous), encoding="utf-8")

    services._upgrade_runtime_if_needed(
        repository,
        TEST_ENV,
        port_available=lambda _port: True,
    )

    assert read_runtime(repository).ports.provider_api not in linked_ports, (
        "a linked worktree's durable provider port reservation was reused"
    )
