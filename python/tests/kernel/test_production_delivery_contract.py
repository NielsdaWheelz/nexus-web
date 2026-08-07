from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).parents[3]


def test_ci_setup_installs_every_platform_static_tool() -> None:
    setup = (REPO_ROOT / ".github/actions/setup-test/action.yml").read_text(
        encoding="utf-8",
    )

    assert "sudo apt-get install --yes --no-install-recommends cloud-init shellcheck" in setup
    assert "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f" in setup


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
        '"https://${deployment_url}/version"',
        '"https://${PRODUCTION_HOST}/version"',
        'promote "$bound_deployment_id"',
        "adopt-genesis-vercel-deployment",
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
        'printf \'%s\\n\' \'{"id":"prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs","name":"nexus-web","accountId":"team_fKVvTyTsMBQ7qFjccFO17BJL","autoAssignCustomDomains":false,"autoExposeSystemEnvs":true}\' >"$output"\n'
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
    assert '("stop", "--timeout", "30", *_WRITERS)' in controller


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
