import json
import subprocess
import sys
from pathlib import Path

import pytest

from nexus_test_control.build import (
    _next_build_lock,
    ensure_standalone_build,
    standalone_build_fingerprint,
)
from nexus_test_control.runtime import RuntimeContractError, RuntimePorts, initialize_runtime

TEST_ENV = {"NEXUS_ENV": "test"}
PUBLIC_KEY = "sb_publishable_local-public-test-key"


def _ports() -> RuntimePorts:
    return RuntimePorts(15432, 19000, 25421, 25422, 25423, 25424, 25425, 18000, 13000, 19091)


def _repository(tmp_path: Path) -> Path:
    web = tmp_path / "apps" / "web"
    (web / "src" / "app").mkdir(parents=True)
    (web / "src" / "app" / "page.tsx").write_text("export default function Page() {}\n")
    (web / "src" / "app" / "page.test.tsx").write_text("test source is not product source\n")
    (web / "public").mkdir()
    (web / "public" / "icon.svg").write_text("<svg />\n")
    (web / "public" / "pdfjs").mkdir()
    (web / "public" / "pdfjs" / "generated.js").write_text("generated\n")
    (web / "patches").mkdir()
    (web / "patches" / "dependency.patch").write_text("patch\n")
    (web / "scripts").mkdir()
    for relative in (
        "bun.lock",
        "next.config.ts",
        "package.json",
        "scripts/check-bundle.mjs",
        "scripts/copy-pdfjs.mjs",
        "tsconfig.json",
    ):
        (web / relative).write_text(f"{relative}\n")
    initialize_runtime(tmp_path, TEST_ENV, _ports())
    return tmp_path


def _fake_bun(repo_root: Path) -> Path:
    executable = repo_root / "fake-bin" / "bun"
    executable.parent.mkdir()
    executable.write_text(
        f"#!{sys.executable}\n"
        "import json\n"
        "import os\n"
        "import pathlib\n"
        "import sys\n"
        "root = pathlib.Path.cwd()\n"
        "log = root / 'build-invocation.json'\n"
        "previous = json.loads(log.read_text()) if log.exists() else []\n"
        "previous.append({'argv': sys.argv[1:], 'cwd': str(root), 'env': dict(os.environ)})\n"
        "log.write_text(json.dumps(previous))\n"
        "if sys.argv[1:] != ['run', 'build']:\n"
        "    raise SystemExit(0)\n"
        "standalone = root / '.next' / 'standalone'\n"
        "server_root = standalone / 'apps' / 'web'\n"
        "server_root.mkdir(parents=True)\n"
        "(server_root / 'server.js').write_text('server')\n"
        "dependency = standalone / 'node_modules' / 'dependency'\n"
        "dependency.mkdir(parents=True)\n"
        "(dependency / 'server.js').write_text('dependency')\n"
        "static = root / '.next' / 'static'\n"
        "static.mkdir(parents=True)\n"
        "(static / 'chunk.js').write_text('chunk')\n",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    return executable


def test_fingerprint_tracks_product_build_inputs_and_exact_public_environment(
    tmp_path: Path,
) -> None:
    root = _repository(tmp_path)
    original = standalone_build_fingerprint(root, TEST_ENV, PUBLIC_KEY)

    (root / "apps" / "web" / "src" / "app" / "page.test.tsx").write_text("changed test\n")
    (root / "apps" / "web" / "public" / "pdfjs" / "generated.js").write_text(
        "changed generated output\n"
    )
    assert standalone_build_fingerprint(root, TEST_ENV, PUBLIC_KEY) == original

    (root / "apps" / "web" / "src" / "app" / "page.tsx").write_text("changed product\n")
    changed_source = standalone_build_fingerprint(root, TEST_ENV, PUBLIC_KEY)
    assert changed_source != original

    assert (
        standalone_build_fingerprint(root, TEST_ENV, "sb_publishable_another-public-key")
        != changed_source
    )


@pytest.mark.parametrize(
    "relative",
    (
        "bun.lock",
        "next.config.ts",
        "package.json",
        "scripts/check-bundle.mjs",
        "scripts/copy-pdfjs.mjs",
        "tsconfig.json",
        "patches/dependency.patch",
        "public/icon.svg",
    ),
)
def test_fingerprint_tracks_each_lock_config_build_script_patch_and_public_asset(
    tmp_path: Path, relative: str
) -> None:
    root = _repository(tmp_path)
    original = standalone_build_fingerprint(root, TEST_ENV, PUBLIC_KEY)

    (root / "apps" / "web" / relative).write_text("changed build input\n")

    assert standalone_build_fingerprint(root, TEST_ENV, PUBLIC_KEY) != original


def test_next_build_lock_is_cross_process_visible_under_runtime_state(tmp_path: Path) -> None:
    root = _repository(tmp_path)

    with _next_build_lock(root, TEST_ENV) as path:
        assert path == root / ".nexus-test" / "locks" / "next-build.lock"
        completed = subprocess.run(
            (
                sys.executable,
                "-c",
                "import fcntl, pathlib, sys; "
                "f = pathlib.Path(sys.argv[1]).open('a+b'); "
                "fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)",
                str(path),
            ),
            check=False,
            capture_output=True,
            text=True,
        )

    assert completed.returncode != 0
    assert "BlockingIOError" in completed.stderr


def test_build_is_fixed_isolated_atomic_and_reused_once_per_fingerprint(
    tmp_path: Path,
) -> None:
    root = _repository(tmp_path)
    fake_bun = _fake_bun(root)
    environment = {
        "NEXUS_ENV": "test",
        "PATH": str(fake_bun.parent),
        "DATABASE_URL": "postgresql://production.example/nexus",
        "E2E_DISABLE_CSP": "1",
        "NEXUS_INTERNAL_SECRET": "must-not-enter-build",
        "R2_SECRET_ACCESS_KEY": "must-not-enter-build",
        "SUPABASE_AUTH_ADMIN_KEY": "must-not-enter-build",
    }
    fingerprint = standalone_build_fingerprint(root, environment, PUBLIC_KEY)
    incomplete = root / ".nexus-test" / "builds" / fingerprint
    incomplete.mkdir(parents=True)
    (incomplete / "server.js").write_text("incomplete")

    artifact = ensure_standalone_build(root, environment, PUBLIC_KEY)

    assert artifact.root == incomplete
    assert artifact.server == incomplete / "apps" / "web" / "server.js"
    assert artifact.server.read_text() == "server"
    assert (artifact.server.parent / "public" / "icon.svg").read_text() == "<svg />\n"
    assert (artifact.server.parent / "public" / "pdfjs" / "generated.js").is_file()
    assert (artifact.server.parent / ".next" / "static" / "chunk.js").read_text() == "chunk"
    metadata = json.loads((artifact.root / ".nexus-build.json").read_text())
    assert metadata["fingerprint"] == fingerprint
    assert metadata["server"] == "apps/web/server.js"
    assert metadata["strict_csp"] is True

    invocations = json.loads((root / "apps" / "web" / "build-invocation.json").read_text())
    assert len(invocations) == 2
    invocation = invocations[0]
    assert invocation["argv"] == ["run", "build"]
    assert invocations[1]["argv"] == ["run", "check:bundle"]
    assert invocation["cwd"] == str(root / "apps" / "web")
    child = invocation["env"]
    assert child["NEXUS_ENV"] == "test"
    assert child["NODE_ENV"] == "production"
    assert child["APP_PUBLIC_URL"] == "http://127.0.0.1:13000"
    assert child["FASTAPI_BASE_URL"] == "http://127.0.0.1:18000"
    assert child["R2_S3_API_ORIGIN"] == "http://127.0.0.1:19000"
    assert child["NEXT_PUBLIC_SUPABASE_URL"] == "http://127.0.0.1:25421"
    assert child["NEXT_PUBLIC_SUPABASE_ANON_KEY"] == PUBLIC_KEY
    for rejected in (
        "DATABASE_URL",
        "E2E_DISABLE_CSP",
        "NEXUS_INTERNAL_SECRET",
        "R2_SECRET_ACCESS_KEY",
        "SUPABASE_AUTH_ADMIN_KEY",
    ):
        assert rejected not in child

    assert ensure_standalone_build(root, environment, PUBLIC_KEY) == artifact
    assert len(json.loads((root / "apps" / "web" / "build-invocation.json").read_text())) == 2

    (root / "apps" / "web" / "src" / "app" / "page.tsx").write_text("changed product\n")
    changed_artifact = ensure_standalone_build(root, environment, PUBLIC_KEY)

    assert changed_artifact.fingerprint != artifact.fingerprint
    assert changed_artifact.root != artifact.root
    assert artifact.server.read_text() == "server"
    assert len(json.loads((root / "apps" / "web" / "build-invocation.json").read_text())) == 4
    assert ensure_standalone_build(root, environment, PUBLIC_KEY) == changed_artifact
    assert len(json.loads((root / "apps" / "web" / "build-invocation.json").read_text())) == 4


def test_invalid_or_ambiguous_output_is_never_published(tmp_path: Path) -> None:
    root = _repository(tmp_path)
    fake_bun = _fake_bun(root)
    script = fake_bun.read_text()
    fake_bun.write_text(
        script
        + "other = standalone / 'other'\n"
        + "other.mkdir()\n"
        + "(other / 'server.js').write_text('other')\n"
    )
    environment = {"NEXUS_ENV": "test", "PATH": str(fake_bun.parent)}
    fingerprint = standalone_build_fingerprint(root, environment, PUBLIC_KEY)

    with pytest.raises(RuntimeContractError, match="one generated server.js"):
        ensure_standalone_build(root, environment, PUBLIC_KEY)

    assert not (root / ".nexus-test" / "builds" / fingerprint).exists()
    assert not tuple((root / ".nexus-test" / "builds").glob(".*-*"))


def test_next_autoloaded_environment_files_cannot_enter_the_build(tmp_path: Path) -> None:
    root = _repository(tmp_path)
    fake_bun = _fake_bun(root)
    (root / "apps" / "web" / ".env.local").write_text(
        "NEXUS_INTERNAL_SECRET=must-not-enter-build\n"
    )

    with pytest.raises(RuntimeContractError, match="refuses local environment files"):
        ensure_standalone_build(
            root,
            {"NEXUS_ENV": "test", "PATH": str(fake_bun.parent)},
            PUBLIC_KEY,
        )

    assert not (root / "apps" / "web" / "build-invocation.json").exists()


def test_build_rejects_non_test_environment_and_blank_public_key(tmp_path: Path) -> None:
    root = _repository(tmp_path)

    with pytest.raises(RuntimeContractError, match="NEXUS_ENV"):
        standalone_build_fingerprint(root, {"NEXUS_ENV": "prod"}, PUBLIC_KEY)
    with pytest.raises(RuntimeContractError, match="public key"):
        standalone_build_fingerprint(root, TEST_ENV, "")
    with pytest.raises(RuntimeContractError, match="public key"):
        standalone_build_fingerprint(root, TEST_ENV, "sb_secret_local-admin-key")
