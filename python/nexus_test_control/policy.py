from __future__ import annotations

import ast
import hashlib
import json
import re
import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Any


@dataclass(frozen=True)
class PolicyViolation:
    rule: str
    path: str
    message: str
    line: int | None = None


_BUILTIN_PYTEST_MARKS = frozenset({"filterwarnings", "parametrize", "usefixtures"})
_OWNED_MODULE_PREFIXES = ("nexus", "nexus_test_control")
_RAW_SQL_SETUP = re.compile(r"^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b", re.I)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_REQUIRED_JOURNEY_IDS = frozenset({"nexus-search-open-restore"})
_SECRET = re.compile(
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
    rb"|\b(?:sk|ghp)_[A-Za-z0-9_-]{20,}\b"
    rb"|\bAKIA[0-9A-Z]{16}\b"
)
_CONTROL_DATA = frozenset(
    {
        "testdata/manifest.json",
        "testdata/proofs.json",
        "testdata/policy-exceptions.json",
        "testdata/faults/manifest.json",
    }
)
_NORMATIVE_PATHS = (
    "docs/local-rules/testing-standards.md",
    "docs/local-rules/index.md",
    "docs/local-rules/codebase.md",
    "docs/rules/boundaries.md",
    "docs/rules/cleanliness.md",
    "docs/rules/codebase.md",
    "docs/rules/correctness.md",
    "docs/rules/database.md",
    "docs/rules/overrides.md",
    "docs/rules/retries.md",
    "docs/rules/simplicity.md",
    "docs/rules/testing.md",
    "docs/rules/timing.md",
)
_RETIRED_TEST_PATHS = (
    "e2e",
    "scripts/with_test_services.sh",
    "scripts/with_supabase_services.sh",
    "scripts/test_env.sh",
    "scripts/find_port.sh",
    "python/scripts/seed_real_media_e2e.py",
    "python/scripts/seed_e2e_data.py",
    "python/scripts/seed_oracle_plate_e2e.py",
)
_ROUTE_CONTRACT: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "scripts/test": (
        ("exec uv run --frozen --no-sync python -m nexus_test_control",),
        ("make test", "pytest", "playwright"),
    ),
    "scripts/agency_verify.sh": (
        ("exec ./scripts/test confidence",),
        ("make test", "pytest", "playwright"),
    ),
    "scripts/agency_setup.sh": (
        ("uv sync --all-extras --locked", "bun install --frozen-lockfile"),
        ("DATABASE_URL_TEST", "nexus_test", "tests/test_db.py", "make test"),
    ),
    ".github/workflows/ci.yml": (
        ("run: ./scripts/test pr", "if: always()"),
        ("make test", "pytest", "playwright test"),
    ),
    ".github/workflows/nightly.yml": (
        ('NEXUS_HOSTED_CANARY: "1"', "script: ./scripts/test nightly"),
        ("make test",),
    ),
    ".github/workflows/release.yml": (
        ('NEXUS_PROVIDER_CERTIFICATION: "1"', "script: ./scripts/test release"),
        ("make test",),
    ),
    "docs/local-rules/index.md": (
        ("testing-standards.md",),
        ("testing_standards.md",),
    ),
    "docs/local-rules/codebase.md": (
        ("apps/web/e2e/", "testdata/", "typed test control plane"),
        ("- `e2e/`",),
    ),
    "docs/local-rules/testing-standards.md": (
        (
            "./scripts/test confidence",
            "./scripts/test prove",
            "## 11. Local test-runtime safety",
            "nexus-run-<run-id>",
        ),
        (
            "make test",
            "make verify",
            "test_verifier",
            "## 11. Recovery and production proof",
        ),
    ),
    "README.md": (
        ("./scripts/test changed", "./scripts/test confidence", "./scripts/test pr"),
        ("make test-", "make verify", "PLAYWRIGHT_ARGS", "DATABASE_URL_TEST"),
    ),
    "python/README.md": (
        ("./scripts/test changed", "./scripts/test confidence", "./scripts/test pr"),
        ("make test-", "make verify", "pytest-xdist"),
    ),
    "apps/web/README.md": (
        ("./scripts/test changed", "./scripts/test confidence", "./scripts/test pr"),
        ("make test-", "make verify", "PLAYWRIGHT_ARGS", "CI shards"),
    ),
    "docs/architecture.md": (
        ("./scripts/test", "testing-standards.md", "apps/web/e2e/"),
        ("testing_standards.md", "make test-", "make verify", "PLAYWRIGHT_ARGS"),
    ),
    ".env.example": (
        ("NEXUS_ENV=local",),
        (
            "DATABASE_URL_TEST",
            "TEST_POSTGRES_PORT",
            "TEST_MINIO_PORT",
            "PLAYWRIGHT_ARGS",
            "E2E_DISABLE_CSP",
            "E2E_USER_EMAIL",
        ),
    ),
}


def _sorted(violations: list[PolicyViolation]) -> tuple[PolicyViolation, ...]:
    return tuple(sorted(violations, key=lambda item: (item.path, item.line or 0, item.rule)))


def _attribute_parts(node: ast.AST) -> tuple[str, ...]:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return tuple(reversed(parts))


def python_ast_violations(path: str, source: str) -> tuple[PolicyViolation, ...]:
    """Check mechanical Python proof rules without importing the proof."""
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        return (PolicyViolation("python-syntax", path, error.msg, error.lineno),)

    violations: list[PolicyViolation] = []
    owned_aliases: set[str] = set()
    sleep_modules = {"asyncio", "time", "anyio", "trio"}
    sleep_aliases: set[str] = set()
    skip_aliases: set[str] = set()
    mark_aliases: set[str] = set()
    socket_enable_aliases: set[str] = set()
    pytest_aliases = {"pytest"}
    unittest_aliases = {"unittest"}

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "unittest.mock" or alias.name.startswith("unittest.mock."):
                    violations.append(
                        PolicyViolation(
                            "python-internal-mock", path, "unittest.mock is forbidden", node.lineno
                        )
                    )
                if alias.name == "pytest":
                    pytest_aliases.add(alias.asname or alias.name)
                if alias.name == "unittest":
                    unittest_aliases.add(alias.asname or alias.name)
                if alias.name.startswith(_OWNED_MODULE_PREFIXES):
                    owned_aliases.add(alias.asname or alias.name.split(".", 1)[0])
                if alias.name in sleep_modules:
                    sleep_modules.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module == "unittest.mock" or (
                module == "unittest" and any(a.name == "mock" for a in node.names)
            ):
                violations.append(
                    PolicyViolation(
                        "python-internal-mock", path, "unittest.mock is forbidden", node.lineno
                    )
                )
            if module.startswith(_OWNED_MODULE_PREFIXES):
                owned_aliases.update(alias.asname or alias.name for alias in node.names)
            if module in {"asyncio", "time", "anyio", "trio"}:
                sleep_aliases.update(
                    alias.asname or alias.name for alias in node.names if alias.name == "sleep"
                )
            if module in {"pytest", "unittest"}:
                skip_aliases.update(
                    alias.asname or alias.name
                    for alias in node.names
                    if alias.name in {"skip", "skipif", "xfail"}
                )
            if module == "pytest":
                mark_aliases.update(
                    alias.asname or alias.name for alias in node.names if alias.name == "mark"
                )
            if module == "pytest_socket":
                socket_enable_aliases.update(
                    alias.asname or alias.name
                    for alias in node.names
                    if alias.name == "enable_socket"
                )

    hosted = path.startswith("python/tests/hosted/")
    raw_sql_owner = path.startswith("python/tests/migrations/") or path == (
        "python/tests/testkit/unreachable_state.py"
    )

    for node in ast.walk(tree):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                target = decorator.func if isinstance(decorator, ast.Call) else decorator
                parts = _attribute_parts(target)
                marker: str | None = None
                if len(parts) >= 3 and parts[0] in pytest_aliases and parts[1] == "mark":
                    marker = parts[2]
                elif len(parts) >= 2 and parts[0] in mark_aliases:
                    marker = parts[1]
                if marker is not None:
                    if marker not in {
                        *_BUILTIN_PYTEST_MARKS,
                        "skip",
                        "skipif",
                        "xfail",
                    }:
                        violations.append(
                            PolicyViolation(
                                "python-unregistered-marker",
                                path,
                                f"unregistered marker: {marker}",
                                node.lineno,
                            )
                        )

        if isinstance(node, ast.Attribute):
            parts = _attribute_parts(node)
            pytest_skip = (
                len(parts) >= 3
                and parts[0] in pytest_aliases
                and parts[1] == "mark"
                and parts[2] in {"skip", "skipif", "xfail"}
            )
            imported_skip = (
                len(parts) >= 2
                and parts[0] in mark_aliases
                and parts[1] in {"skip", "skipif", "xfail"}
            )
            if pytest_skip or imported_skip:
                violations.append(
                    PolicyViolation(
                        "python-skip", path, "skip and xfail are forbidden", node.lineno
                    )
                )
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith(
            "test_"
        ):
            body = node.body
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                body = body[1:]
            if len(body) == 1 and (
                isinstance(body[0], ast.Pass)
                or isinstance(body[0], ast.Return)
                and body[0].value is None
                or (
                    isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and body[0].value.value is Ellipsis
                )
            ):
                violations.append(
                    PolicyViolation(
                        "python-vacuous-proof",
                        path,
                        "proof body cannot be pass or ellipsis",
                        node.lineno,
                    )
                )
            elif not body:
                violations.append(
                    PolicyViolation(
                        "python-vacuous-proof",
                        path,
                        "proof body cannot contain only a docstring",
                        node.lineno,
                    )
                )

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not hosted:
            argument_names = {
                argument.arg for argument in (*node.args.posonlyargs, *node.args.args)
            }
            if "socket_enabled" in argument_names:
                violations.append(
                    PolicyViolation(
                        "python-network-enablement",
                        path,
                        "socket_enabled is allowed only in hosted proof",
                        node.lineno,
                    )
                )

        if not isinstance(node, ast.Call):
            continue
        parts = _attribute_parts(node.func)
        leaf = parts[-1] if parts else ""

        if leaf in sleep_aliases or (leaf == "sleep" and parts and parts[0] in sleep_modules):
            violations.append(
                PolicyViolation(
                    "python-sleep", path, "proof must observe a condition, not sleep", node.lineno
                )
            )

        if leaf in skip_aliases or (
            leaf in {"skip", "skipif", "xfail"}
            and (not parts or parts[0] in pytest_aliases | unittest_aliases)
        ):
            violations.append(
                PolicyViolation("python-skip", path, "skip and xfail are forbidden", node.lineno)
            )

        if leaf == "setattr" and parts and parts[0] == "monkeypatch" and node.args:
            target = node.args[0]
            target_parts = _attribute_parts(target)
            string_target = target.value if isinstance(target, ast.Constant) else None
            if (target_parts and target_parts[0] in owned_aliases) or (
                isinstance(string_target, str) and string_target.startswith(_OWNED_MODULE_PREFIXES)
            ):
                violations.append(
                    PolicyViolation(
                        "python-owned-monkeypatch",
                        path,
                        "owned Nexus behavior may not be monkeypatched",
                        node.lineno,
                    )
                )

        if not hosted and (leaf in socket_enable_aliases or leaf == "enable_socket"):
            violations.append(
                PolicyViolation(
                    "python-network-enablement",
                    path,
                    "socket enablement is allowed only in hosted proof",
                    node.lineno,
                )
            )

        if not raw_sql_owner and leaf in {"text", "execute", "exec_driver_sql"} and node.args:
            sql = node.args[0].value if isinstance(node.args[0], ast.Constant) else None
            if isinstance(sql, str) and _RAW_SQL_SETUP.match(sql):
                violations.append(
                    PolicyViolation(
                        "python-raw-sql",
                        path,
                        "raw SQL setup belongs to migrations or unreachable-state testkit",
                        node.lineno,
                    )
                )

    return _sorted(violations)


def repository_violations(repo_root: Path) -> tuple[PolicyViolation, ...]:
    """Check the small repository-level contracts that are mechanically decisive."""
    violations: list[PolicyViolation] = []
    scan_paths = [repo_root / "Makefile", repo_root / "python/pyproject.toml"]
    scan_paths.extend((repo_root / ".github/workflows").glob("*.yml"))
    scan_paths.extend(repo_root.glob("**/playwright.config.*"))
    for candidate in scan_paths:
        if not candidate.is_file() or "node_modules" in candidate.parts:
            continue
        relative = candidate.relative_to(repo_root).as_posix()
        text = candidate.read_text(encoding="utf-8")
        if re.search(r"(?:^|\s)-n\s+auto(?:\s|$)|--shard(?:=|\s)", text):
            violations.append(
                PolicyViolation(
                    "repository-worker-cap", relative, "unbounded workers/shards are forbidden"
                )
            )
        for match in re.finditer(r"\bworkers\s*[:=]\s*(\d+)", text):
            if int(match.group(1)) > 1:
                violations.append(
                    PolicyViolation(
                        "repository-worker-cap", relative, "heavy runners use one worker"
                    )
                )
        if re.search(r"\bretries\s*[:=]\s*[1-9]\d*|--retries(?:=|\s+)[1-9]\d*", text):
            violations.append(
                PolicyViolation(
                    "repository-automatic-retry", relative, "automatic retries are forbidden"
                )
            )

    configs = sorted(
        path.relative_to(repo_root).as_posix()
        for path in repo_root.glob("**/playwright.config.*")
        if path.is_file() and "node_modules" not in path.parts
    )
    if configs != ["apps/web/e2e/playwright.config.ts"]:
        violations.append(
            PolicyViolation(
                "repository-playwright-owner",
                ".",
                "Playwright must have one config at apps/web/e2e/playwright.config.ts",
            )
        )

    pyproject_path = repo_root / "python/pyproject.toml"
    if pyproject_path.is_file():
        pyproject = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
        warnings = (
            pyproject.get("tool", {})
            .get("pytest", {})
            .get("ini_options", {})
            .get("filterwarnings", [])
        )
        if "error::UserWarning" not in warnings:
            violations.append(
                PolicyViolation(
                    "repository-warning-policy",
                    "python/pyproject.toml",
                    "pytest must fail on UserWarning",
                )
            )

    for relative in _NORMATIVE_PATHS:
        if not (repo_root / relative).is_file():
            violations.append(
                PolicyViolation("repository-normative-link", relative, "normative owner is missing")
            )
    for relative in _RETIRED_TEST_PATHS:
        if (repo_root / relative).exists():
            violations.append(
                PolicyViolation(
                    "repository-retired-test-path",
                    relative,
                    "hard-cut legacy test path must remain absent",
                )
            )
    for relative, (required, forbidden) in _ROUTE_CONTRACT.items():
        path = repo_root / relative
        if not path.is_file():
            violations.append(
                PolicyViolation(
                    "repository-route-contract",
                    relative,
                    "required test route owner is absent",
                )
            )
            continue
        text = path.read_text(encoding="utf-8")
        missing = tuple(fragment for fragment in required if fragment not in text)
        stale = tuple(fragment for fragment in forbidden if fragment in text)
        if missing or stale:
            violations.append(
                PolicyViolation(
                    "repository-route-contract",
                    relative,
                    f"missing={missing}; stale={stale}",
                )
            )
    makefile = repo_root / "Makefile"
    if makefile.is_file() and re.search(
        r"(?m)^(?:test|check|verify)(?:-[a-z0-9_-]+)?\s*:",
        makefile.read_text(encoding="utf-8"),
    ):
        violations.append(
            PolicyViolation(
                "repository-route-contract",
                "Makefile",
                "test and verification targets are forbidden compatibility aliases",
            )
        )
    return _sorted(violations)


def _load_json(
    repo_root: Path, relative: str, rule: str
) -> tuple[Any | None, list[PolicyViolation]]:
    path = repo_root / relative
    try:
        return json.loads(path.read_text(encoding="utf-8")), []
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, [PolicyViolation(rule, relative, f"cannot read valid JSON: {error}")]


def _safe_relative(value: str, *, glob: bool = False) -> bool:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or "\\" in value:
        return False
    if str(path) != value:
        return False
    return glob or not any(character in value for character in "*?[]")


def _string_list(value: Any, *, allow_empty: bool) -> bool:
    return (
        isinstance(value, list)
        and (allow_empty or bool(value))
        and all(isinstance(item, str) and item for item in value)
        and len(value) == len(set(value))
    )


def proof_manifest_schema_violations(repo_root: Path) -> tuple[PolicyViolation, ...]:
    relative = "testdata/proofs.json"
    data, violations = _load_json(repo_root, relative, "proof-schema")
    if data is None:
        return _sorted(violations)
    if not isinstance(data, dict) or set(data) != {"version", "priority_risks", "journeys"}:
        return (PolicyViolation("proof-schema", relative, "unexpected top-level proof schema"),)
    if (
        data["version"] != 1
        or not isinstance(data["priority_risks"], list)
        or not isinstance(data["journeys"], list)
    ):
        return (PolicyViolation("proof-schema", relative, "invalid proof schema version or lists"),)

    from nexus_test_control.model import PRIORITY_RISK_FLOOR, Capability

    required_ids = {risk.value for risk in PRIORITY_RISK_FLOOR}
    capability_ids = {capability.value for capability in Capability}
    seen_ids: list[str] = []
    for index, risk in enumerate(data["priority_risks"]):
        location = f"{relative}#priority_risks[{index}]"
        if not isinstance(risk, dict) or set(risk) != {
            "id",
            "source_globs",
            "proofs",
            "capabilities",
        }:
            violations.append(
                PolicyViolation("proof-schema", location, "invalid priority-risk shape")
            )
            continue
        risk_id = risk["id"]
        if not isinstance(risk_id, str):
            violations.append(PolicyViolation("proof-schema", location, "risk id must be a string"))
        else:
            seen_ids.append(risk_id)
        if not _string_list(risk["source_globs"], allow_empty=False) or not all(
            _safe_relative(item, glob=True) for item in risk["source_globs"]
        ):
            violations.append(PolicyViolation("proof-schema", location, "invalid source globs"))
        if not _string_list(risk["proofs"], allow_empty=True):
            violations.append(PolicyViolation("proof-schema", location, "invalid proof nodes"))
        if not _string_list(risk["capabilities"], allow_empty=True) or any(
            item not in capability_ids for item in risk["capabilities"]
        ):
            violations.append(PolicyViolation("proof-schema", location, "invalid capabilities"))

    if set(seen_ids) != required_ids or len(seen_ids) != len(required_ids):
        violations.append(
            PolicyViolation(
                "proof-risk-floor", relative, "priority risk ids must exactly equal the typed floor"
            )
        )

    for index, journey in enumerate(data["journeys"]):
        location = f"{relative}#journeys[{index}]"
        if not isinstance(journey, dict) or set(journey) != {
            "id",
            "proof",
            "risks",
            "source_globs",
        }:
            violations.append(PolicyViolation("proof-schema", location, "invalid journey shape"))
            continue
        if not isinstance(journey["id"], str) or not _SLUG.fullmatch(journey["id"]):
            violations.append(PolicyViolation("proof-schema", location, "invalid journey id"))
        if not isinstance(journey["proof"], str) or not _safe_relative(journey["proof"]):
            violations.append(
                PolicyViolation("proof-schema", location, "invalid journey proof path")
            )
        if not _string_list(journey["risks"], allow_empty=True) or any(
            risk not in required_ids for risk in journey["risks"]
        ):
            violations.append(PolicyViolation("proof-schema", location, "invalid journey risks"))
        if not _string_list(journey["source_globs"], allow_empty=False) or not all(
            _safe_relative(item, glob=True) for item in journey["source_globs"]
        ):
            violations.append(
                PolicyViolation("proof-schema", location, "invalid journey source globs")
            )
    return _sorted(violations)


def proof_contract_violations(repo_root: Path) -> tuple[PolicyViolation, ...]:
    schema = list(proof_manifest_schema_violations(repo_root))
    if schema:
        return _sorted(schema)
    data = json.loads((repo_root / "testdata/proofs.json").read_text(encoding="utf-8"))
    violations: list[PolicyViolation] = []
    proof_owners: dict[str, str] = {}
    for risk in data["priority_risks"]:
        location = f"testdata/proofs.json#{risk['id']}"
        if not risk["proofs"]:
            violations.append(PolicyViolation("proof-incomplete", location, "risk has no proof"))
        if not risk["capabilities"]:
            violations.append(
                PolicyViolation("proof-incomplete", location, "risk has no capability")
            )
        for pattern in risk["source_globs"]:
            if not any(path.is_file() for path in repo_root.glob(pattern)):
                violations.append(
                    PolicyViolation(
                        "proof-source-owner", location, f"source glob matches no file: {pattern}"
                    )
                )
        for proof in risk["proofs"]:
            runner, separator, node = proof.partition(":")
            proof_path = node.split("::", 1)[0]
            if (
                not separator
                or runner not in {"gradle", "playwright", "pytest", "static", "vitest"}
                or not _safe_relative(proof_path)
                or not (repo_root / proof_path).is_file()
            ):
                violations.append(
                    PolicyViolation(
                        "proof-node", location, f"invalid or missing proof node: {proof}"
                    )
                )
            previous = proof_owners.setdefault(proof, risk["id"])
            if previous != risk["id"]:
                violations.append(
                    PolicyViolation(
                        "proof-unique-owner", location, f"proof is already owned by {previous}"
                    )
                )
    if not 10 <= len(data["journeys"]) <= 15:
        violations.append(
            PolicyViolation(
                "proof-journey-cap", "testdata/proofs.json", "journeys must number 10 through 15"
            )
        )
    journey_ids = [journey["id"] for journey in data["journeys"]]
    if len(journey_ids) != len(set(journey_ids)):
        violations.append(
            PolicyViolation(
                "proof-unique-owner", "testdata/proofs.json", "journey ids must be unique"
            )
        )
    if not _REQUIRED_JOURNEY_IDS.issubset(journey_ids):
        missing = sorted(_REQUIRED_JOURNEY_IDS.difference(journey_ids))
        violations.append(
            PolicyViolation(
                "proof-required-journeys",
                "testdata/proofs.json",
                f"required product-front-door journeys are missing: {missing}",
            )
        )
    for journey in data["journeys"]:
        location = f"testdata/proofs.json#{journey['id']}"
        for pattern in journey["source_globs"]:
            if not any(path.is_file() for path in repo_root.glob(pattern)):
                violations.append(
                    PolicyViolation(
                        "proof-source-owner", location, f"source glob matches no file: {pattern}"
                    )
                )
        if not (repo_root / journey["proof"]).is_file():
            violations.append(
                PolicyViolation(
                    "proof-node",
                    location,
                    "journey proof is missing",
                )
            )
    return _sorted(violations)


def corpus_manifest_schema_violations(repo_root: Path) -> tuple[PolicyViolation, ...]:
    relative = "testdata/manifest.json"
    data, violations = _load_json(repo_root, relative, "corpus-schema")
    if data is None:
        return _sorted(violations)
    if (
        not isinstance(data, dict)
        or set(data) != {"version", "artifacts"}
        or data["version"] != 1
        or not isinstance(data["artifacts"], list)
    ):
        return (PolicyViolation("corpus-schema", relative, "invalid corpus manifest shape"),)
    for index, artifact in enumerate(data["artifacts"]):
        location = f"{relative}#artifacts[{index}]"
        if not isinstance(artifact, dict) or set(artifact) != {
            "path",
            "sha256",
            "source",
            "license",
            "purpose",
        }:
            violations.append(PolicyViolation("corpus-schema", location, "invalid artifact shape"))
            continue
        if not isinstance(artifact["path"], str) or not _safe_relative(artifact["path"]):
            violations.append(
                PolicyViolation("corpus-path", location, "artifact path must be exact and relative")
            )
        if not isinstance(artifact["sha256"], str) or not _SHA256.fullmatch(artifact["sha256"]):
            violations.append(PolicyViolation("corpus-checksum", location, "invalid sha256"))
        if not all(
            isinstance(artifact[field], str) and artifact[field].strip()
            for field in ("source", "license")
        ) or not _string_list(artifact["purpose"], allow_empty=False):
            violations.append(
                PolicyViolation(
                    "corpus-provenance", location, "provenance and purpose are required"
                )
            )
    return _sorted(violations)


def corpus_violations(repo_root: Path) -> tuple[PolicyViolation, ...]:
    schema = list(corpus_manifest_schema_violations(repo_root))
    if schema:
        return _sorted(schema)
    data = json.loads((repo_root / "testdata/manifest.json").read_text(encoding="utf-8"))
    violations: list[PolicyViolation] = []
    paths: set[str] = set()
    digests: dict[str, str] = {}
    for artifact in data["artifacts"]:
        relative = artifact["path"]
        if relative in paths or relative in _CONTROL_DATA:
            violations.append(
                PolicyViolation("corpus-path", relative, "artifact path is duplicate or reserved")
            )
            continue
        paths.add(relative)
        path = repo_root / relative
        if not path.is_file():
            violations.append(
                PolicyViolation("corpus-path", relative, "manifested artifact is missing")
            )
            continue
        content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest != artifact["sha256"]:
            violations.append(
                PolicyViolation("corpus-checksum", relative, "artifact checksum drifted")
            )
        previous = digests.setdefault(digest, relative)
        if previous != relative:
            violations.append(
                PolicyViolation(
                    "corpus-duplicate-content", relative, f"duplicates content from {previous}"
                )
            )
        if _SECRET.search(content):
            violations.append(
                PolicyViolation("corpus-secret", relative, "artifact contains a secret pattern")
            )

    fixture_files = [path for path in (repo_root / "testdata").rglob("*") if path.is_file()]
    legacy_fixtures = repo_root / "python/tests/fixtures"
    if legacy_fixtures.is_dir():
        binary_suffixes = {".epub", ".pdf", ".tar", ".zip"}
        fixture_files.extend(
            path
            for path in legacy_fixtures.rglob("*")
            if path.is_file()
            and (
                path.suffix.lower() in binary_suffixes
                or path.parent.name == "real_media"
                or (
                    path.parent.parent.name == "reader_apparatus"
                    and path.parent.name in {"gold_graphs", "tei"}
                )
                or (
                    path.parent.parent.name == "reader_apparatus"
                    and path.parent.name == "html"
                    and path.stem.endswith("-full")
                )
            )
        )
    for path in fixture_files:
        relative = path.relative_to(repo_root).as_posix()
        if (
            relative in _CONTROL_DATA
            or relative.startswith("testdata/faults/")
            or path.suffix.lower() == ".md"
        ):
            continue
        if relative not in paths:
            violations.append(
                PolicyViolation("corpus-unmanifested", relative, "fixture is absent from manifest")
            )
    return _sorted(violations)


def exception_violations(repo_root: Path, today: date) -> tuple[PolicyViolation, ...]:
    relative = "testdata/policy-exceptions.json"
    data, violations = _load_json(repo_root, relative, "exception-schema")
    if data is None:
        return _sorted(violations)
    if (
        not isinstance(data, dict)
        or set(data) != {"version", "exceptions"}
        or data["version"] != 1
        or not isinstance(data["exceptions"], list)
    ):
        return (PolicyViolation("exception-schema", relative, "invalid exception manifest shape"),)
    seen: set[tuple[str, str, str]] = set()
    for index, exception in enumerate(data["exceptions"]):
        location = f"{relative}#exceptions[{index}]"
        if (
            not isinstance(exception, dict)
            or set(exception)
            != {
                "rule",
                "path",
                "node",
                "reason",
                "expires_on",
                "replacement",
            }
            or not all(
                isinstance(exception.get(field), str) and exception[field].strip()
                for field in ("rule", "path", "node", "reason", "expires_on", "replacement")
            )
        ):
            violations.append(
                PolicyViolation("exception-schema", location, "invalid exception shape")
            )
            continue
        if (
            not _safe_relative(exception["path"])
            or not (repo_root / exception["path"]).is_file()
            or any(character in exception["node"] for character in "*?[]")
        ):
            violations.append(
                PolicyViolation(
                    "exception-exact-target",
                    location,
                    "exception target must be exact and existing",
                )
            )
        try:
            expiry = date.fromisoformat(exception["expires_on"])
        except ValueError:
            violations.append(
                PolicyViolation("exception-schema", location, "expires_on must be YYYY-MM-DD")
            )
        else:
            if expiry < today:
                violations.append(
                    PolicyViolation("exception-expired", location, "exception has expired")
                )
        key = (exception["rule"], exception["path"], exception["node"])
        if key in seen:
            violations.append(
                PolicyViolation("exception-duplicate", location, "duplicate exception")
            )
        seen.add(key)
    return _sorted(violations)


def fault_manifest_violations(repo_root: Path) -> tuple[PolicyViolation, ...]:
    relative = "testdata/faults/manifest.json"
    data, violations = _load_json(repo_root, relative, "fault-schema")
    if data is None:
        return _sorted(violations)
    if (
        not isinstance(data, dict)
        or set(data) != {"version", "faults"}
        or data["version"] != 1
        or not isinstance(data["faults"], list)
    ):
        return (PolicyViolation("fault-schema", relative, "invalid fault manifest shape"),)
    seen_ids: set[str] = set()
    manifested: set[str] = set()
    for index, fault in enumerate(data["faults"]):
        location = f"{relative}#faults[{index}]"
        if not isinstance(fault, dict) or set(fault) != {
            "id",
            "patch",
            "sha256",
            "proofs",
            "expected_failure",
        }:
            violations.append(PolicyViolation("fault-schema", location, "invalid fault shape"))
            continue
        if (
            not isinstance(fault["id"], str)
            or not _SLUG.fullmatch(fault["id"])
            or fault["id"] in seen_ids
            or not _string_list(fault["proofs"], allow_empty=False)
            or not isinstance(fault["expected_failure"], str)
            or not fault["expected_failure"].strip()
        ):
            violations.append(
                PolicyViolation("fault-schema", location, "invalid or duplicate fault identity")
            )
        seen_ids.add(fault.get("id", ""))
        patch = fault.get("patch")
        if (
            not isinstance(patch, str)
            or not _safe_relative(patch)
            or not patch.startswith("testdata/faults/")
            or not patch.endswith(".patch")
        ):
            violations.append(
                PolicyViolation("fault-path", location, "fault patch path is invalid")
            )
            continue
        manifested.add(patch)
        path = repo_root / patch
        if not path.is_file():
            violations.append(PolicyViolation("fault-path", location, "fault patch is missing"))
            continue
        sha256 = fault.get("sha256")
        if (
            not isinstance(sha256, str)
            or not _SHA256.fullmatch(sha256)
            or hashlib.sha256(path.read_bytes()).hexdigest() != sha256
        ):
            violations.append(
                PolicyViolation("fault-checksum", location, "fault patch checksum drifted")
            )
        else:
            try:
                changed_paths = _fault_changed_paths(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, ValueError) as error:
                violations.append(PolicyViolation("fault-patch", location, str(error)))
            else:
                for changed_path in changed_paths:
                    if not _is_product_path(changed_path):
                        violations.append(
                            PolicyViolation(
                                "fault-product-only",
                                location,
                                f"fault patch may change product code only: {changed_path}",
                            )
                        )
    faults_root = repo_root / "testdata/faults"
    if faults_root.is_dir():
        for path in faults_root.glob("*.patch"):
            relative_patch = path.relative_to(repo_root).as_posix()
            if relative_patch not in manifested:
                violations.append(
                    PolicyViolation(
                        "fault-unmanifested", relative_patch, "fault patch is absent from manifest"
                    )
                )
    return _sorted(violations)


def _fault_changed_paths(patch: str) -> tuple[str, ...]:
    paths: list[str] = []
    for line in patch.splitlines():
        if not line.startswith("diff --git a/"):
            continue
        fields = line.split()
        if len(fields) != 4 or not fields[2].startswith("a/") or not fields[3].startswith("b/"):
            raise ValueError("fault patch has malformed git path header")
        paths.append(fields[3].removeprefix("b/"))
    if not paths:
        raise ValueError("fault patch has no git path header")
    return tuple(paths)


def _is_product_path(path: str) -> bool:
    product = path.startswith(
        ("python/nexus/", "apps/web/src/", "apps/android/app/src/", "migrations/alembic/")
    )
    test_runtime_product = path in {
        "python/nexus_test_control/build.py",
        "python/nexus_test_control/runtime.py",
        "python/nexus_test_control/services.py",
    }
    return (product or test_runtime_product) and not any(
        part in Path(path).name for part in (".test.", ".spec.")
    )
