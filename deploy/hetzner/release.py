#!/usr/bin/env python3
"""Converge the Hetzner backend onto one immutable CI candidate, in one pass.

    PYTHONPATH=python uv run --project python --frozen --no-sync python deploy/hetzner/release.py <source-sha>
    PYTHONPATH=python uv run --project python --frozen --no-sync python deploy/hetzner/release.py <source-sha> \
      --model-cutover-snapshot <reviewed-json>  # crossing 0246
    PYTHONPATH=python uv run --project python --frozen --no-sync python deploy/hetzner/release.py --check [<source-sha>]

The flow is linear and idempotent; after any failure, fix the cause and rerun:

    preflight -> inputs -> images -> stop -> cutover census -> backup -> migrate -> convert captures
              -> up -> caddy -> health -> isolation -> current pointer

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
import time
import urllib.request
from pathlib import Path
from typing import Any

from nexus.model_cutover_archive import ModelCutoverSnapshot, ReviewedModelCutover
from nexus.release_artifact import CandidateManifest, load_candidate_manifest
from nexus.release_backup import BackupEvidence

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
BOOT_GUARD_SERVICE = "nexus-codex-state-boot-guard.service"
CODEX_STATE = "/srv/nexus/codex-state"
CODEX_STATE_DEVICE = "/dev/mapper/nexus-codex-state"
CODEX_CREDENTIAL = f"{CODEX_STATE}/codex/codex-personal/auth.json"
CODEX_ACCOUNT_ROOT = f"{CODEX_STATE}/codex/codex-personal"
CODEX_AGENT_HOST = "nexus-codex-agent-host"
CODEX_PRIVATE_NETWORK = "nexus_codex_private"
BACKUP_STATE_ROOT = "/var/backups/nexus/r2"
PRE_MODEL_HISTORY_CUTOVER_REVISIONS = frozenset(f"{number:04d}" for number in range(236, 246))
PRE_ORACLE_ONE_ROW_REVISIONS = frozenset(f"{number:04d}" for number in range(236, 262))

# Declared host inputs: the isolation contract lives in these files, and the
# release installs them before it converges anything.
HOST_INPUTS = (
    ("docker-compose.yml", COMPOSE_FILE, "0444"),
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


def prove_model_cutover_snapshot(
    candidate: CandidateManifest, reviewed: ReviewedModelCutover
) -> None:
    actual = ModelCutoverSnapshot.model_validate_json(
        compose(
            candidate,
            "run --rm --no-deps --no-TTY api"
            " /app/.venv/bin/python -m nexus.model_cutover_preflight --snapshot",
            timeout=180,
        )
    )
    if (
        actual.database_identity != reviewed.source_database_identity
        or actual.starting_revision != reviewed.starting_revision
        or actual.census != reviewed.census
    ):
        raise Failure("0246 database, revision or complete census changed since review")
    note("0246 complete database census matches the reviewed archive input")


def backup(candidate: CandidateManifest, starting_revision: str) -> BackupEvidence:
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
        recorded_revision = json.loads(receipt)["evidence"]["starting_revision"]
        if REVISION.fullmatch(recorded_revision) is None:
            raise Failure(f"the backup receipt records a malformed revision: {receipt[:200]}")
        if (
            starting_revision in PRE_MODEL_HISTORY_CUTOVER_REVISIONS
            and recorded_revision != starting_revision
        ):
            raise Failure(
                "0246 backup receipt differs from the actual starting revision; take a fresh exact backup"
            )
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


def migrate(candidate: CandidateManifest, reviewed: ReviewedModelCutover | None) -> None:
    note(f"migrating to {candidate.expected_database_revision}")
    if reviewed is None:
        compose(
            candidate,
            "run --rm --no-deps --no-TTY migration",
            profile="release",
            timeout=1800,
        )
    else:
        compose(
            candidate,
            "run --rm --no-deps --no-TTY --interactive migration"
            " /app/.venv/bin/python -m nexus.model_cutover_archive",
            profile="release",
            stdin=reviewed.model_dump_json().encode(),
            timeout=1800,
        )
    reached = database_revision()
    if reached != candidate.expected_database_revision:
        raise Failure(f"the database is at {reached}, not {candidate.expected_database_revision}")


def convert_browser_captures(candidate: CandidateManifest) -> None:
    """Finish the one-shot capture cutover while the API and workers are stopped."""

    command = "run --rm --no-deps --no-TTY migration nexus convert-browser-article-captures"
    pending = (
        "SELECT count(*) FROM media_source_attempts "
        "WHERE source_type = 'browser_article_capture' AND NOT (source_payload ? 'sha256')"
    )
    for attempt in (1, 2):
        note(f"browser capture conversion pass {attempt}")
        output = compose(candidate, command, profile="release", timeout=1800).strip()
        if output:
            print(output, flush=True)
        remaining = psql(pending)
        if remaining != "0":
            raise Failure(f"{remaining} browser capture attempts remain unconverted")
        if attempt == 2 and output:
            raise Failure("the second conversion pass did work")


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
    }
    version = json.loads(inside("api", "curl -fsS http://127.0.0.1:8000/version"))
    if {key: version["data"].get(key) for key in expected} != expected:
        raise Failure(f"the API runtime identity differs from the candidate: {version}")
    ready = json.loads(inside("api", "curl -fsS http://127.0.0.1:8000/readyz"))
    if ready != {"data": {"status": "ready"}}:
        raise Failure(f"the API is not ready: {ready}")
    for service in SERVICES:
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


def release(source_sha: str, workspace: Path, model_cutover_snapshot: Path | None) -> None:
    reviewed = (
        None
        if model_cutover_snapshot is None
        else ReviewedModelCutover.model_validate_json(model_cutover_snapshot.read_bytes())
    )
    if reviewed is not None and reviewed.target_source_sha != source_sha:
        raise Failure("reviewed model cutover names a different target source SHA")
    candidate = preflight(source_sha, workspace, deploying=True)
    install_host_inputs()
    pull_image(candidate, candidate.images.api)
    pull_image(candidate, candidate.images.worker)

    starting_revision = database_revision()
    if starting_revision:
        prove_ancestry(candidate, starting_revision)
    crossing_model_cutover = (
        starting_revision in PRE_MODEL_HISTORY_CUTOVER_REVISIONS
        and candidate.expected_database_revision not in PRE_MODEL_HISTORY_CUTOVER_REVISIONS
    )
    if crossing_model_cutover:
        if reviewed is None:
            raise Failure(
                "0246 requires --model-cutover-snapshot with reviewed disposition and actual restore evidence"
            )
        if (
            reviewed.starting_revision != starting_revision
            or reviewed.restore.target_revision != candidate.expected_database_revision
            or reviewed.deployed_source_sha != host(f"sudo cat {CURRENT_POINTER}").strip()
        ):
            raise Failure("reviewed model cutover differs from the actual source or revision")
        prove_model_cutover_snapshot(candidate, reviewed)
    elif reviewed is not None:
        raise Failure("--model-cutover-snapshot applies only when crossing 0246")
    if starting_revision in PRE_ORACLE_ONE_ROW_REVISIONS:
        # 0262 refuses unfinished oracle work the new worker cannot own, so the old
        # workers finish every oracle job first, with no api left to enqueue another.
        note("0262: stopping the api; the old workers finish every oracle job")
        compose(candidate, "stop --timeout 30 api", timeout=120)
        unfinished = ""
        for _ in range(120):
            unfinished = psql(
                "SELECT count(*) FROM background_jobs WHERE kind = 'oracle_reading_generate'"
                " AND status IN ('pending', 'running', 'failed')"
            )
            if unfinished == "0":
                break
            time.sleep(10)
        else:
            raise Failure(
                f"0262 blocked: {unfinished} oracle jobs still unfinished after 20 minutes"
            )
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
        if stopped_state["Status"] != "exited" or stopped_state["ExitCode"] != 0:
            raise Failure(
                f"{service} did not stop cleanly: "
                f"status={stopped_state['Status']} exit_code={stopped_state['ExitCode']}"
            )
    if starting_revision in {"0241", "0242", "0243", "0244"}:
        missing = psql("""
            SELECT COUNT(DISTINCT item.media_id)
            FROM reader_apparatus_items item
            LEFT JOIN reader_publications publication ON publication.media_id = item.media_id
            WHERE publication.media_id IS NULL
        """)
        if not missing.isdecimal():
            raise Failure(f"invalid apparatus publication count: {missing!r}")
        if int(missing):
            raise Failure(
                f"0245 blocked: {missing} apparatus media have no reader publication;"
                " repair their publication or stale apparatus before releasing"
            )
        note("0245 publication preflight: zero apparatus media without a reader publication")
    if reviewed is not None:
        prove_model_cutover_snapshot(candidate, reviewed)
        # The operator already restored this exact fresh archive and qualified
        # the target against it. Verification must never replace it with a dump.
        evidence = BackupEvidence.model_validate_json(
            compose(
                candidate,
                "run --rm --no-deps --no-TTY backup python -m nexus.release_backup verify"
                f" --source-sha {candidate.source_sha}"
                f" --database-identity {shlex.quote(reviewed.source_database_identity)}"
                f" --starting-revision {reviewed.starting_revision}"
                f" --sha256 {reviewed.backup.sha256} --byte-count {reviewed.backup.byte_count}",
                profile="backup",
                environment=f"NEXUS_BACKUP_CONFIG_FILE={BACKUP_CONFIG_FILE}",
                timeout=2000,
            )
        )
        if evidence != reviewed.backup:
            raise Failure("verified archive differs from the reviewed actual restore")
        prove_model_cutover_snapshot(candidate, reviewed)
    elif starting_revision:
        backup(candidate, starting_revision)
    elif psql("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") != "0":
        raise Failure(
            "the database holds tables but no Alembic revision; repair it before releasing"
        )
    else:
        note("the database is empty; there is nothing to back up")
    migrate(candidate, reviewed)
    convert_browser_captures(candidate)

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
    parser.add_argument(
        "--model-cutover-snapshot",
        type=Path,
        help="reviewed reset input with exact backup and actual restore evidence for migration 0246",
    )
    arguments = parser.parse_args(argv)
    source_sha: str | None = arguments.source_sha
    if source_sha is not None and SHA.fullmatch(source_sha) is None:
        parser.error("source SHA must be 40 lowercase hex characters")
    if not arguments.check and source_sha is None:
        parser.error("a release requires its source SHA")
    if arguments.check and arguments.model_cutover_snapshot is not None:
        parser.error("--model-cutover-snapshot is only used during release")
    with tempfile.TemporaryDirectory(prefix="nexus-release.") as temporary:
        if arguments.check:
            check(source_sha, Path(temporary))
        else:
            release(str(source_sha), Path(temporary), arguments.model_cutover_snapshot)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Failure, subprocess.TimeoutExpired, OSError, KeyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
