from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import cast

REPO_ROOT = Path(__file__).parents[3]


def test_ci_setup_installs_every_platform_static_tool() -> None:
    setup = (REPO_ROOT / ".github/actions/setup-test/action.yml").read_text(
        encoding="utf-8",
    )

    assert "for tool in cloud-init shellcheck; do" in setup
    assert 'sudo apt-get install --yes --no-install-recommends "${missing[@]}"' in setup
    assert "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f" in setup
    assert "github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4" in setup
    assert 'go version -m "$caddy_bin"' in setup
    assert "github.com/caddyserver/caddy/v2\\tv2.11.4\\t" in setup
    assert '"$caddy_bin" version >/dev/null' in setup


def test_ci_setup_survives_a_persistent_self_hosted_workspace() -> None:
    """Setup must never crash before the control plane can report a verdict.

    The protected release job runs on a persistent self-hosted host: its
    `_work` tree, and therefore the sibling external-suite checkouts, survives
    between runs, and passwordless `sudo` and a container runtime are not
    guaranteed. A setup step that aborts produces no evidence at all, which is
    strictly worse than the fail-closed `not_run` the control plane would emit.
    """
    setup = (REPO_ROOT / ".github/actions/setup-test/action.yml").read_text(
        encoding="utf-8",
    )

    assert 'test ! -e "$checkout"' not in setup, (
        "the provider-runtime checkout still requires a pristine workspace and "
        "fails on every run after the first on a persistent runner"
    )
    assert 'case "$(basename "$checkout")" in' in setup
    assert "llm-calling|llm-tools)" in setup
    assert 'rm -rf "$checkout"' in setup
    assert 'test "$(git -C "$checkout" rev-parse HEAD)" = "$revision"' in setup

    assert "if ! sudo -n true >/dev/null 2>&1; then" in setup
    for step in setup.split("\n    - name: ")[1:]:
        if "sudo " in step:
            assert "if ! sudo -n true >/dev/null 2>&1; then" in step, (
                f"setup step uses sudo without the passwordless guard: {step.splitlines()[0]}"
            )
    assert "steps.container.outputs.docker == 'true'" in setup


def test_deploy_is_one_exact_immutable_staged_release_path() -> None:
    script = (REPO_ROOT / "deploy/hetzner/deploy.sh").read_text(encoding="utf-8")
    resolver = (REPO_ROOT / "deploy/hetzner/fetch-release-bundle.sh").read_text(encoding="utf-8")

    for required in (
        "usage: deploy/hetzner/deploy.sh <source-sha>",
        "fetch-release-bundle.sh",
        'readonly PRODUCTION_HOST="nexus.nielseriknandal.com"',
        'readonly VERCEL_PROJECT_ID="prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs"',
        'readonly VERCEL_TEAM_ID="team_fKVvTyTsMBQ7qFjccFO17BJL"',
        "/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}",
        "/v13/deployments/${bound_deployment_id}?teamId=${VERCEL_TEAM_ID}",
        "/v2/aliases/${PRODUCTION_HOST}?teamId=${VERCEL_TEAM_ID}",
        '"https://${deployment_url}/version"',
        '"https://${PRODUCTION_HOST}/version"',
        'promote "$bound_deployment_id"',
        'alias set "$deployment_url" "$PRODUCTION_HOST"',
        "authoritative Vercel deployment is unknown before host mutation",
        "apply",
        "finalize",
    ):
        assert required in script

    for required in (
        "actions/artifacts?name=${ARTIFACT_NAME}",
        "candidate manifest does not bind the artifact owner",
        "/attempts/1",
        '.path == ".github/workflows/backend-images.yml"',
        '.path == ".github/workflows/ci.yml"',
        ".source_ci_run_attempt == 1",
        ".publisher_run_attempt == 1",
    ):
        assert required in resolver

    assert "head_sha == $sha" not in script
    assert "actions/workflows/backend-images.yml/runs" not in script

    for forbidden in (
        "rsync",
        "force" + "-recreate",
        "docker build",
        "docker tag",
        "git checkout",
        "sync-env.sh",
        "reconcile-oracle.sh",
        "adopt-genesis-vercel-deployment",
        "genesis_vercel_deployment",
        "adopt-infrastructure.py",
    ):
        assert forbidden not in script


def test_config_publication_is_explicit_fresh_and_python_owned() -> None:
    script = (REPO_ROOT / "deploy/hetzner/sync-env.sh").read_text(encoding="utf-8")

    for required in (
        "<never-published-source-sha>",
        "require_duplicate_free_env",
        "POSTGRES_IMAGE",
        "CADDY_IMAGE",
        "publish-config",
        "--next-source-sha",
        'python3 -B "${remote_directory}/release.py"',
        "PYTHONDONTWRITEBYTECODE=1",
        '"${ROOT_DIR}/python/nexus/release_artifact.py"',
    ):
        assert required in script

    assert "sudo install" not in script
    assert "NEXUS_REMOTE_ENV_FILE" not in script
    assert "NEXUS_ENV_FILE" not in script


def test_worker_ingest_egress_owner_is_baked_and_cannot_be_reconfigured_by_env() -> None:
    dockerfile = (REPO_ROOT / "docker/Dockerfile.backend").read_text(encoding="utf-8")
    dockerignore = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")
    worker_env = (REPO_ROOT / "deploy/env/env-prod-worker.example").read_text(encoding="utf-8")
    publisher = (REPO_ROOT / "deploy/hetzner/release.py").read_text(encoding="utf-8")
    validator = (REPO_ROOT / "deploy/hetzner/sync-env.sh").read_text(encoding="utf-8")

    assert (
        "COPY node/ingest/accepted_url_egress.mjs ./node/ingest/accepted_url_egress.mjs"
        in dockerfile
    )
    assert "ENV NODE_INGEST_SCRIPT=" not in dockerfile
    assert "!node/ingest/accepted_url_egress.mjs" in dockerignore
    assert "NODE_INGEST_SCRIPT" not in worker_env
    assert '"NODE_INGEST_SCRIPT",' not in publisher
    assert "reject_node_ingest_script" in validator


def test_vercel_config_rejects_cross_file_duplicates_before_provider_mutation(
    tmp_path: Path,
) -> None:
    script = tmp_path / "deploy/vercel/sync-env.sh"
    script.parent.mkdir(parents=True)
    script.write_bytes((REPO_ROOT / "deploy/vercel/sync-env.sh").read_bytes())
    script.chmod(0o755)
    web = tmp_path / "apps/web"
    project = web / ".vercel/project.json"
    project.parent.mkdir(parents=True)
    project.write_text(
        '{"orgId":"team_fKVvTyTsMBQ7qFjccFO17BJL",'
        '"projectId":"prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs",'
        '"projectName":"nexus-web"}\n',
        encoding="utf-8",
    )
    marker = tmp_path / "provider-mutated"
    vercel = web / "node_modules/.bin/vercel"
    vercel.parent.mkdir(parents=True)
    vercel.write_text(
        '#!/usr/bin/env bash\ntouch "${NEXUS_TEST_MARKER:?}"\nexit 1\n',
        encoding="utf-8",
    )
    vercel.chmod(0o755)
    shared = tmp_path / "shared.env"
    frontend = tmp_path / "frontend.env"
    shared.write_text("NEXUS_INTERNAL_SECRET=shared\n", encoding="utf-8")
    frontend.write_text("NEXUS_INTERNAL_SECRET=frontend\n", encoding="utf-8")
    environment = {
        **os.environ,
        "NEXUS_SHARED_ENV": str(shared),
        "NEXUS_FRONTEND_ENV": str(frontend),
        "NEXUS_TEST_MARKER": str(marker),
        "VERCEL_TOKEN": "test-token",
    }

    completed = subprocess.run(
        ("bash", str(script)),
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode != 0
    assert "globally unique keys" in completed.stderr
    assert not marker.exists()


def test_vercel_config_rejects_stale_optional_values_after_pull(
    tmp_path: Path,
) -> None:
    script = tmp_path / "deploy/vercel/sync-env.sh"
    script.parent.mkdir(parents=True)
    script.write_bytes((REPO_ROOT / "deploy/vercel/sync-env.sh").read_bytes())
    script.chmod(0o755)
    web = tmp_path / "apps/web"
    project = web / ".vercel/project.json"
    project.parent.mkdir(parents=True)
    project.write_text(
        '{"orgId":"team_fKVvTyTsMBQ7qFjccFO17BJL",'
        '"projectId":"prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs",'
        '"projectName":"nexus-web"}\n',
        encoding="utf-8",
    )
    vercel = web / "node_modules/.bin/vercel"
    vercel.parent.mkdir(parents=True)
    vercel.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'case "$2" in\n'
        "  rm) exit 1 ;;\n"
        "  add) cat >/dev/null; exit 0 ;;\n"
        '  pull) cp "${NEXUS_TEST_PULL_FILE:?}" "$3"; exit 0 ;;\n'
        "  *) exit 1 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    vercel.chmod(0o755)
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    curl = fake_bin / "curl"
    curl.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "output=\n"
        "while (($#)); do\n"
        '  if [ "$1" = --output ]; then output=$2; shift 2; continue; fi\n'
        "  shift\n"
        "done\n"
        'printf \'%s\\n\' \'{"id":"prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs","name":"nexus-web","accountId":"team_fKVvTyTsMBQ7qFjccFO17BJL","autoAssignCustomDomains":false,"autoExposeSystemEnvs":true,"ssoProtection":{"deploymentType":"preview"}}\' >"$output"\n'
        "printf '200'\n",
        encoding="utf-8",
    )
    curl.chmod(0o755)
    shared = tmp_path / "shared.env"
    shared.write_text(
        "NEXUS_ENV=prod\n"
        "APP_PUBLIC_URL=https://web.example.test\n"
        "SUPABASE_ISSUER=https://api.example.test/auth/v1\n"
        "SUPABASE_JWKS_URL=https://api.example.test/auth/v1/.well-known/jwks.json\n"
        "SUPABASE_AUDIENCES=authenticated\n"
        "NEXUS_INTERNAL_SECRET=secret\n"
        "STREAM_CORS_ORIGINS=https://web.example.test\n"
        "R2_S3_API_ORIGIN=https://account.r2.cloudflarestorage.com\n",
        encoding="utf-8",
    )
    frontend = tmp_path / "frontend.env"
    frontend.write_text(
        "AUTH_ALLOWED_REDIRECT_ORIGINS=https://web.example.test\n"
        "SERVER_ACTION_ALLOWED_ORIGINS=web.example.test\n"
        "NEXUS_EXTENSION_REDIRECT_ORIGINS=https://web.example.test\n"
        "NEXT_PUBLIC_SUPABASE_URL=https://api.example.test\n"
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon\n"
        "FASTAPI_BASE_URL=https://api.example.test\n",
        encoding="utf-8",
    )
    pulled = tmp_path / "pulled.env"
    pulled.write_text(
        "NEXUS_ENV=prod\n"
        "APP_PUBLIC_URL=https://web.example.test\n"
        "SUPABASE_ISSUER=https://api.example.test/auth/v1\n"
        "SUPABASE_JWKS_URL=https://api.example.test/auth/v1/.well-known/jwks.json\n"
        "SUPABASE_AUDIENCES=authenticated\n"
        "STREAM_CORS_ORIGINS=https://web.example.test\n"
        "R2_S3_API_ORIGIN=https://account.r2.cloudflarestorage.com\n"
        "AUTH_ALLOWED_REDIRECT_ORIGINS=https://web.example.test\n"
        "SERVER_ACTION_ALLOWED_ORIGINS=web.example.test\n"
        "NEXUS_EXTENSION_REDIRECT_ORIGINS=https://web.example.test\n"
        "NEXT_PUBLIC_SUPABASE_URL=https://api.example.test\n"
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon\n"
        "FASTAPI_BASE_URL=https://api.example.test\n"
        "AUTH_TRUSTED_PROXY_ORIGINS=https://stale.example.test\n",
        encoding="utf-8",
    )
    environment = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "NEXUS_SHARED_ENV": str(shared),
        "NEXUS_FRONTEND_ENV": str(frontend),
        "NEXUS_TEST_PULL_FILE": str(pulled),
        "VERCEL_TOKEN": "test-token",
    }

    completed = subprocess.run(
        ("bash", str(script)),
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode != 0
    assert "stale optional AUTH_TRUSTED_PROXY_ORIGINS remains" in completed.stderr


def test_production_compose_is_topology_only_and_app_activation_is_narrow() -> None:
    compose = (REPO_ROOT / "deploy/hetzner/docker-compose.yml").read_text(encoding="utf-8")
    controller = (REPO_ROOT / "deploy/hetzner/release.py").read_text(encoding="utf-8")

    for image_variable in ("POSTGRES_IMAGE", "CADDY_IMAGE", "API_IMAGE", "WORKER_IMAGE"):
        assert f"${{{image_variable}:?" in compose
    assert "build:" not in compose
    assert "image: nexus-" not in compose
    assert "/etc/nexus/Caddyfile:/etc/caddy/Caddyfile:ro" in compose
    for activation_contract in (
        '"up",',
        '"--detach",',
        '"--no-deps",',
        '"--wait",',
        '"--wait-timeout",',
    ):
        assert activation_contract in controller
    assert 'arguments=("stop", "--timeout", "30", "worker-background")' in controller


def test_background_worker_can_start_before_api_readiness() -> None:
    compose = (REPO_ROOT / "deploy/hetzner/docker-compose.yml").read_text(encoding="utf-8")
    interactive_start = compose.index("  worker-interactive:\n")
    background_start = compose.index("  worker-background:\n")
    migration_start = compose.index("  migration:\n")

    interactive = compose[interactive_start:background_start]
    background = compose[background_start:migration_start]

    # The background lane owns reconciliation freshness, so API readiness may
    # depend on it. Its only startup prerequisite is the durable queue owner.
    assert "      postgres:\n        condition: service_healthy\n" in background
    assert "      api:\n" not in background

    # The interactive lane does not produce reconciliation freshness and can
    # remain sequenced behind the ready API without creating a dependency cycle.
    assert "      api:\n        condition: service_healthy\n" in interactive


def test_production_compose_declares_the_exact_resource_envelope() -> None:
    compose = (REPO_ROOT / "deploy/hetzner/docker-compose.yml").read_text(encoding="utf-8")

    expected = (
        ("postgres", "256m", "512m", 256),
        ("caddy", "32m", "48m", 128),
        ("api", "192m", "320m", 256),
        ("worker-interactive", "128m", "256m", 256),
        ("worker-background", "128m", "448m", 256),
        ("nexus-codex-agent-host", "128m", "384m", 64),
        ("migration", "256m", "512m", 256),
    )
    for index, (service, reservation, hard, pids) in enumerate(expected):
        start = compose.index(f"  {service}:\n")
        end = (
            compose.index(f"  {expected[index + 1][0]}:\n")
            if index + 1 < len(expected)
            else compose.index("\nvolumes:\n")
        )
        block = compose[start:end]
        assert f"mem_reservation: {reservation}" in block
        assert f"mem_limit: {hard}" in block
        # Equal values deny the container swap, so the hard limit bounds RAM+swap.
        # Docker otherwise defaults memoryswap to twice the memory limit.
        assert f"memswap_limit: {hard}" in block
        assert f"pids_limit: {pids}" in block

    background = compose[compose.index("  worker-background:\n") : compose.index("  migration:\n")]
    assert "/var/lib/nexus/parser-tmp:/var/lib/nexus/parser-tmp" in background
    assert (
        'test: ["CMD", "python", "-S", "-m", "apps.worker.health", '
        '"--lane", "interactive"]' in compose
    )
    assert (
        'test: ["CMD", "python", "-S", "-m", "apps.worker.health", '
        '"--lane", "background"]' in compose
    )


def test_the_declared_envelope_fits_the_committed_host_with_its_reserve() -> None:
    """The long-lived services must fit the smallest committed host and still
    leave the host reserve free.

    Sizing the envelope against a host's nominal RAM rather than its real
    MemTotal leaves the reserve short, which the release preflight can only
    discover against production -- after CI has passed and the release SHA is
    already on main.
    """
    controller = (REPO_ROOT / "deploy/hetzner/release.py").read_text(encoding="utf-8")
    namespace: dict[str, object] = {}
    for name in (
        "_SERVICES",
        "_CODEX_AGENT_HOST",
        "_CAPACITY_SERVICES",
        "_RESOURCE_LIMITS",
        "_MIN_HOST_MEMORY_BYTES",
    ):
        start = controller.index(f"{name} = ")
        exec(controller[start : controller.index("\n_", start + 1)], namespace)  # noqa: S102
    reserved = 320 * 1024 * 1024
    limits = cast(dict[str, tuple[int, int, int]], namespace["_RESOURCE_LIMITS"])
    services = cast(tuple[str, ...], namespace["_CAPACITY_SERVICES"])
    host_floor = cast(int, namespace["_MIN_HOST_MEMORY_BYTES"])

    reservation_sum = sum(limits[service][0] for service in services)
    assert host_floor - reservation_sum >= reserved, (
        f"declared reservation envelope leaves {(host_floor - reservation_sum) / 1048576:.2f} MiB "
        f"on a {host_floor / 1048576:.0f} MiB host; the reserve floor is "
        f"{reserved / 1048576:.0f} MiB"
    )

    compose = (REPO_ROOT / "deploy/hetzner/docker-compose.yml").read_text(encoding="utf-8")
    for service, (reservation, hard, pids) in limits.items():
        # Anchor to the line start: `      api:` under `depends_on` also contains
        # `  api:`, so an unanchored search reads the wrong block.
        start = compose.index(f"\n  {service}:\n")
        block = compose[start : start + 400]
        assert f"mem_reservation: {reservation // (1024 * 1024)}m" in block
        assert f"mem_limit: {hard // (1024 * 1024)}m" in block
        assert f"memswap_limit: {hard // (1024 * 1024)}m" in block
        assert f"pids_limit: {pids}" in block


def test_caddy_runtime_logs_redact_sensitive_request_headers() -> None:
    caddyfile = (REPO_ROOT / "deploy/hetzner/Caddyfile").read_text(encoding="utf-8")

    assert "log default" in caddyfile
    assert "request>headers>Authorization delete" in caddyfile
    assert "request>headers>Cookie delete" in caddyfile
    assert "request>headers>X-Nexus-Internal delete" in caddyfile


def test_caddy_offline_package_lane_matches_only_one_canonical_uuid_path() -> None:
    """The unencoded long-timeout proxy exemption is exact, not a prefix grant."""
    caddyfile = (REPO_ROOT / "deploy/hetzner/Caddyfile").read_text(encoding="utf-8")
    matcher = re.search(
        r"^\s*@offline_reading_package path_regexp (\S+)\s*$",
        caddyfile,
        flags=re.MULTILINE,
    )
    assert matcher is not None, "offline package Caddy route must use one exact path_regexp"
    path_pattern = re.compile(matcher.group(1))

    cases = {
        "/offline-reading/packages/11111111-1111-4111-8111-111111111111": True,
        "/offline-reading/packages/11111111-1111-4111-8111-111111111111/extra": False,
        "/offline-reading/packages/not-a-uuid": False,
        "/offline-reading/packages/11111111-1111-4111-8111-11111111111A": False,
        "/offline-reading/packages": False,
    }
    assert {path: path_pattern.fullmatch(path) is not None for path in cases} == cases, (
        f"Caddy offline package matcher drifted: {matcher.group(1)!r}"
    )

    package_handle_start = caddyfile.index("handle @offline_reading_package")
    fallback_handle_start = caddyfile.index("\n\t\thandle {", package_handle_start)
    package_handle = caddyfile[package_handle_start:fallback_handle_start]
    fallback_handle = caddyfile[fallback_handle_start:]
    assert "encode " not in package_handle
    assert "dial_timeout 20s" in package_handle
    assert "response_header_timeout 660s" in package_handle
    assert "read_timeout 3600s" in package_handle
    assert "write_timeout 3600s" in package_handle
    assert "encode zstd gzip" in fallback_handle


def test_permanent_resource_sharing_firewall_has_no_cutover_mode() -> None:
    script = REPO_ROOT / "deploy/vercel/sync-resource-sharing-firewall.sh"
    source = script.read_text(encoding="utf-8")

    completed = subprocess.run(
        (str(script), "--check"),
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
        text=True,
        timeout=10,
    )

    assert "no network request" in completed.stdout
    assert "maintenance" not in source
    assert not (REPO_ROOT / "deploy/vercel/firewall/resource-sharing-maintenance.json").exists()
