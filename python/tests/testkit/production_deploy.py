"""Executable-boundary harness for the production deployment orchestrator."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

from tests.testkit.auth_config import provider_config

EARLIEST_PUBLISHER_RUN_ID = 7001
LATEST_PUBLISHER_RUN_ID = 7002
SOURCE_CI_RUN_ID = 6001
SOURCE_CI_WORKFLOW_ID = 5001
ARTIFACT_ID = 8001
BOUND_DEPLOYMENT_ID = "dpl_BoundCandidate"
CURRENT_DEPLOYMENT_ID = "dpl_Current"
PRODUCTION_HOST = "nexus.nielseriknandal.com"
CANDIDATE_HOST = "bound-candidate.vercel.app"
PROJECT_NAME = "nexus-web"
PROJECT_ID = "prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs"
TEAM_ID = "team_fKVvTyTsMBQ7qFjccFO17BJL"
VERCEL_SCOPE = "niels-erik-nandals-projects"


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"


def _load_state(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError("deploy harness state must be an object")
    return value


def _save_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(".partial")
    temporary.write_text(_canonical_json(state), encoding="utf-8")
    temporary.replace(path)


def _event(state: dict[str, Any], command: str, arguments: list[str]) -> None:
    state["events"].append({"arguments": arguments, "command": command})


def _argument(arguments: list[str], flag: str) -> str:
    return arguments[arguments.index(flag) + 1]


def _candidate(state: dict[str, Any]) -> dict[str, object]:
    return {
        "expected_database_revision": "0211",
        "expected_oracle_manifest_digest": "sha256:" + "c" * 64,
        "images": {
            "api": "ghcr.io/nielsdawheelz/nexus-api@sha256:" + "a" * 64,
            "worker": "ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "b" * 64,
        },
        "publisher_run_attempt": 1,
        "publisher_run_id": EARLIEST_PUBLISHER_RUN_ID,
        "repository": "NielsdaWheelz/nexus-web",
        "schema_version": 1,
        "source_ci_run_id": SOURCE_CI_RUN_ID,
        "source_ci_run_attempt": 1,
        "source_ci_workflow_id": SOURCE_CI_WORKFLOW_ID,
        "source_sha": state["source_sha"],
    }


def _fake_gh(state: dict[str, Any], arguments: list[str]) -> None:
    if arguments[:3] == ["api", "--paginate", "--slurp"]:
        print(
            _canonical_json(
                [
                    {
                        "artifacts": [
                            {
                                "digest": "sha256:" + "d" * 64,
                                "expired": False,
                                "id": ARTIFACT_ID,
                                "name": f"nexus-backend-release-{state['source_sha']}",
                                "workflow_run": {"id": EARLIEST_PUBLISHER_RUN_ID},
                            }
                        ],
                        "total_count": 1,
                    }
                ]
            ),
            end="",
        )
        return
    if arguments[:2] == [
        "api",
        (f"repos/NielsdaWheelz/nexus-web/actions/runs/{EARLIEST_PUBLISHER_RUN_ID}/attempts/1"),
    ]:
        print(
            _canonical_json(
                {
                    "conclusion": "success",
                    "event": "workflow_run",
                    "head_branch": "main",
                    "head_sha": "f" * 40,
                    "id": EARLIEST_PUBLISHER_RUN_ID,
                    "path": ".github/workflows/backend-images.yml",
                    "repository": {"full_name": "NielsdaWheelz/nexus-web"},
                    "run_attempt": 1,
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
                    "path": ".github/workflows/ci.yml",
                    "repository": {"full_name": "NielsdaWheelz/nexus-web"},
                    "run_attempt": 1,
                    "workflow_id": SOURCE_CI_WORKFLOW_ID,
                }
            ),
            end="",
        )
        return
    if arguments[:2] == ["run", "download"]:
        destination = Path(_argument(arguments, "--dir"))
        repo_root = Path(os.environ["NEXUS_DEPLOY_REPO_ROOT"])
        for relative in (
            "deploy/hetzner/Caddyfile",
            "deploy/hetzner/docker-compose.yml",
            "deploy/hetzner/release.py",
            "python/nexus/__init__.py",
            "python/nexus/release_artifact.py",
        ):
            target = destination / Path(relative).name
            if relative == "python/nexus/__init__.py":
                target = destination / "python/nexus/__init__.py"
            elif relative == "python/nexus/release_artifact.py":
                target = destination / "python/nexus/release_artifact.py"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repo_root / relative, target)
        (destination / "candidate-manifest.json").write_text(
            _canonical_json(_candidate(state)),
            encoding="utf-8",
        )
        return
    raise AssertionError(f"unsupported fake gh call: {arguments!r}")


def _fake_git(state: dict[str, Any], arguments: list[str]) -> None:
    if "status" in arguments or "fetch" in arguments:
        return
    if "rev-parse" in arguments:
        print(state["source_sha"])
        return
    raise AssertionError(f"unsupported fake git call: {arguments!r}")


def _fake_ssh(state: dict[str, Any], arguments: list[str]) -> None:
    command = " ".join(arguments)
    if "sudo test -x /opt/nexus/releases/" in command:
        if not state["bundle_installed"]:
            raise SystemExit(1)
    elif "mktemp -d /tmp/nexus-release.XXXXXXXX" in command:
        print("/tmp/nexus-release.ABC12345")
    elif " inspect --source-sha " in f" {command} ":
        print(_canonical_json(state["host_inspect"]), end="")
    elif "install-bundle" in command:
        state["bundle_installed"] = True
    elif "fail-bound-frontend" in command or "fail-auth-smoke" in command:
        phase = state["host_inspect"]["phase"]
        state["host_inspect"]["phase"] = (
            "RolledBack"
            if phase in {"Prepared", "WritersStopped", "BackupVerified"}
            else "ForwardFixRequired"
        )
    elif any(
        operation in command
        for operation in (" apply ", " finalize ", "verify-current", "rm -r --")
    ):
        return
    else:
        raise AssertionError(f"unsupported fake ssh call: {arguments!r}")


def _deployment(
    state: dict[str, Any],
    *,
    deployment_id: str = BOUND_DEPLOYMENT_ID,
    aliases: list[str] | None = None,
    ready_state: str = "READY",
) -> dict[str, object]:
    return {
        "alias": aliases or [],
        "id": deployment_id,
        "uid": deployment_id,
        "name": PROJECT_NAME,
        "ownerId": TEAM_ID,
        "projectId": PROJECT_ID,
        "readyState": ready_state,
        "state": ready_state,
        "target": "production",
        "url": "bound-candidate.vercel.app",
        "meta": {"githubCommitSha": state["source_sha"]},
        "createdAt": 200,
    }


def _fake_auth_smoke_curl(
    state: dict[str, Any],
    arguments: list[str],
    url: str,
) -> bool:
    parsed = urlparse(url)
    if parsed.netloc not in {PRODUCTION_HOST, CANDIDATE_HOST, "api.nexus.example"}:
        return False
    candidate = parsed.netloc == CANDIDATE_HOST
    candidate_failure = candidate and state.get("candidate_auth_smoke_failure")
    if parsed.path == "/version":
        return False
    output_flag = "--output" if "--output" in arguments else "-o"
    output = Path(_argument(arguments, output_flag)) if output_flag in arguments else None
    header_flag = "--dump-header" if "--dump-header" in arguments else "-D"
    headers = Path(_argument(arguments, header_flag)) if header_flag in arguments else None
    write_out = _argument(arguments, "-w") if "-w" in arguments else None
    cookie_values = [
        arguments[index + 1]
        for index, argument in enumerate(arguments[:-1])
        if argument == "-H" and arguments[index + 1].lower().startswith("cookie:")
    ]
    cookie = " ".join(cookie_values).lower()

    status = 200
    location = ""
    body = ""
    if parsed.netloc == "api.nexus.example":
        if parsed.path == "/docs":
            status = 404
    elif parsed.path == "/lectern":
        status = 307
        location = f"https://{parsed.netloc}/login"
    elif parsed.path == "/browse" and candidate_failure and "fixture-auth-token" in cookie:
        status = 500
    elif parsed.path == "/browse":
        status = 307
        if "stale-project" in cookie:
            location = f"https://{parsed.netloc}/login?next=%2Fbrowse"
        elif "fixture-auth-token" in cookie:
            location = f"https://{parsed.netloc}/auth/session/recover?next=%2Fbrowse"
        else:
            location = f"https://{parsed.netloc}/login?next=%2Fbrowse"
    elif parsed.path == "/auth/session/recover":
        status = 200
    elif parsed.path == "/auth/session/resolve":
        status = 401
        body = '{"error":{"code":"E_UNAUTHENTICATED"}}'
    elif parsed.path == "/api/me":
        status = 401
        body = '{"error":{"code":"E_UNAUTHENTICATED"}}'
    elif parsed.path == "/auth/oauth":
        provider = (parse_qs(parsed.query).get("provider") or [""])[0]
        status = 307
        location = "https://fixture.supabase.co/auth/v1/authorize?" + urlencode(
            {
                "provider": provider,
                "redirect_to": f"https://{parsed.netloc}/auth/callback",
            }
        )

    if headers is not None:
        vary = (
            "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch"
            if parsed.path in {"/lectern", "/browse", "/auth/session/recover"}
            else "Cookie"
        )
        response_headers = [
            f"HTTP/1.1 {status}\r\n",
            "Cache-Control: private, no-store\r\n",
            "Pragma: no-cache\r\n",
            "Expires: 0\r\n",
            f"Vary: {vary}\r\n",
        ]
        if location:
            response_headers.append(f"Location: {location}\r\n")
        if parsed.path == "/auth/session/resolve":
            response_headers.append(
                "Set-Cookie: sb-fixture-auth-token=; Max-Age=0; Path=/; HttpOnly\r\n"
            )
        response_headers.append("\r\n")
        headers.write_text("".join(response_headers), encoding="ascii")
    if output is not None and str(output) != "/dev/null":
        output.write_text(body, encoding="utf-8")
    if write_out is not None:
        if "%{redirect_url}" in write_out:
            print(f"{status}\t{location}")
        else:
            print(status)
    elif output is None:
        print(body, end="")
    return True


def _fake_vercel(state: dict[str, Any], arguments: list[str]) -> None:
    arguments = arguments[1:]
    if arguments[:2] == ["promote", BOUND_DEPLOYMENT_ID]:
        state["authoritative_id"] = BOUND_DEPLOYMENT_ID
        return
    if arguments[:2] == ["alias", "set"]:
        if arguments[3] != PRODUCTION_HOST:
            raise AssertionError(f"unsupported fake alias target: {arguments!r}")
        state["authoritative_id"] = BOUND_DEPLOYMENT_ID
        return
    raise AssertionError(f"unsupported fake Vercel call: {arguments!r}")


def _fake_curl(state: dict[str, Any], arguments: list[str]) -> None:
    output_flag = "--output" if "--output" in arguments else "-o"
    output = Path(_argument(arguments, output_flag)) if output_flag in arguments else None
    url = next(argument for argument in arguments if argument.startswith("https://"))
    if _fake_auth_smoke_curl(state, arguments, url):
        return
    assert output is not None
    if url == "https://api.supabase.com/v1/projects/fixture/config/auth":
        output.write_text(
            Path(state["auth_config_fixture"]).read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        print("200", end="")
        return
    if url == "https://api.supabase.com/v1/projects/fixture/config/auth/third-party-auth":
        output.write_text("[]\n", encoding="utf-8")
        print("200", end="")
        return
    if url.startswith(f"https://api.vercel.com/v9/projects/{PROJECT_ID}"):
        project_id = (
            "prj_WrongScope" if state["project_identity_mode"] == "mismatch" else PROJECT_ID
        )
        output.write_text(
            _canonical_json(
                {
                    "accountId": TEAM_ID,
                    "autoAssignCustomDomains": False,
                    "autoExposeSystemEnvs": state["project_identity_mode"] != "system-env-disabled",
                    "id": project_id,
                    "name": PROJECT_NAME,
                    "ssoProtection": {"deploymentType": "preview"},
                    "targets": {
                        "production": {
                            "alias": [],
                            "automaticAliases": [],
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        print("200", end="")
        return
    if url.startswith("https://api.vercel.com/v6/deployments?"):
        older = _deployment(state, deployment_id="dpl_OlderCandidate")
        older["createdAt"] = 100
        older["url"] = "older-candidate.vercel.app"
        output.write_text(
            _canonical_json(
                {
                    "deployments": [_deployment(state), older],
                    "pagination": {"count": 2, "next": None, "prev": None},
                }
            ),
            encoding="utf-8",
        )
        print("200", end="")
        return
    if url.startswith(f"https://api.vercel.com/v2/aliases/{PRODUCTION_HOST}"):
        deployment_id = state["authoritative_id"]
        output.write_text(
            _canonical_json(
                {
                    "alias": PRODUCTION_HOST,
                    "deployment": {
                        "id": deployment_id,
                        "url": "bound-candidate.vercel.app",
                    },
                    "deploymentId": deployment_id,
                    "projectId": PROJECT_ID,
                }
            ),
            encoding="utf-8",
        )
        print("200", end="")
        return
    if url.startswith(f"https://api.vercel.com/v13/deployments/{PRODUCTION_HOST}"):
        output.write_text(
            _canonical_json(
                _deployment(
                    state,
                    deployment_id=state["authoritative_id"],
                    aliases=[PRODUCTION_HOST],
                )
            ),
            encoding="utf-8",
        )
        print("200", end="")
        return
    if url.startswith(f"https://api.vercel.com/v13/deployments/{BOUND_DEPLOYMENT_ID}"):
        status = str(state["bound_api_status"])
        ready_state = state["bound_ready_state"]
        body: dict[str, object]
        if status == "404":
            body = {"error": {"code": "DEPLOYMENT_NOT_FOUND", "message": "gone"}}
        elif state["bound_payload_mode"] == "malformed":
            body = {"readyState": ready_state}
        else:
            deployment_id = (
                "dpl_WrongIdentity"
                if state["bound_payload_mode"] == "identity_mismatch"
                else BOUND_DEPLOYMENT_ID
            )
            aliases = [PRODUCTION_HOST] if state["authoritative_id"] == BOUND_DEPLOYMENT_ID else []
            body = _deployment(
                state,
                deployment_id=deployment_id,
                aliases=aliases,
                ready_state=ready_state,
            )
        output.write_text(_canonical_json(body), encoding="utf-8")
        print(status, end="")
        return
    if url.startswith("https://api.vercel.com/v13/deployments/"):
        output.write_text(
            _canonical_json(
                _deployment(
                    state,
                    deployment_id=state["authoritative_id"],
                )
            ),
            encoding="utf-8",
        )
        print("200", end="")
        return
    headers = Path(_argument(arguments, "--dump-header"))
    headers.write_text("HTTP/1.1 200 OK\r\nCache-Control: no-store\r\n\r\n", encoding="ascii")
    output.write_text(_canonical_json({"source_sha": state["source_sha"]}), encoding="utf-8")
    print("200", end="")


def fake_main(command: str, arguments: list[str]) -> int:
    state_path = Path(os.environ["NEXUS_DEPLOY_FAKE_STATE"])
    state = _load_state(state_path)
    _event(state, command, arguments)
    if command == "gh":
        _fake_gh(state, arguments)
    elif command == "git":
        _fake_git(state, arguments)
    elif command == "ssh":
        _fake_ssh(state, arguments)
    elif command == "scp":
        pass
    elif command == "node":
        _fake_vercel(state, arguments)
    elif command == "curl":
        _fake_curl(state, arguments)
    else:
        raise AssertionError(f"unsupported deploy fake command {command}")
    _save_state(state_path, state)
    return 0


@dataclass(frozen=True, slots=True)
class ProductionDeployHarness:
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
        host_inspect: dict[str, object],
        authoritative_id: str,
    ) -> ProductionDeployHarness:
        state_path = root / "deploy-state.json"
        shared_env = root / "env-prod"
        shared_env.write_text(
            "APP_PUBLIC_URL=https://app.nexus.example\n"
            "SUPABASE_ISSUER=https://fixture.supabase.co/auth/v1\n"
            "SUPABASE_JWKS_URL=https://fixture.supabase.co/auth/v1/.well-known/jwks.json\n"
            "SUPABASE_AUDIENCES=authenticated\n",
            encoding="utf-8",
        )
        frontend_env = root / "env-prod-frontend"
        frontend_env.write_text(
            "FASTAPI_BASE_URL=https://api.nexus.example\n"
            "NEXT_PUBLIC_SUPABASE_URL=https://fixture.supabase.co\n"
            "AUTH_ALLOWED_REDIRECT_ORIGINS=https://app.nexus.example\n",
            encoding="utf-8",
        )
        auth_config_fixture = root / "auth-config.json"
        auth_config_fixture.write_text(
            _canonical_json(provider_config(repo_root)),
            encoding="utf-8",
        )
        _save_state(
            state_path,
            {
                "auth_config_fixture": str(auth_config_fixture),
                "authoritative_id": authoritative_id,
                "bound_api_status": 200,
                "bound_payload_mode": "normal",
                "bound_ready_state": "READY",
                "candidate_auth_smoke_failure": False,
                "bundle_installed": host_inspect["status"] != "new",
                "events": [],
                "host_inspect": host_inspect,
                "project_identity_mode": "normal",
                "source_sha": source_sha,
            },
        )
        fake_bin = root / "bin"
        fake_bin.mkdir()
        helper = Path(__file__).resolve()
        for command in ("curl", "gh", "git", "node", "scp", "ssh"):
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

    def run(self, *, include_provider_credentials: bool = True) -> subprocess.CompletedProcess[str]:
        environment = {
            **os.environ,
            "NEXUS_DEPLOY_FAKE_STATE": str(self.state_path),
            "NEXUS_DEPLOY_REPO_ROOT": str(self.repo_root),
            "NEXUS_FRONTEND_ENV": str(self.root / "env-prod-frontend"),
            "NEXUS_SHARED_ENV": str(self.root / "env-prod"),
            "PATH": f"{self.fake_bin}{os.pathsep}{os.environ['PATH']}",
        }
        if include_provider_credentials:
            environment.update(
                {
                    "GH_TOKEN": "test-gh-token",
                    "SUPABASE_MANAGEMENT_ACCESS_TOKEN": "test-operator-token",
                    "VERCEL_TOKEN": "test-vercel-token",
                }
            )
        else:
            for name in (
                "GH_TOKEN",
                "SUPABASE_MANAGEMENT_ACCESS_TOKEN",
                "VERCEL_TOKEN",
            ):
                environment.pop(name, None)
        return subprocess.run(
            ("bash", str(self.repo_root / "deploy/hetzner/deploy.sh"), self.source_sha),
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
        raise AssertionError("deploy fake requires its command name")
    return fake_main(sys.argv[1], sys.argv[2:])


if __name__ == "__main__":
    raise SystemExit(main())
