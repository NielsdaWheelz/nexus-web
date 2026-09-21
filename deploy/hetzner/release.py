#!/usr/bin/env python3
"""Converge the Hetzner backend onto one immutable CI candidate, in one pass.

    PYTHONPATH=python python3 deploy/hetzner/release.py <source-sha>
    PYTHONPATH=python python3 deploy/hetzner/release.py --check [<source-sha>]

The flow is linear and idempotent; after any failure, fix the cause and rerun:

    preflight -> inputs -> images -> backup -> migrate -> up -> caddy
              -> health -> isolation -> current pointer

`--check` runs preflight and the read-only proofs against the SHA the host
records. There is no attempt/resume state machine: the host keeps one
`current` pointer and nothing else. Every mutation runs over ssh; the
read-only proofs address containers by Compose project label, so they need
nothing installed on the host.
"""

import argparse
import json
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

from nexus.release_artifact import CandidateManifest, load_candidate_manifest

REPOSITORY = "NielsdaWheelz/nexus-web"
WORKFLOW = ".github/workflows/backend-images.yml"
SSH_TARGET = "nexus@5.78.194.235"
SSH_OPTIONS = (
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
)  # fmt: skip

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = "/etc/nexus/docker-compose.yml"
CONFIG_FILE = "/etc/nexus/current.env"
BACKUP_CONFIG_FILE = "/etc/nexus/backup.env"
CADDYFILE = "/etc/nexus/Caddyfile"
CURRENT_POINTER = "/var/lib/nexus/releases/current"
APPARMOR_PROFILE = "/etc/apparmor.d/nexus-codex-agent-host"
BOOT_GUARD_SERVICE = "nexus-codex-state-boot-guard.service"
CODEX_STATE = "/srv/nexus/codex-state"
CODEX_STATE_DEVICE = "/dev/mapper/nexus-codex-state"
CODEX_CREDENTIAL = f"{CODEX_STATE}/codex/codex-personal/auth.json"
CODEX_AGENT_HOST = "nexus-codex-agent-host"
CODEX_PRIVATE_NETWORK = "nexus_codex_private"
CODEX_PRIVATE_BRIDGE_IP = "172.30.0.1"
BACKUP_STATE_ROOT = "/var/backups/nexus/r2"

# Declared host inputs: the isolation contract lives in these files, and the
# release installs them before it converges anything.
HOST_INPUTS = (
    ("docker-compose.yml", COMPOSE_FILE, "0444"),
    ("nexus-codex-agent-host.apparmor", APPARMOR_PROFILE, "0644"),
    ("codex-state-boot-guard.sh", "/usr/local/sbin/nexus-codex-state-boot-guard", "0755"),
    ("nexus-codex-state-boot-guard.service", f"/etc/systemd/system/{BOOT_GUARD_SERVICE}", "0644"),
    (
        "docker-codex-state-guard.conf",
        "/etc/systemd/system/docker.service.d/20-nexus-codex-state-guard.conf",
        "0644",
    ),
)

WRITERS = ("api", "worker-interactive", "worker-background")
SERVICES = (
    "postgres",
    "caddy",
    "api",
    "worker-interactive",
    "worker-background",
    "codex-egress-policy",
    CODEX_AGENT_HOST,
)

MIN_DOCKER_MAJOR = 28
MIN_MEMORY_TOTAL = 1900 * 1024 * 1024
MIN_MEMORY_AVAILABLE = 128 * 1024 * 1024
MIN_SWAP_TOTAL = 1024 * 1024 * 1024
MIN_ROOT_FREE = 2 * 1024 * 1024 * 1024

SHA = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
REVISION = re.compile(r"[0-9a-z][0-9a-z_]{0,63}\Z")
CONTAINER_ID = re.compile(r"[0-9a-f]{12,64}\Z")

# One process inside the candidate API image answers "does the database's
# revision descend from the candidate head?". Alembic's graph is the only
# authority for that, and it ships in the image being released.
ANCESTRY = """
import json, sys
from alembic.config import Config
from alembic.script import ScriptDirectory

config = Config('/app/migrations/alembic.ini')
config.set_main_option('script_location', '/app/migrations/alembic')
scripts = ScriptDirectory.from_config(config)
current, head = sys.argv[1], sys.argv[2]
heads = scripts.get_heads()
if heads != [head]:
    ancestor = False
elif current == head:
    ancestor = True
else:
    try:
        tuple(scripts.iterate_revisions(head, current))
    except Exception:
        ancestor = False
    else:
        ancestor = True
print(json.dumps({'heads': heads, 'ancestor': ancestor}))
"""


class Failure(RuntimeError):
    """The release cannot proceed. Repair the named cause and rerun."""


def note(message: str) -> None:
    print(f"== {message}", flush=True)


def run(argv: tuple[str, ...], *, stdin: bytes | None = None, timeout: int = 120) -> str:
    """Run one local command, naming it and its output when it fails.

    A failing command must say which command failed and why without anyone
    going digging in Docker events afterwards, so both streams are reported.
    """

    completed = subprocess.run(argv, input=stdin, capture_output=True, timeout=timeout, check=False)
    if completed.returncode != 0:
        label = argv[-1] if argv[0] == "ssh" else shlex.join(argv[:3])
        streams = (("stderr", completed.stderr), ("stdout", completed.stdout))
        detail = " ".join(
            f"{name}: {value.decode('utf-8', 'replace').strip()[-2000:]}"
            for name, value in streams
            if value.strip()
        )
        raise Failure(f"{label} failed ({completed.returncode}) {detail}")
    return completed.stdout.decode("utf-8", "replace")


def host(command: str, *, stdin: bytes | None = None, timeout: int = 120) -> str:
    """Run one shell command on the production host over ssh."""

    return run(("ssh", *SSH_OPTIONS, SSH_TARGET, command), stdin=stdin, timeout=timeout)


def compose(
    candidate: CandidateManifest,
    arguments: str,
    *,
    profile: str = "",
    environment: str = "",
    timeout: int = 180,
) -> str:
    """Run one mutating `docker compose` command against the release project."""

    return host(
        f"sudo env API_IMAGE={candidate.images.api} WORKER_IMAGE={candidate.images.worker}"
        f" NEXUS_CONFIG_FILE={CONFIG_FILE} {environment}"
        f" docker compose --project-name nexus --env-file {CONFIG_FILE} --file {COMPOSE_FILE}"
        f"{' --profile ' + profile if profile else ''} {arguments}",
        timeout=timeout,
    )


def container(service: str) -> str:
    """Resolve one service's container through its Compose project labels."""

    identifier = host(
        "docker ps --all --quiet"
        " --filter label=com.docker.compose.project=nexus"
        f" --filter label=com.docker.compose.service={service}"
        " --filter label=com.docker.compose.oneoff=False"
    ).strip()
    if CONTAINER_ID.fullmatch(identifier) is None:
        raise Failure(f"{service} has no unique container")
    return identifier


def inside(service: str, command: str, *, stdin: bytes | None = None, timeout: int = 120) -> str:
    return host(f"docker exec -i {container(service)} {command}", stdin=stdin, timeout=timeout)


def inspect(identifier: str) -> dict[str, Any]:
    inspected = json.loads(host(f"docker inspect {identifier}"))
    if not isinstance(inspected, list) or len(inspected) != 1:
        raise Failure(f"docker inspect {identifier} is not one object")
    return inspected[0]


def health_status(service: str) -> str:
    state = inspect(container(service))["State"]
    health = state.get("Health")
    return str(health["Status"] if isinstance(health, dict) else state["Status"])


def psql(statement: str) -> str:
    inner = f'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c {shlex.quote(statement)}'
    return inside("postgres", f"sh -c {shlex.quote(inner)}").strip()


def fetch_json(url: str) -> tuple[Any, str]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read(1024 * 1024)
        cache_control = response.headers.get("cache-control", "")
    return json.loads(body), cache_control


# ---------------------------------------------------------------------------
# Guarantee: the images are the ones the FIRST CI run of this exact main SHA
# built. `backend-images.yml` publishes only when `github.run_attempt == 1`,
# so a rerun publishes nothing; this refuses a re-run run outright, and binds
# the deployed bytes to the manifest by digest, OCI label and runtime identity.
# ---------------------------------------------------------------------------


def resolve_candidate(source_sha: str, workspace: Path) -> CandidateManifest:
    name = f"nexus-backend-release-{source_sha}"
    query = f"repos/{REPOSITORY}/actions/artifacts?name={name}&per_page=100"
    pages = json.loads(run(("gh", "api", "--paginate", "--slurp", query), timeout=120))
    artifacts = [
        artifact
        for page in pages
        for artifact in page["artifacts"]
        if artifact["name"] == name and artifact["expired"] is False
    ]
    if len(artifacts) != 1:
        raise Failure(f"expected exactly one unexpired {name} artifact, found {len(artifacts)}")
    run_id = str(artifacts[0]["workflow_run"]["id"])
    detail = json.loads(run(("gh", "api", f"repos/{REPOSITORY}/actions/runs/{run_id}"), timeout=60))
    fields = ("path", "event", "head_branch", "head_sha", "conclusion", "run_attempt")
    provenance = {field: detail[field] for field in fields}
    expected = {
        "path": WORKFLOW,
        "event": "push",
        "head_branch": "main",
        "head_sha": source_sha,
        "conclusion": "success",
        "run_attempt": 1,
    }
    if provenance != expected:
        raise Failure(
            "candidate images are not from the first CI run of this main SHA: "
            f"{provenance} differs from {expected}"
        )
    download = ("gh", "run", "download", run_id, "--repo", REPOSITORY, "--name", name, "--dir")
    run((*download, str(workspace)), timeout=300)
    candidate = load_candidate_manifest(workspace / "candidate-manifest.json")
    if candidate.source_sha != source_sha or candidate.repository != REPOSITORY:
        raise Failure("candidate manifest identity differs from the requested release")
    note(f"candidate {source_sha} from CI run {run_id}, attempt 1")
    return candidate


def pull_image(candidate: CandidateManifest, image: str) -> None:
    """Pull one candidate image by digest and prove it carries this source."""

    host(f"docker pull {image}", timeout=900)
    inspected = json.loads(host(f"docker image inspect {image}"))[0]
    if inspected["Config"]["Labels"]["org.opencontainers.image.revision"] != candidate.source_sha:
        raise Failure(f"{image} OCI revision label differs from the candidate")
    identity = json.loads(
        host(
            "docker run --rm --network none --read-only --cap-drop ALL"
            f" --entrypoint cat {image} /app/runtime-identity.json"
        )
    )
    if identity != {
        "source_sha": candidate.source_sha,
        "expected_database_revision": candidate.expected_database_revision,
        "expected_oracle_manifest_digest": candidate.expected_oracle_manifest_digest,
    }:
        raise Failure(f"{image} runtime identity differs from the candidate manifest")


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------


def meminfo() -> dict[str, int]:
    values: dict[str, int] = {}
    for line in host("cat /proc/meminfo").splitlines():
        key, _, raw = line.partition(":")
        if key in {"MemTotal", "MemAvailable", "SwapTotal"}:
            values[key] = int(raw.split()[0]) * 1024
    if values.keys() != {"MemTotal", "MemAvailable", "SwapTotal"}:
        raise Failure("host memory evidence is incomplete")
    return values


def preflight(source_sha: str, workspace: Path, *, deploying: bool) -> CandidateManifest:
    note("preflight")
    host("true", timeout=30)
    if deploying:
        git = ("git", "-C", str(REPO_ROOT))
        if run((*git, "status", "--porcelain", "-unormal")).strip():
            raise Failure("a production release requires a clean checkout")
        run((*git, "fetch", "--quiet", "origin", "main"), timeout=120)
        for revision in ("HEAD", "origin/main"):
            if run((*git, "rev-parse", revision)).strip() != source_sha:
                raise Failure(f"{revision} must equal the released SHA {source_sha}")
    candidate = resolve_candidate(source_sha, workspace)

    major = int(host("docker version --format '{{.Server.Version}}'").split(".")[0])
    if major < MIN_DOCKER_MAJOR:
        raise Failure(f"Docker Engine {major} cannot isolate the Codex bridge gateway")
    memory = meminfo()
    if (
        memory["MemTotal"] < MIN_MEMORY_TOTAL
        or memory["MemAvailable"] < MIN_MEMORY_AVAILABLE
        or memory["SwapTotal"] < MIN_SWAP_TOTAL
    ):
        raise Failure(f"host memory is below the release envelope: {memory}")
    free = int(host("df --output=avail -B1 /").splitlines()[1])
    if free < MIN_ROOT_FREE:
        raise Failure(f"host root filesystem has only {free} bytes free")
    host(f"sudo test -r {CONFIG_FILE} && sudo test -r {BACKUP_CONFIG_FILE}")
    # Docker cannot create the Codex host without its credential bind source;
    # after a reboot the operator unlocks that LUKS volume before releasing.
    host(f"sudo findmnt --noheadings --mountpoint {CODEX_STATE}")
    note(f"{memory['MemAvailable'] >> 20} MiB memory available, {free >> 30} GiB disk free")
    return candidate


def install_host_inputs() -> None:
    note("installing the declared host inputs")
    staged = host("mktemp -d /tmp/nexus-release.XXXXXXXX").strip()
    if re.fullmatch(r"/tmp/nexus-release\.[A-Za-z0-9]{8}", staged) is None:
        raise Failure("the host returned an invalid staging directory")
    sources = tuple(str(REPO_ROOT / "deploy/hetzner" / name) for name, _, _ in HOST_INPUTS)
    run(("scp", *SSH_OPTIONS, *sources, f"{SSH_TARGET}:{staged}/"), timeout=120)
    for name, destination, mode in HOST_INPUTS:
        host(f"sudo install -D -o root -g root -m {mode} {staged}/{name} {destination}")
    host(f"rm -r -- {staged}")
    host(f"sudo apparmor_parser --replace --skip-cache {APPARMOR_PROFILE}")
    host(f"sudo systemctl daemon-reload && sudo systemctl enable {BOOT_GUARD_SERVICE}")


# ---------------------------------------------------------------------------
# Guarantee: stop the writers, dump, verify the dump, upload it to private R2,
# and only then migrate, and only along the revision graph.
# ---------------------------------------------------------------------------


def database_revision() -> str:
    if not psql("SELECT COALESCE(to_regclass('public.alembic_version')::text, '')"):
        return ""
    rows = [row for row in psql("SELECT version_num FROM alembic_version").splitlines() if row]
    if not rows:
        return ""
    if len(rows) != 1 or REVISION.fullmatch(rows[0]) is None:
        raise Failure(f"the database has no single well-formed Alembic revision: {rows}")
    return rows[0]


def prove_ancestry(candidate: CandidateManifest, current: str) -> None:
    head = candidate.expected_database_revision
    proof = json.loads(
        host(
            f"docker run --rm --entrypoint /app/.venv/bin/python {candidate.images.api}"
            f" -c {shlex.quote(ANCESTRY)} {current} {head}",
            timeout=180,
        )
    )
    if proof != {"heads": [head], "ancestor": True}:
        raise Failure(f"database revision {current} does not descend from {head}: {proof}")


def backup(candidate: CandidateManifest, starting_revision: str) -> None:
    note("backing up the database to private R2")
    identity = psql(
        "SELECT current_database() || ':' || system_identifier FROM pg_control_system()"
    )
    state = f"{BACKUP_STATE_ROOT}/{candidate.source_sha}"
    host(f"sudo install -d -o root -g root -m 0750 {BACKUP_STATE_ROOT}")
    host(f"sudo install -d -o 10001 -g 10001 -m 0700 {state}")
    # A rerun after a partly applied migration finds the database past the
    # revision this release already dumped. That receipt is still the release's
    # pre-migration backup, so replay it instead of dumping the moved schema;
    # `create` refuses a receipt whose recorded inputs differ from its own.
    receipt = host(f"sudo cat {state}/receipt.json 2>/dev/null || true").strip()
    if receipt:
        starting_revision = json.loads(receipt)["evidence"]["starting_revision"]
        if REVISION.fullmatch(starting_revision) is None:
            raise Failure(f"the backup receipt records a malformed revision: {receipt[:200]}")
        note(f"replaying the backup receipt taken at revision {starting_revision}")
    # `create` streams pg_dump straight into a multipart upload, reads the
    # remote bytes back through pg_restore, and publishes a recovery manifest
    # beside the archive: one invocation is dump, verification and receipt.
    evidence = json.loads(
        compose(
            candidate,
            "run --rm --no-deps --no-TTY backup python -m nexus.release_backup create"
            f" --source-sha {candidate.source_sha}"
            f" --database-identity {shlex.quote(identity)}"
            f" --starting-revision {starting_revision} --state-directory /backup-state",
            profile="backup",
            environment=(
                f"NEXUS_BACKUP_CONFIG_FILE={BACKUP_CONFIG_FILE} NEXUS_BACKUP_STATE_DIRECTORY={state}"
            ),
            timeout=2000,
        )
    )
    if (
        evidence["key"] != f"releases/{candidate.source_sha}/database.dump"
        or evidence["database_identity"] != identity
        or evidence["starting_revision"] != starting_revision
        or SHA256.fullmatch(evidence["sha256"]) is None
        or evidence["byte_count"] < 1
    ):
        raise Failure(f"the verified backup evidence differs from this release: {evidence}")
    note(f"backup {evidence['bucket']}/{evidence['key']}, {evidence['byte_count']} bytes verified")


def migrate(candidate: CandidateManifest) -> None:
    note(f"migrating to {candidate.expected_database_revision}")
    compose(candidate, "run --rm --no-deps --no-TTY migration", profile="release", timeout=1800)
    reached = database_revision()
    if reached != candidate.expected_database_revision:
        raise Failure(f"the database is at {reached}, not {candidate.expected_database_revision}")


# ---------------------------------------------------------------------------
# Start, Caddy, health
# ---------------------------------------------------------------------------


def start(candidate: CandidateManifest) -> None:
    note("starting the candidate")
    compose(candidate, "up --detach --wait --wait-timeout 240", timeout=900)
    for service in SERVICES:
        status = health_status(service)
        if status != "healthy":
            raise Failure(f"{service} is {status}, not healthy")


def reload_caddy() -> None:
    note("activating the candidate Caddy configuration")
    desired = (REPO_ROOT / "deploy/hetzner/Caddyfile").read_bytes()
    # Adapt the candidate bytes before replacing the live file, so a malformed
    # Caddyfile can never reach the running proxy's bind mount.
    adapted = inside("caddy", "caddy adapt --config /dev/stdin --adapter caddyfile", stdin=desired)
    # `tee` truncates in place, so the container's bind mount keeps its inode.
    host(f"sudo tee {CADDYFILE} && sudo chown root:root {CADDYFILE}", stdin=desired)
    host(f"sudo chmod 0444 {CADDYFILE}")
    inside("caddy", "caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile")
    loaded = inside("caddy", "wget -q -O - http://127.0.0.1:2019/config/")
    if json.loads(loaded) != json.loads(adapted):
        raise Failure("Caddy did not load the candidate configuration")


def config_value(key: str) -> str:
    return host(f"sudo grep -m1 '^{key}=' {CONFIG_FILE}").strip().partition("=")[2].strip("\"'")


def health(candidate: CandidateManifest) -> None:
    note("proving backend and public health")
    expected = {
        "source_sha": candidate.source_sha,
        "expected_database_revision": candidate.expected_database_revision,
        "expected_oracle_manifest_digest": candidate.expected_oracle_manifest_digest,
    }
    version = json.loads(inside("api", "curl -fsS http://127.0.0.1:8000/version"))
    if {key: version["data"].get(key) for key in expected} != expected:
        raise Failure(f"the API runtime identity differs from the candidate: {version}")
    ready = json.loads(inside("api", "curl -fsS http://127.0.0.1:8000/readyz"))
    if ready != {"data": {"status": "ready"}}:
        raise Failure(f"the API is not ready: {ready}")
    for service in SERVICES:
        if service in {"postgres", "caddy"}:
            continue
        image = inspect(container(service))["Config"]["Image"]
        wanted = candidate.images.api if service == "api" else candidate.images.worker
        if image != wanted:
            raise Failure(f"{service} runs {image}, not the manifest digest {wanted}")
    public = f"https://{config_value('CADDY_SITE')}/version"
    body, cache_control = fetch_json(public)
    if {key: body["data"].get(key) for key in expected} != expected:
        raise Failure(f"{public} does not serve the candidate: {body}")
    if cache_control != "no-store":
        raise Failure(f"{public} is cacheable")
    note(f"{public} serves {candidate.source_sha}")


# ---------------------------------------------------------------------------
# Guarantee: the Codex agent host stays isolated. Every property below is
# DECLARED in docker-compose.yml, the AppArmor profile or the boot-guard unit;
# this asserts that the kernel and Docker actually applied the declaration,
# and that the sandbox cannot reach the data plane.
# ---------------------------------------------------------------------------


def service_address(service: str) -> str:
    networks = inspect(container(service))["NetworkSettings"]["Networks"]
    addresses = sorted({value["IPAddress"] for value in networks.values() if value["IPAddress"]})
    if len(addresses) != 1:
        raise Failure(f"{service} has no single IPv4 address: {addresses}")
    return addresses[0]


def assert_isolation() -> None:
    note("asserting Codex agent host isolation")
    if host(f"systemctl is-enabled {BOOT_GUARD_SERVICE}").strip() != "enabled":
        raise Failure("the Codex state boot guard is not enabled; Docker may start unguarded")
    findmnt = f"sudo findmnt --noheadings --output SOURCE,OPTIONS --mountpoint {CODEX_STATE}"
    mount = host(findmnt).split()
    options = set(mount[1].split(",")) if len(mount) == 2 else set()
    if mount[:1] != [CODEX_STATE_DEVICE] or not {"rw", "nosuid", "nodev", "noexec"} <= options:
        raise Failure(f"the Codex credential state is not the encrypted mount: {mount}")

    network = json.loads(host(f"docker network inspect {CODEX_PRIVATE_NETWORK}"))[0]
    gatewayed = any(entry.get("Gateway") for entry in network["IPAM"]["Config"])
    if network["Internal"] is not True or gatewayed:
        raise Failure("the Codex private network is not an isolated internal bridge")
    members = {value["Name"] for value in network["Containers"].values()}
    if members != {f"nexus-{CODEX_AGENT_HOST}-1", "nexus-codex-egress-policy-1"}:
        raise Failure(f"the Codex private network has unexpected members: {sorted(members)}")

    inspected = inspect(container(CODEX_AGENT_HOST))
    configuration = inspected["HostConfig"]
    if (
        inspected["AppArmorProfile"] != CODEX_AGENT_HOST
        or configuration["ReadonlyRootfs"] is not True
        or configuration["CapDrop"] != ["ALL"]
        or configuration["CapAdd"]
        or configuration["Privileged"] is not False
        or list(inspected["NetworkSettings"]["Networks"]) != [CODEX_PRIVATE_NETWORK]
    ):
        raise Failure("the Codex agent host runtime differs from its declared confinement")
    host_paths = [mount["Source"] for mount in inspected["Mounts"] if mount["Type"] != "volume"]
    if host_paths != [CODEX_CREDENTIAL]:
        raise Failure(f"the Codex agent host has unexpected host mounts: {host_paths}")

    denied = (
        f"{CODEX_PRIVATE_BRIDGE_IP}:80 {CODEX_PRIVATE_BRIDGE_IP}:443"
        f" {service_address('postgres')}:5432 {service_address('caddy')}:443"
    )
    inside(CODEX_AGENT_HOST, f"python -m apps.codex_agent.network_health --denied-targets {denied}")
    note(f"agent host confined; {denied} unreachable from it")


# ---------------------------------------------------------------------------


def release(source_sha: str, workspace: Path) -> None:
    candidate = preflight(source_sha, workspace, deploying=True)
    install_host_inputs()
    pull_image(candidate, candidate.images.api)
    pull_image(candidate, candidate.images.worker)

    starting_revision = database_revision()
    if starting_revision:
        prove_ancestry(candidate, starting_revision)
    note(
        f"stopping the writers at revision {starting_revision or '(none)'};"
        " the API is down from here until `up` succeeds"
    )
    compose(candidate, f"stop --timeout 30 {' '.join(WRITERS)}", timeout=300)
    if starting_revision:
        backup(candidate, starting_revision)
    elif psql("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") != "0":
        raise Failure(
            "the database holds tables but no Alembic revision; repair it before releasing"
        )
    else:
        note("the database is empty; there is nothing to back up")
    migrate(candidate)

    start(candidate)
    reload_caddy()
    health(candidate)
    assert_isolation()
    host(f"sudo tee {CURRENT_POINTER}", stdin=f"{source_sha}\n".encode())
    note(f"released {source_sha}")


def check(source_sha: str | None, workspace: Path) -> None:
    recorded = host(f"sudo cat {CURRENT_POINTER}").strip()
    if SHA.fullmatch(recorded) is None:
        raise Failure(f"the host current pointer is malformed: {recorded!r}")
    if source_sha is not None and source_sha != recorded:
        raise Failure(f"the host records {recorded}, not {source_sha}")
    note(f"the host records {recorded}")
    candidate = preflight(recorded, workspace, deploying=False)
    # A diagnostic reports everything it can see, so collect the problems and
    # raise once at the end rather than stopping at the first unhealthy service.
    problems: list[str] = []
    for service in SERVICES:
        status = health_status(service)
        note(f"{service}: {status}")
        if status != "healthy":
            problems.append(f"{service} is {status}, not healthy")
    for proof in (lambda: health(candidate), assert_isolation):
        try:
            proof()
        except Failure as failure:
            problems.append(str(failure))
    if problems:
        raise Failure("; ".join(problems))
    note("check passed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Release the Nexus backend to Hetzner.")
    parser.add_argument("source_sha", nargs="?")
    parser.add_argument(
        "--check",
        action="store_true",
        help="run preflight and the read-only proofs against the recorded release",
    )
    arguments = parser.parse_args(argv)
    source_sha: str | None = arguments.source_sha
    if source_sha is not None and SHA.fullmatch(source_sha) is None:
        parser.error("source SHA must be 40 lowercase hex characters")
    if not arguments.check and source_sha is None:
        parser.error("a release requires its source SHA")
    with tempfile.TemporaryDirectory(prefix="nexus-release.") as temporary:
        if arguments.check:
            check(source_sha, Path(temporary))
        else:
            release(str(source_sha), Path(temporary))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Failure, subprocess.TimeoutExpired, OSError, KeyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
