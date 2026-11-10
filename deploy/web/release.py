"""Host-local immutable web preparation, activation and observation.

The caller holds /run/lock/nexus-web-release.lock across the complete release.
This owner never releases the backend or changes provider routing.
"""

from __future__ import annotations

import json
import os
import pwd
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

from artifact import NODE_VERSION, ArtifactError, Manifest, load_manifest, parse_env, sha256_file

ROOT = Path("/srv/nexus-web")
NODE = Path("/opt/nexus-web/node/bin/node")
CONTROL = Path("/opt/nexus-web/control/release.py")
CERT = Path("/etc/nexus-web/tls/cert.pem")
KEY = Path("/etc/nexus-web/tls/key.pem")
CACHE = Path("/var/cache/nexus-web")
SERVICE = "nexus-web.service"
PROBE_SERVICE = "nexus-web-probe.service"
WEB_ORIGIN = "https://nexus.nielseriknandal.com"
API_ORIGIN = "https://nexus-api.nielseriknandal.com"


def command(*args: str, timeout: int = 30) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=timeout).strip()


def candidate(directory: Path) -> Manifest:
    manifest = load_manifest(directory / "manifest.json")
    if sha256_file(directory / "app.tar.gz") != manifest.archive_sha256:
        raise ArtifactError("candidate archive digest differs; prepare the original captured bytes")
    if sha256_file(directory / "runtime.env") != manifest.config_sha256:
        raise ArtifactError("candidate config digest differs; prepare the original captured bytes")
    parse_env((directory / "runtime.env").read_bytes())
    return manifest


def installed(manifest_path: Path) -> tuple[Path, Manifest]:
    expected = load_manifest(manifest_path)
    directory = ROOT / "releases" / expected.digest()
    if candidate(directory) != expected:
        raise ArtifactError("installed candidate differs from the requested manifest")
    return directory, expected


def environment(directory: Path, port: str) -> dict[str, str]:
    return parse_env((directory / "runtime.env").read_bytes()) | {
        "PATH": f"{NODE.parent}:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": str(CACHE / directory.name),
        "NODE_ENV": "production",
        "NEXT_TELEMETRY_DISABLED": "1",
        "HOSTNAME": "127.0.0.1",
        "PORT": port,
        "NEXUS_WEB_TLS_CERT_FILE": str(CERT),
        "NEXUS_WEB_TLS_KEY_FILE": str(KEY),
    }


def probe(directory: Path, manifest: Manifest, port: int) -> None:
    observed = json.loads(
        command(
            str(NODE),
            str(directory / "app/probe-web.mjs"),
            f"https://127.0.0.1:{port}",
            str(CERT),
            timeout=10,
        )
    )
    if observed != {"source_sha": manifest.source_sha}:
        raise ArtifactError("local web identity differs from the candidate")


def ready(directory: Path, manifest: Manifest, port: int) -> None:
    deadline = time.monotonic() + 30
    while True:
        try:
            probe(directory, manifest, port)
            return
        except subprocess.CalledProcessError:
            # Startup is bounded; identity/JSON errors are not readiness retries.
            if time.monotonic() >= deadline:
                raise ArtifactError(
                    "local h2 readiness timed out; inspect the owned service journal"
                ) from None
            time.sleep(1)


def public_version(origin: str) -> dict:
    response = command(
        "curl",
        "--silent",
        "--show-error",
        "--fail",
        "--http2",
        "--proto",
        "=https",
        "--max-time",
        "20",
        "--dump-header",
        "-",
        f"{origin}/version",
        timeout=25,
    )
    headers, body = response.split("\r\n\r\n" if "\r\n\r\n" in response else "\n\n", 1)
    if not headers.startswith("HTTP/2 200") or not any(
        line.lower().strip() == "cache-control: no-store" for line in headers.splitlines()
    ):
        raise ArtifactError(f"{origin}/version must return h2 200 and no-store")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ArtifactError(f"{origin}/version returned an invalid identity")
    return value


def backend_matches(manifest: Manifest) -> None:
    value = public_version(API_ORIGIN)
    if (
        not isinstance(value.get("data"), dict)
        or value["data"].get("source_sha") != manifest.source_sha
    ):
        raise ArtifactError("backend source differs; do not activate this web candidate")


def prepare(source: Path) -> None:
    manifest = candidate(source)
    if command(str(NODE), "--version") != f"v{NODE_VERSION}":
        raise ArtifactError("private node version differs from the candidate")
    directory = ROOT / "releases" / manifest.digest()
    if directory.exists():
        installed(source / "manifest.json")
    else:
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=ROOT / "releases") as staging:
            target = Path(staging) / manifest.digest()
            target.mkdir(mode=0o755)
            target.chmod(0o755)
            for name in ("manifest.json", "app.tar.gz", "runtime.env"):
                shutil.copyfile(source / name, target / name)
            candidate(target)
            app = target / "app"
            app.mkdir(mode=0o755)
            with tarfile.open(target / "app.tar.gz") as archive:
                archive.extractall(app, filter="data")
            if not (app / "serve.mjs").is_file() or not (app / "probe-web.mjs").is_file():
                raise ArtifactError("archive lacks the canonical server or h2 probe")
            if (app / ".next/cache").exists():
                raise ArtifactError("archive contains cache; rebuild with the canonical packager")
            for path in app.rglob("*"):
                if path.is_symlink():
                    continue
                os.chown(path, 0, 0)
                path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
            app.chmod(0o555)
            account = pwd.getpwnam("nexus-web")
            for name in ("app.tar.gz", "manifest.json"):
                (target / name).chmod(0o444)
            os.chown(target / "runtime.env", 0, account.pw_gid)
            (target / "runtime.env").chmod(0o440)
            cache = CACHE / manifest.digest()
            cache.mkdir(mode=0o700, exist_ok=True)
            os.chown(cache, account.pw_uid, account.pw_gid)
            (app / ".next/cache").symlink_to(cache, target_is_directory=True)
            target.rename(directory)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 3444))
    command(
        "systemd-run",
        "--quiet",
        "--collect",
        f"--unit={PROBE_SERVICE}",
        "--property=User=nexus-web",
        "--property=Group=nexus-web",
        "--property=MemoryMax=1G",
        "--property=MemorySwapMax=0",
        "--property=NoNewPrivileges=yes",
        "--property=ProtectSystem=strict",
        "--property=ProtectHome=yes",
        "--property=PrivateTmp=yes",
        f"--property=ReadWritePaths={CACHE}",
        "--property=UMask=0077",
        "--property=TimeoutStopSec=30",
        "--property=RuntimeMaxSec=60",
        "/usr/bin/python3",
        "-B",
        str(CONTROL),
        "run",
        str(directory / "manifest.json"),
        "3444",
    )
    try:
        ready(directory, manifest, 3444)
    finally:
        command("systemctl", "stop", PROBE_SERVICE, timeout=40)
    print(
        f"web prepare: locally qualified {directory / 'manifest.json'}; serving selection unchanged"
    )


def activate(manifest_path: Path) -> None:
    directory, manifest = installed(manifest_path)
    backend_matches(manifest)
    print("web activate: stopping web; subsequent failures require forward repair", flush=True)
    command("systemctl", "stop", SERVICE, timeout=40)
    with tempfile.TemporaryDirectory(prefix=".select-", dir=ROOT) as staging:
        pointer = Path(staging) / "current"
        pointer.symlink_to(directory, target_is_directory=True)
        pointer.replace(ROOT / "current")
    print(f"web activate: selected {manifest.digest()}; starting service", flush=True)
    command("systemctl", "start", SERVICE)
    ready(directory, manifest, 3443)
    print(f"web activate: serving {manifest.digest()} locally; public acceptance still required")


def check(manifest_path: Path) -> None:
    directory, manifest = installed(manifest_path)
    if (ROOT / "current").resolve(strict=True) != directory:
        raise ArtifactError("selected directory differs from the requested candidate")
    command("systemctl", "is-active", "--quiet", SERVICE)
    pid = int(command("systemctl", "show", SERVICE, "--property=MainPID", "--value"))
    process = Path(f"/proc/{pid}")
    if (process / "cwd").resolve() != directory / "app" or (process / "exe").resolve() != NODE:
        raise ArtifactError("running process does not use the selected candidate and private node")
    observed_env = dict(
        entry.split(b"=", 1) for entry in (process / "environ").read_bytes().split(b"\0") if entry
    )
    if observed_env != {
        key.encode(): value.encode() for key, value in environment(directory, "3443").items()
    }:
        raise ArtifactError("running process environment differs from the captured candidate")
    if command(str(NODE), "--version") != f"v{manifest.node_version}":
        raise ArtifactError("private node version differs from the selected candidate")
    probe(directory, manifest, 3443)
    if public_version(WEB_ORIGIN) != {"source_sha": manifest.source_sha}:
        raise ArtifactError("public web source differs from the requested candidate")
    backend_matches(manifest)
    print(f"web check: exact candidate {manifest.digest()} is serving locally and publicly")


def main() -> int:
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    if operation == "run" and len(sys.argv) == 4 and sys.argv[3] in {"3443", "3444"}:
        directory = Path(sys.argv[2]).resolve(strict=True).parent
        os.chdir(directory / "app")
        os.execve(
            NODE, [str(NODE), str(directory / "app/serve.mjs")], environment(directory, sys.argv[3])
        )
    if operation not in {"prepare", "activate", "check"} or len(sys.argv) != 3:
        print(
            "usage: release.py prepare <candidate-dir> | activate/check <manifest.json>",
            file=sys.stderr,
        )
        return 2
    try:
        if os.geteuid() != 0:
            raise ArtifactError("host operations require root through the release controller")
        path = Path(sys.argv[2]).resolve(strict=True)
        {"prepare": prepare, "activate": activate, "check": check}[operation](path)
        return 0
    except (
        ArtifactError,
        OSError,
        ValueError,
        tarfile.TarError,
        subprocess.SubprocessError,
    ) as exc:
        detail = (
            str(exc)
            if isinstance(exc, ArtifactError)
            else f"{type(exc).__name__}; inspect the named inputs and service journal"
        )
        print(f"web {operation}: failed: {detail}; no automatic rollback", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
