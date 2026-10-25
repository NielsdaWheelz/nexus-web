#!/usr/bin/env python3
"""Converge the Hetzner backend onto one immutable CI candidate, in one pass.

    PYTHONPATH=python uv run --project python --frozen --no-sync python deploy/hetzner/release.py <source-sha>
    PYTHONPATH=python uv run --project python --frozen --no-sync python deploy/hetzner/release.py --check [<source-sha>]

The flow is linear and idempotent; after any failure, fix the cause and rerun:

    preflight -> inputs -> images -> stop -> backup -> postgres -> migrate -> up -> limits -> caddy
              -> health -> isolation -> current pointer -> prune

The whole pass holds the host backup lock, so the nightly backup never meets
stopped writers or a migration. `--check` runs preflight and the read-only
proofs against the SHA the host records. There is no attempt/resume state
machine: the host keeps one `current` pointer and nothing else. Every mutation
runs over ssh; the read-only proofs address containers by Compose project label,
so they need nothing installed on the host.
"""

import argparse
import json
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from nexus.release_artifact import CandidateManifest, load_candidate_manifest
from nexus.release_backup import (
    BackupEvidence,
    BackupFailure,
    database_identity,
    database_revision,
)

REPOSITORY = "NielsdaWheelz/nexus-web"
WORKFLOW = ".github/workflows/backend-images.yml"
SSH_TARGET = "nexus@nexus-prod"
SSH_OPTIONS = (
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "HostKeyAlias=5.78.194.235",
    "-o", "StrictHostKeyChecking=yes",
)  # fmt: skip

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = "/etc/nexus/docker-compose.yml"
CONFIG_FILE = "/etc/nexus/current.env"
BACKUP_CONFIG_FILE = "/etc/nexus/backup.env"
CADDYFILE = "/etc/nexus/Caddyfile"
CURRENT_POINTER = "/var/lib/nexus/releases/current"
BOOT_GUARD_SERVICE = "nexus-codex-state-boot-guard.service"
RESOURCE_SLICE = "system-nexus.slice"
CODEX_STATE = "/srv/nexus/codex-state"
CODEX_STATE_DEVICE = "/dev/mapper/nexus-codex-state"
CODEX_CREDENTIAL = f"{CODEX_STATE}/codex/codex-personal/auth.json"
CODEX_ACCOUNT_ROOT = f"{CODEX_STATE}/codex/codex-personal"
CODEX_AGENT_HOST = "nexus-codex-agent-host"
CODEX_PRIVATE_NETWORK = "nexus_codex_private"
BACKUP_STATE_ROOT = "/var/backups/nexus/r2"
NIGHTLY_TIMER = "nexus-nightly-backup.timer"
# The nightly service holds this lock for its whole run, at most 40 minutes.
BACKUP_LOCK = "/run/lock/nexus-backup.lock"
BACKUP_LOCK_WAIT = 45 * 60
BACKUP_MAX_AGE_HOURS = 36

# Declared host inputs: the isolation contract lives in these files, and the
# release installs them before it converges anything.
HOST_INPUTS = (
    ("docker-compose.yml", COMPOSE_FILE, "0444"),
    (RESOURCE_SLICE, f"/etc/systemd/system/{RESOURCE_SLICE}", "0644"),
    ("codex-state-boot-guard.sh", "/usr/local/sbin/nexus-codex-state-boot-guard", "0755"),
    ("nexus-codex-state-boot-guard.service", f"/etc/systemd/system/{BOOT_GUARD_SERVICE}", "0644"),
    (
        "docker-codex-state-guard.conf",
        "/etc/systemd/system/docker.service.d/20-nexus-codex-state-guard.conf",
        "0644",
    ),
    ("nightly-backup.sh", "/usr/local/sbin/nexus-nightly-backup", "0755"),
    (
        "nexus-nightly-backup.service",
        "/etc/systemd/system/nexus-nightly-backup.service",
        "0644",
    ),
    ("nexus-nightly-backup.timer", f"/etc/systemd/system/{NIGHTLY_TIMER}", "0644"),
)

WRITERS = ("api", "worker-interactive", "worker-background")
SERVICES = (
    "postgres",
    "caddy",
    "cloudflared",
    "api",
    "worker-interactive",
    "worker-background",
    "codex-egress-policy",
    CODEX_AGENT_HOST,
)

MIN_DOCKER_MAJOR = 28
MIN_MEMORY_TOTAL = 1900 * 1024 * 1024
MIN_MEMORY_AVAILABLE = 256 * 1024 * 1024
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
    stdin: bytes | None = None,
    timeout: int = 180,
) -> str:
    """Run one mutating `docker compose` command against the release project."""

    return host(
        f"sudo env API_IMAGE={candidate.images.api} WORKER_IMAGE={candidate.images.worker}"
        f" NEXUS_CONFIG_FILE={CONFIG_FILE} {environment}"
        f" docker compose --project-name nexus --env-file {CONFIG_FILE} --file {COMPOSE_FILE}"
        f"{' --profile ' + profile if profile else ''} {arguments}",
        stdin=stdin,
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
# Guarantee: the images come from attempt 1 of a main or release/ branch push
# for this exact SHA. The release requires that SHA to be merged into main.
# Reruns publish nothing; one unique artifact binds the deployed bytes by
# digest, OCI label and runtime identity.
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
    branch = detail["head_branch"]
    if branch != "main" and not (isinstance(branch, str) and branch.startswith("release/")):
        raise Failure(f"candidate workflow branch must be main or release/: {branch!r}")
    fields = ("path", "event", "head_sha", "conclusion", "run_attempt")
    provenance = {field: detail[field] for field in fields}
    expected = {
        "path": WORKFLOW,
        "event": "push",
        "head_sha": source_sha,
        "conclusion": "success",
        "run_attempt": 1,
    }
    if provenance != expected:
        raise Failure(
            "candidate images are not from attempt 1 of a push for this exact SHA: "
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
        if run((*git, "rev-parse", "HEAD")).strip() != source_sha:
            raise Failure(f"HEAD must equal the released SHA {source_sha}")
        run((*git, "merge-base", "--is-ancestor", source_sha, "origin/main"))
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
    connector = config_value("CLOUDFLARED_IMAGE")
    if re.fullmatch(r"cloudflare/cloudflared@sha256:[0-9a-f]{64}", connector) is None:
        raise Failure("CLOUDFLARED_IMAGE must pin the official connector by sha256 digest")
    token = config_value("NEXUS_CLOUDFLARED_TOKEN_FILE")
    if re.fullmatch(r"/etc/nexus/tunnel-config/[0-9a-f]{64}\.token", token) is None:
        raise Failure("the tunnel token path must name its private content-addressed file")
    token_mode = host(
        f"sudo test -f {token} && sudo test -s {token} && sudo stat -Lc '%u:%g:%a' {token}"
    ).strip()
    if token_mode != "0:65532:440":
        raise Failure("the tunnel token must be a root-owned regular file, group 65532, mode 0440")
    # Docker cannot create the Codex host without its credential bind source;
    # after a reboot the operator unlocks that LUKS volume before releasing.
    host(f"sudo findmnt --noheadings --mountpoint {CODEX_STATE}")
    note(f"{memory['MemAvailable'] >> 20} MiB memory available, {free >> 30} GiB disk free")
    return candidate


def assert_tunnel_token_readable(candidate: CandidateManifest) -> None:
    note("proving the connector uid can read its captured private token")
    token = config_value("NEXUS_CLOUDFLARED_TOKEN_FILE")
    mount = shlex.quote(f"type=bind,src={token},dst=/run/secrets/cloudflared-token,readonly")
    probe = shlex.quote(
        "from pathlib import Path; assert Path('/run/secrets/cloudflared-token').read_bytes().strip()"
    )
    host(
        "docker run --rm --network none --read-only --cap-drop ALL"
        " --security-opt no-new-privileges:true --user 65532:65532"
        " --memory 32m --memory-swap 32m --pids-limit 32"
        f" --mount {mount} --entrypoint /app/.venv/bin/python"
        f" {candidate.images.api} -B -c {probe}"
    )


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
    # The backup one-off (uid 10001) owns every receipt below this root, so a
    # prune can remove the receipts of the archives it deletes.
    host(f"sudo install -d -o 10001 -g 10001 -m 0700 {BACKUP_STATE_ROOT}")
    host(
        f"sudo systemctl daemon-reload && sudo systemctl enable {BOOT_GUARD_SERVICE}"
        f" && sudo systemctl enable --now {NIGHTLY_TIMER}"
    )
    host(f"sudo systemctl start {RESOURCE_SLICE}")


# ---------------------------------------------------------------------------
# Guarantee: stop the writers, dump, verify the dump, upload it to private R2,
# and only then migrate, and only along the revision graph.
# ---------------------------------------------------------------------------


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


def backup(candidate: CandidateManifest, starting_revision: str) -> BackupEvidence:
    note("backing up the database to private R2")
    identity = database_identity(psql)
    state = f"{BACKUP_STATE_ROOT}/{candidate.source_sha}"
    host(f"sudo install -d -o 10001 -g 10001 -m 0700 {state}")
    # A rerun after a partly applied migration finds the database past the
    # revision this release already dumped. That receipt is still the release's
    # pre-migration backup, so replay it instead of dumping the moved schema;
    # `create` refuses a receipt whose recorded inputs differ from its own.
    receipt = host(f"sudo cat {state}/receipt.json 2>/dev/null || true").strip()
    if receipt:
        recorded_revision = json.loads(receipt)["evidence"]["starting_revision"]
        if REVISION.fullmatch(recorded_revision) is None:
            raise Failure(f"the backup receipt records a malformed revision: {receipt[:200]}")
        starting_revision = recorded_revision
        note(f"replaying the backup receipt taken at revision {starting_revision}")
    # `create` streams pg_dump straight into a multipart upload, reads the
    # remote bytes back through pg_restore, and publishes a recovery manifest
    # beside the archive: one invocation is dump, verification and receipt.
    evidence = json.loads(
        compose(
            candidate,
            "run --rm --no-deps --no-TTY backup python -m nexus.release_backup create"
            f" --source-sha {candidate.source_sha}"
            f" --backup-key releases/{candidate.source_sha}/database.dump"
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
    return BackupEvidence.model_validate(evidence)


def prune(candidate: CandidateManifest) -> None:
    note("pruning expired database archives")
    deleted = json.loads(
        compose(
            candidate,
            "run --rm --no-deps --no-TTY backup python -m nexus.release_backup prune"
            " --receipt-root /backup-state",
            profile="backup",
            environment=(
                f"NEXUS_BACKUP_CONFIG_FILE={BACKUP_CONFIG_FILE}"
                f" NEXUS_BACKUP_STATE_DIRECTORY={BACKUP_STATE_ROOT}"
            ),
            timeout=600,
        )
    )["deleted"]
    note(f"deleted {len(deleted)} expired archives: {' '.join(deleted) or '(none)'}")


def assert_backup_fresh(candidate: CandidateManifest) -> None:
    """Report the newest archive; once the nightly timer is enabled, require it recent."""

    newest = json.loads(
        compose(
            candidate,
            "run --rm --no-deps --no-TTY backup python -m nexus.release_backup check",
            profile="backup",
            environment=f"NEXUS_BACKUP_CONFIG_FILE={BACKUP_CONFIG_FILE}",
        )
    )
    if not isinstance(newest, dict) or newest.keys() != {"newest_archive", "last_modified"}:
        raise Failure(f"the backup check reported {newest}, not the newest archive")
    timer = host(f"systemctl is-enabled {NIGHTLY_TIMER} || true").strip()
    if newest["newest_archive"] is None:
        note(f"the backup bucket holds no database archive; {NIGHTLY_TIMER} is {timer}")
        fresh = False
    else:
        age = datetime.now(UTC) - datetime.fromisoformat(newest["last_modified"])
        hours = age.total_seconds() / 3600
        note(
            f"newest database archive {newest['newest_archive']}, {hours:.1f} hours old;"
            f" {NIGHTLY_TIMER} is {timer}"
        )
        fresh = hours <= BACKUP_MAX_AGE_HOURS
    if timer == "enabled" and not fresh:
        raise Failure(f"no database archive is younger than {BACKUP_MAX_AGE_HOURS} hours")


def migrate(candidate: CandidateManifest) -> None:
    note(f"migrating to {candidate.expected_database_revision}")
    output = compose(
        candidate,
        "run --rm --no-deps --no-TTY migration",
        profile="release",
        timeout=1800,
    )
    print(output, end="", flush=True)
    reached = database_revision(psql)
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


def assert_resource_limits(candidate: CandidateManifest) -> None:
    """The persistent slice owns no-swap; each service retains its own memory cap."""

    note("asserting owned memory caps and inherited no-swap")
    unit_path = f"/etc/systemd/system/{RESOURCE_SLICE}"
    for name, destination in (("docker-compose.yml", COMPOSE_FILE), (RESOURCE_SLICE, unit_path)):
        expected = run(
            (
                "git",
                "-C",
                str(REPO_ROOT),
                "show",
                f"{candidate.source_sha}:deploy/hetzner/{name}",
            )
        )
        if host(f"sudo cat {destination}") != expected:
            raise Failure(f"installed {name} differs from candidate {candidate.source_sha}")
    # Filter on the host: Compose's expanded environment contains secrets.
    projection = (
        "import json,sys; print(json.dumps({name: {key: service.get(key) "
        "for key in ('cgroup_parent','mem_limit','memswap_limit')} "
        "for name,service in json.load(sys.stdin)['services'].items()}))"
    )
    declarations = json.loads(
        compose(candidate, f"config --format json | python3 -c {shlex.quote(projection)}")
    )
    parent = f"/system.slice/{RESOURCE_SLICE}"
    properties = dict(
        line.split("=", 1)
        for line in host(
            f"systemctl show {RESOURCE_SLICE}"
            " --property=ActiveState,ControlGroup,FragmentPath,MemorySwapMax"
        ).splitlines()
    )
    if properties != {
        "ActiveState": "active",
        "ControlGroup": parent,
        "FragmentPath": unit_path,
        "MemorySwapMax": "0",
    }:
        raise Failure(f"{RESOURCE_SLICE} is not the persistent active no-swap owner")
    parent_swap = host(
        f"sudo cat /sys/fs/cgroup{parent}/memory.swap.max"
        f" /sys/fs/cgroup{parent}/memory.swap.current"
    ).splitlines()
    if parent_swap != ["0", "0"]:
        raise Failure(f"{RESOURCE_SLICE} swap max/current is {parent_swap}, expected 0/0")
    for service in SERVICES:
        declared = declarations[service]
        inspected = inspect(container(service))
        configuration = inspected["HostConfig"]
        state = inspected["State"]
        cap = int(declared["mem_limit"])
        if (
            declared["cgroup_parent"] != RESOURCE_SLICE
            or cap <= 0
            or int(declared["memswap_limit"]) != cap
            or configuration["CgroupParent"] != RESOURCE_SLICE
            or configuration["Memory"] != cap
            or configuration["MemorySwap"] != cap
            or not state["Running"]
            or state["Pid"] <= 0
        ):
            raise Failure(f"{service} differs from its declared parent or memory/swap cap")
        membership = host(f"sudo cat /proc/{state['Pid']}/cgroup").splitlines()
        path = f"{parent}/docker-{inspected['Id']}.scope"
        if membership != [f"0::{path}"]:
            raise Failure(f"{service} is outside its declared cgroup: {membership}")
        limits = host(
            f"sudo cat /sys/fs/cgroup{path}/memory.max"
            f" /sys/fs/cgroup{path}/memory.swap.max /sys/fs/cgroup{path}/memory.swap.current"
        ).splitlines()
        if len(limits) != 3 or limits[0] != str(cap) or limits[2] != "0":
            raise Failure(f"{service} memory max/swap max/current differs: {limits}")
        note(f"{service}: memory max {cap}; leaf swap max {limits[1]}, effective max/current 0/0")


def install_caddy() -> None:
    note("installing the private candidate Caddy configuration")
    desired = (REPO_ROOT / "deploy/hetzner/Caddyfile").read_bytes()
    # Adapt the candidate bytes before replacing the live file, so a malformed
    # Caddyfile can never reach the running proxy's bind mount.
    inside("caddy", "caddy adapt --config /dev/stdin --adapter caddyfile", stdin=desired)
    # `tee` truncates in place, so the container's bind mount keeps its inode.
    host(f"sudo tee {CADDYFILE} && sudo chown root:root {CADDYFILE}", stdin=desired)
    host(f"sudo chmod 0444 {CADDYFILE}")


def reload_caddy() -> None:
    note("activating the candidate Caddy configuration")
    desired = (REPO_ROOT / "deploy/hetzner/Caddyfile").read_bytes()
    adapted = inside("caddy", "caddy adapt --config /dev/stdin --adapter caddyfile", stdin=desired)
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
    }
    version = json.loads(inside("api", "curl -fsS http://127.0.0.1:8000/version"))
    if {key: version["data"].get(key) for key in expected} != expected:
        raise Failure(f"the API runtime identity differs from the candidate: {version}")
    ready = json.loads(inside("api", "curl -fsS http://127.0.0.1:8000/readyz"))
    if ready != {"data": {"status": "ready"}}:
        raise Failure(f"the API is not ready: {ready}")
    for service in SERVICES:
        if service == "cloudflared":
            image = inspect(container(service))["Config"]["Image"]
            if image != config_value("CLOUDFLARED_IMAGE"):
                raise Failure("cloudflared does not run its pinned connector image")
            continue
        # Stock images, not built from this SHA (the proxy is pinned in the compose file).
        if service in {"postgres", "caddy", "codex-egress-policy"}:
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
# DECLARED in docker-compose.yml or the boot-guard unit; this asserts that the
# kernel and Docker applied it to the host and its network. The host's only
# peer is the egress proxy, whose pinned image and allowlist compose applies
# from the same file and nothing here re-inspects (the harness proves them).
# ---------------------------------------------------------------------------


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
    if network["Internal"] is not True or network["EnableIPv6"] is not False or gatewayed:
        raise Failure("the Codex private network is not an isolated internal bridge")
    members = {value["Name"] for value in network["Containers"].values()}
    if members != {
        f"nexus-{CODEX_AGENT_HOST}-1",
        "nexus-codex-egress-policy-1",
    }:
        raise Failure(f"the Codex private network has unexpected members: {sorted(members)}")
    inspected = inspect(container(CODEX_AGENT_HOST))
    configuration = inspected["HostConfig"]
    if (
        inspected["AppArmorProfile"] != "docker-default"
        or configuration["ReadonlyRootfs"] is not True
        or configuration["CapDrop"] != ["ALL"]
        or configuration["CapAdd"]
        or configuration["Privileged"] is not False
        or configuration["PortBindings"]
        or list(inspected["NetworkSettings"]["Networks"]) != [CODEX_PRIVATE_NETWORK]
    ):
        raise Failure("the Codex agent host runtime differs from its declared confinement")
    host_paths = [mount["Source"] for mount in inspected["Mounts"] if mount["Type"] == "bind"]
    if host_paths != [CODEX_ACCOUNT_ROOT]:
        raise Failure(f"the Codex agent host has unexpected host mounts: {host_paths}")
    note("agent host confined: internal network, its egress proxy the only peer")


# ---------------------------------------------------------------------------


def release(source_sha: str, workspace: Path) -> None:
    candidate = preflight(source_sha, workspace, deploying=True)
    install_host_inputs()
    pull_image(candidate, candidate.images.api)
    pull_image(candidate, candidate.images.worker)
    host(f"docker pull {config_value('CLOUDFLARED_IMAGE')}", timeout=900)
    postgres_image = config_value("POSTGRES_IMAGE")
    if re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", postgres_image) is None:
        raise Failure("POSTGRES_IMAGE must be an immutable image reference by sha256 digest")
    host(f"docker pull {shlex.quote(postgres_image)}", timeout=900)
    free = int(host("df --output=avail -B1 /").splitlines()[1])
    if free < MIN_ROOT_FREE:
        raise Failure(f"host root filesystem has only {free} bytes free after image pulls")

    assert_tunnel_token_readable(candidate)
    install_caddy()
    starting_revision = database_revision(psql)
    if starting_revision:
        prove_ancestry(candidate, starting_revision)
    note(
        f"stopping the writers at revision {starting_revision or '(none)'};"
        " the API is down from here until `up` succeeds"
    )
    compose(candidate, f"stop --timeout 30 {' '.join(WRITERS)}", timeout=300)
    compose(candidate, f"stop --timeout 45 {CODEX_AGENT_HOST}", timeout=120)
    for service in (*WRITERS, CODEX_AGENT_HOST):
        stopped_container = host(
            "docker ps --all --quiet"
            " --filter label=com.docker.compose.project=nexus"
            f" --filter label=com.docker.compose.service={service}"
            " --filter label=com.docker.compose.oneoff=False"
        ).strip()
        if not stopped_container:
            continue
        if CONTAINER_ID.fullmatch(stopped_container) is None:
            raise Failure(f"{service} has ambiguous containers")
        stopped_state = inspect(stopped_container)["State"]
        if (
            stopped_state["Status"] != "exited"
            or stopped_state["Running"]
            or stopped_state["Pid"] != 0
            or stopped_state["OOMKilled"]
            or stopped_state["Error"]
            or stopped_state["ExitCode"] != 0
        ):
            raise Failure(
                f"{service} did not stop cleanly: "
                f"status={stopped_state['Status']} exit_code={stopped_state['ExitCode']} "
                f"running={stopped_state['Running']} pid={stopped_state['Pid']} "
                f"oom_killed={stopped_state['OOMKilled']} "
                f"runtime_error={bool(stopped_state['Error'])}"
            )
    if starting_revision:
        backup(candidate, starting_revision)
    elif psql("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") != "0":
        raise Failure(
            "the database holds tables but no Alembic revision; repair it before releasing"
        )
    else:
        note("the database is empty; there is nothing to back up")

    # A backup receipt can describe an earlier revision on a rerun. Compare the
    # live database across recreation, before any migration changes it.
    identity = database_identity(psql)
    revision = database_revision(psql)
    note("converging postgres before migration, with writers stopped")
    compose(
        candidate,
        "up --detach --no-deps --wait --wait-timeout 120 postgres",
        timeout=900,
    )
    postgres = inspect(container("postgres"))
    expected_image = json.loads(host(f"docker image inspect {shlex.quote(postgres_image)}"))[0][
        "Id"
    ]
    if postgres["Config"]["Image"] != postgres_image or postgres["Image"] != expected_image:
        raise Failure("postgres does not run the configured immutable image")
    limits = postgres["HostConfig"]
    if (
        limits["Memory"] != 512 * 1024**2
        or limits["MemorySwap"] != 512 * 1024**2
        or limits["ShmSize"] != 128 * 1024**2
        or psql("SHOW shared_buffers") != "64MB"
    ):
        raise Failure("postgres requires 512 MiB/no swap, 128 MiB shm and 64 MiB shared buffers")
    if database_identity(psql) != identity or database_revision(psql) != revision:
        raise Failure("postgres recreation changed the database identity or revision")
    version = int(psql("SHOW server_version_num"))
    preloaded = psql("SHOW shared_preload_libraries")
    available = psql(
        "SELECT EXISTS (SELECT 1 FROM pg_available_extension_versions"
        " WHERE name = 'pg_search' AND version = '0.26.2')"
    )
    if (
        not 150000 <= version < 160000
        or "pg_search" not in {name.strip() for name in preloaded.split(",")}
        or available != "t"
    ):
        raise Failure("postgres requires pg15 with preloaded pg_search 0.26.2 available")
    migrate(candidate)

    start(candidate)
    assert_resource_limits(candidate)
    reload_caddy()
    health(candidate)
    assert_isolation()
    host(f"sudo tee {CURRENT_POINTER}", stdin=f"{source_sha}\n".encode())
    note(f"released {source_sha}")
    # Retention follows only this release's verified backup. The nightly job
    # prunes again, so a failure here leaves the finished release standing.
    if starting_revision:
        try:
            prune(candidate)
        except (Failure, subprocess.TimeoutExpired) as failure:
            note(f"pruning failed, the nightly backup prunes again: {failure}")


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
    for proof in (
        lambda: assert_tunnel_token_readable(candidate),
        lambda: health(candidate),
        lambda: assert_resource_limits(candidate),
        assert_isolation,
        lambda: assert_backup_fresh(candidate),
    ):
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
            return 0
        # One ssh session holds the host backup lock for the whole release:
        # closing its stdin, or losing this process, releases it. A nightly
        # backup skips while it is held; a release waits out a running one.
        note(f"taking {BACKUP_LOCK}, waiting up to {BACKUP_LOCK_WAIT // 60} minutes")
        with subprocess.Popen(
            (
                "ssh",
                *SSH_OPTIONS,
                SSH_TARGET,
                f"sudo flock --wait {BACKUP_LOCK_WAIT} {BACKUP_LOCK}"
                " sh -c 'echo held && exec cat >/dev/null'",
            ),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        ) as lock:
            if lock.stdout is None or lock.stdout.readline() != b"held\n":
                raise Failure(
                    f"could not take {BACKUP_LOCK}: ssh failed or a nightly backup ran on"
                )
            release(str(source_sha), Path(temporary))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        Failure,
        BackupFailure,
        subprocess.TimeoutExpired,
        OSError,
        KeyError,
        ValueError,
    ) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
