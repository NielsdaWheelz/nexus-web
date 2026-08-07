"""Executable-boundary harness for immutable release bundle resolution."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PUBLISHER_RUN_ID = 7001
SOURCE_CI_RUN_ID = 6001
SOURCE_CI_WORKFLOW_ID = 5001
ARTIFACT_ID = 8001


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"


def _load_state(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError("release bundle harness state must be an object")
    return value


def _save_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(".partial")
    temporary.write_text(_canonical_json(state), encoding="utf-8")
    temporary.replace(path)


def _candidate(state: dict[str, Any]) -> dict[str, object]:
    candidate: dict[str, object] = {
        "expected_database_revision": "0211",
        "expected_oracle_manifest_digest": "sha256:" + "c" * 64,
        "images": {
            "api": "ghcr.io/nielsdawheelz/nexus-api@sha256:" + "a" * 64,
            "worker": "ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "b" * 64,
        },
        "publisher_run_attempt": 1,
        "publisher_run_id": state["manifest_publisher_run_id"],
        "repository": "NielsdaWheelz/nexus-web",
        "schema_version": 1,
        "source_ci_run_attempt": 1,
        "source_ci_run_id": SOURCE_CI_RUN_ID,
        "source_ci_workflow_id": SOURCE_CI_WORKFLOW_ID,
        "source_sha": state["source_sha"],
    }
    return candidate


def _fake_git(state: dict[str, Any], arguments: list[str]) -> None:
    if "status" in arguments or "fetch" in arguments:
        return
    if "rev-parse" in arguments:
        print(state["source_sha"])
        return
    raise AssertionError(f"unsupported fake git call: {arguments!r}")


def _artifact(state: dict[str, Any], *, expired: bool = False) -> dict[str, object]:
    return {
        "digest": "sha256:" + "d" * 64,
        "expired": expired,
        "id": ARTIFACT_ID + int(expired),
        "name": f"nexus-backend-release-{state['source_sha']}",
        "workflow_run": {"id": PUBLISHER_RUN_ID},
    }


def _copy_bundle(state: dict[str, Any], destination: Path) -> None:
    repo_root = Path(os.environ["NEXUS_RELEASE_BUNDLE_REPO"])
    sources = {
        "Caddyfile": repo_root / "deploy/hetzner/Caddyfile",
        "docker-compose.yml": repo_root / "deploy/hetzner/docker-compose.yml",
        "release.py": repo_root / "deploy/hetzner/release.py",
        "python/nexus/__init__.py": repo_root / "python/nexus/__init__.py",
        "python/nexus/release_artifact.py": (repo_root / "python/nexus/release_artifact.py"),
    }
    for relative, source in sources.items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    (destination / "candidate-manifest.json").write_text(
        _canonical_json(_candidate(state)),
        encoding="utf-8",
    )


def _fake_gh(state: dict[str, Any], arguments: list[str]) -> None:
    if arguments[:3] == ["api", "--paginate", "--slurp"]:
        artifacts = [_artifact(state)]
        if state["duplicate_artifact"]:
            artifacts.append(_artifact(state, expired=True))
        print(
            _canonical_json([{"artifacts": artifacts, "total_count": len(artifacts)}]),
            end="",
        )
        return
    if arguments[:2] == [
        "api",
        (f"repos/NielsdaWheelz/nexus-web/actions/runs/{PUBLISHER_RUN_ID}/attempts/1"),
    ]:
        print(
            _canonical_json(
                {
                    "conclusion": "success",
                    "event": "workflow_run",
                    "head_branch": "main",
                    "head_sha": "f" * 40,
                    "id": PUBLISHER_RUN_ID,
                    "path": state["publisher_path"],
                    "repository": {"full_name": "NielsdaWheelz/nexus-web"},
                    "run_attempt": state["publisher_run_attempt"],
                }
            ),
            end="",
        )
        return
    if arguments[:2] == [
        "api",
        f"repos/NielsdaWheelz/nexus-web/actions/runs/{SOURCE_CI_RUN_ID}/attempts/1",
    ]:
        print(
            _canonical_json(
                {
                    "conclusion": "success",
                    "event": "push",
                    "head_branch": "main",
                    "head_sha": state["source_sha"],
                    "id": SOURCE_CI_RUN_ID,
                    "name": "CI",
                    "path": state["source_ci_path"],
                    "repository": {"full_name": "NielsdaWheelz/nexus-web"},
                    "run_attempt": state["source_ci_run_attempt"],
                    "workflow_id": state["source_ci_workflow_id"],
                }
            ),
            end="",
        )
        return
    if arguments[:2] == ["run", "download"]:
        destination = Path(arguments[arguments.index("--dir") + 1])
        _copy_bundle(state, destination)
        return
    raise AssertionError(f"unsupported fake gh call: {arguments!r}")


def fake_main(command: str, arguments: list[str]) -> int:
    state_path = Path(os.environ["NEXUS_RELEASE_BUNDLE_STATE"])
    state = _load_state(state_path)
    state["events"].append({"arguments": arguments, "command": command})
    if command == "gh":
        _fake_gh(state, arguments)
    elif command == "git":
        _fake_git(state, arguments)
    else:
        raise AssertionError(f"unsupported release bundle fake {command}")
    _save_state(state_path, state)
    return 0


@dataclass(frozen=True, slots=True)
class ReleaseBundleHarness:
    root: Path
    repo_root: Path
    source_sha: str
    state_path: Path
    fake_bin: Path

    @classmethod
    def create(
        cls,
        root: Path,
        *,
        repo_root: Path,
        source_sha: str,
    ) -> ReleaseBundleHarness:
        state_path = root / "release-bundle-state.json"
        _save_state(
            state_path,
            {
                "duplicate_artifact": False,
                "events": [],
                "manifest_publisher_run_id": PUBLISHER_RUN_ID,
                "publisher_path": ".github/workflows/backend-images.yml",
                "publisher_run_attempt": 1,
                "source_ci_path": ".github/workflows/ci.yml",
                "source_ci_run_attempt": 1,
                "source_ci_workflow_id": SOURCE_CI_WORKFLOW_ID,
                "source_sha": source_sha,
            },
        )
        fake_bin = root / "bin"
        fake_bin.mkdir()
        helper = Path(__file__).resolve()
        for command in ("gh", "git"):
            executable = fake_bin / command
            executable.write_text(
                f"#!{sys.executable}\n"
                "import runpy, sys\n"
                f"sys.argv.insert(1, {command!r})\n"
                f"runpy.run_path({str(helper)!r}, run_name='__main__')\n",
                encoding="utf-8",
            )
            executable.chmod(0o755)
        return cls(
            root=root,
            repo_root=repo_root,
            source_sha=source_sha,
            state_path=state_path,
            fake_bin=fake_bin,
        )

    def run(self, output: Path) -> subprocess.CompletedProcess[str]:
        output.mkdir()
        environment = {
            **os.environ,
            "GH_TOKEN": "test-gh-token",
            "NEXUS_RELEASE_BUNDLE_REPO": str(self.repo_root),
            "NEXUS_RELEASE_BUNDLE_STATE": str(self.state_path),
            "PATH": f"{self.fake_bin}{os.pathsep}{os.environ['PATH']}",
        }
        return subprocess.run(
            (
                "bash",
                str(self.repo_root / "deploy/hetzner/fetch-release-bundle.sh"),
                self.source_sha,
                str(output),
            ),
            cwd=self.repo_root,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def state(self) -> dict[str, Any]:
        return _load_state(self.state_path)

    def update_state(self, **changes: object) -> None:
        state = self.state()
        state.update(changes)
        _save_state(self.state_path, state)


def main() -> int:
    if len(sys.argv) < 2:
        raise AssertionError("release bundle fake requires its command name")
    return fake_main(sys.argv[1], sys.argv[2:])


if __name__ == "__main__":
    raise SystemExit(main())
