"""Build one private immutable web candidate from an explicit application checkout."""

from __future__ import annotations

import hashlib
import os
import platform
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from artifact import (
    BUN_VERSION,
    NODE_VERSION,
    ArtifactError,
    Manifest,
    parse_env,
    sha256_file,
)

NODE = Path("/opt/nexus-web/node/bin/node")
BUN = Path("/opt/nexus-web/bun/bin/bun")


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: deploy/web/build.sh <source-checkout> <frontend-env>",
            file=sys.stderr,
        )
        return 2
    os.umask(0o077)
    stage = "preflight"
    log_path: Path | None = None
    try:
        source = Path(sys.argv[1]).resolve(strict=True)
        configuration = Path(sys.argv[2]).read_bytes()
        application_env = parse_env(configuration)
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            raise ArtifactError("build requires linux/x64; use the private devbox checkout")
        if application_env.get("NEXUS_ENV") != "prod":
            raise ArtifactError(
                "NEXUS_ENV must be prod; supply the captured frontend configuration"
            )
        if application_env.keys() & {
            "PATH",
            "HOME",
            "NODE_ENV",
            "PORT",
            "HOSTNAME",
            "NEXT_TELEMETRY_DISABLED",
            "CI",
            "NEXUS_WEB_TLS_CERT_FILE",
            "NEXUS_WEB_TLS_KEY_FILE",
        }:
            raise ArtifactError("application configuration contains host-owned launch inputs")
        environment = {
            "PATH": f"{NODE.parent}:{BUN.parent}:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "CI": "true",
            "NEXT_TELEMETRY_DISABLED": "1",
        }
        source_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=source, env=environment, text=True
        ).strip()
        if subprocess.check_output(
            ["git", "status", "--porcelain", "--untracked-files=normal"],
            cwd=source,
            env=environment,
        ):
            raise ArtifactError("source checkout is dirty; use a clean exact-source checkout")
        for directory in (source, source / "apps/web", source / "node/authored"):
            for name in (
                ".env",
                ".env.local",
                ".env.production",
                ".env.production.local",
            ):
                if (directory / name).exists():
                    raise ArtifactError(
                        "source checkout contains dotenv inputs; use a clean checkout"
                    )
        if (source / ".node-version").read_text().strip() != "22":
            raise ArtifactError(
                "source requires a different node major; review the private toolchain"
            )
        if (source / ".bun-version").read_text().strip() != BUN_VERSION:
            raise ArtifactError(
                "source requires a different bun version; review the private toolchain"
            )
        for binary, expected in ((NODE, f"v{NODE_VERSION}"), (BUN, BUN_VERSION)):
            actual = subprocess.check_output(
                [str(binary), "--version"], env=environment, text=True
            ).strip()
            if actual != expected:
                raise ArtifactError(
                    f"{binary} must report {expected}; install the pinned toolchain"
                )

        candidates = Path.home() / ".local/share/nexus-web/candidates"
        candidates.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (
            tempfile.NamedTemporaryFile(
                prefix="build-", suffix=".log", dir=candidates, delete=False
            ) as log,
            tempfile.TemporaryDirectory(prefix=".build-", dir=candidates) as scratch_name,
        ):
            log_path = Path(log.name)
            scratch = Path(scratch_name)
            build_home = scratch / "home"
            build_home.mkdir()
            environment["HOME"] = str(build_home)
            stage = "dependencies"
            print(f"web build: {stage}; private log {log_path}", file=sys.stderr)
            for directory in ("node/authored", "apps/web"):
                subprocess.run(
                    [str(BUN), "--no-env-file", "install", "--frozen-lockfile"],
                    cwd=source / directory,
                    env=environment,
                    stdout=log,
                    stderr=log,
                    check=True,
                    timeout=600,
                )
            stage = "application"
            print(f"web build: {stage}; source {source_sha}", file=sys.stderr)
            subprocess.run(
                [str(BUN), "--no-env-file", "--no-install", "run", "build"],
                cwd=source / "apps/web",
                env=environment | application_env | {"NODE_ENV": "production"},
                stdout=log,
                stderr=log,
                check=True,
                timeout=1200,
            )
            if (
                subprocess.check_output(
                    ["git", "status", "--porcelain", "--untracked-files=normal"],
                    cwd=source,
                    env=environment,
                )
                or subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=source, env=environment, text=True
                ).strip()
                != source_sha
            ):
                raise ArtifactError(
                    "source changed during the build; discard this build and inspect the checkout"
                )

            stage = "package"
            standalone = source / "apps/web/.next/standalone"
            if not (standalone / "serve.mjs").is_file():
                raise ArtifactError(
                    "standalone entrypoint is missing; inspect the private build log"
                )
            for path in standalone.rglob("*"):
                if path.is_symlink() and not path.resolve(strict=True).is_relative_to(standalone):
                    raise ArtifactError(
                        "standalone links outside its package; repair source packaging"
                    )
            candidate = scratch / "candidate"
            candidate.mkdir()
            archive = candidate / "app.tar.gz"

            def archive_member(member: tarfile.TarInfo) -> tarfile.TarInfo | None:
                if member.name == ".next/cache" or member.name.startswith(".next/cache/"):
                    return None
                member.uid = member.gid = 0
                member.uname = member.gname = "root"
                return member

            with tarfile.open(archive, "w:gz") as output:
                for path in sorted(standalone.iterdir()):
                    output.add(path, arcname=path.name, filter=archive_member)
            (candidate / "runtime.env").write_bytes(configuration)
            manifest = Manifest(
                source_sha=source_sha,
                archive_sha256=sha256_file(archive),
                config_sha256=hashlib.sha256(configuration).hexdigest(),
                node_version=NODE_VERSION,
            )
            (candidate / "manifest.json").write_bytes(manifest.to_bytes())
            destination = candidates / manifest.digest()
            candidate.rename(destination)
            print(destination / "manifest.json")
            print(
                "web build: packaged; no service was started or activated",
                file=sys.stderr,
            )
        return 0
    except (
        ArtifactError,
        OSError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as exc:
        if isinstance(exc, ArtifactError):
            detail = str(exc)
        elif isinstance(exc, OSError):
            detail = f"{exc.strerror}: {exc.filename or 'operation'}; repair the named input"
        elif isinstance(exc, subprocess.TimeoutExpired):
            detail = f"command exceeded {exc.timeout} seconds; inspect the private log"
        else:
            detail = f"command exited {exc.returncode}; inspect the private log"
        print(f"web build: {stage} failed: {detail}", file=sys.stderr)
        if log_path is not None:
            print(
                f"web build: inspect private log {log_path}; no candidate was activated",
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
