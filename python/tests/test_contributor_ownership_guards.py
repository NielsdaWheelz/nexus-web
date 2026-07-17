"""Source-scanning guards for the author-aggregate ownership boundaries (spec §3, D-39).

The aggregate is: the ``contributors`` facade, the visibly private
``_contributor_identity`` / ``_contributor_credit_writes`` modules, and the pure
``contributor_taxonomy`` leaf. Replay memos are shared cross-domain mechanics
(``services/resource_mutation_replay``), not part of this aggregate. These
gates assert the structural invariants of the lightweight-author-deduplication
cutover so a future edit that reintroduces a savepoint, an explicit lock, a
random handle, a second credit-write path, or a session-taking mutation facade
fails CI.
"""

import ast
import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

NEXUS = Path(__file__).resolve().parents[1] / "nexus"

FACADE = NEXUS / "services" / "contributors.py"
AUTHOR_AGGREGATE = (
    "services/contributors.py",
    "services/_contributor_identity.py",
    "services/_contributor_credit_writes.py",
    "services/contributor_taxonomy.py",
)

# The four public mutation entry points own their fresh sessions (spec 2.7, D-22).
MUTATION_FACADES = (
    "replace_observed_role_slices",
    "replace_observed_role_slices_batch",
    "put_media_authors",
    "ensure_contributor_display_name",
)

# Raw contributor_credits SQL is allowed only in the canonical read owner and the
# visibility owner (spec §3; migrations live outside nexus/ and are exempt). The
# S9 sweep emptied the former pending-rewrite allowlist: every read consumer
# (search retrievers/service, resource-graph resolvers, podcast subscriptions)
# now composes the owner's SQL builders, so reintroducing ``FROM
# contributor_credits`` into any other file fails CI.
RAW_CREDIT_SQL_OWNERS = {
    "services/contributor_credits.py",
    "auth/permissions.py",
}

_RAW_CREDIT_SQL_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+contributor_credits\b"
)


def _read(relative: str) -> str:
    return (NEXUS / relative).read_text()


def _nexus_sources() -> dict[str, str]:
    return {path.relative_to(NEXUS).as_posix(): path.read_text() for path in NEXUS.rglob("*.py")}


def test_taxonomy_stays_a_pure_leaf() -> None:
    # Spec §3: no database or sibling-service imports in the vocabulary owner.
    src = _read("services/contributor_taxonomy.py")
    assert "from nexus." not in src and "import nexus" not in src, (
        "contributor_taxonomy must stay a pure stdlib leaf"
    )


def test_facade_composes_private_modules_and_public_read_relation() -> None:
    # D-39 inversion: the facade imports the private author modules and the
    # canonical credit read relation (the old gate forbade the latter).
    src = _read("services/contributors.py")
    for module in (
        "nexus.services._contributor_identity",
        "nexus.services._contributor_credit_writes",
        "nexus.services.resource_mutation_replay",
        "nexus.services.contributor_credits",
    ):
        assert f"from {module} import" in src, f"facade must compose {module}"


_PRIVATE_AUTHOR_IMPORT_RE = re.compile(
    r"^\s*(?:from|import)\s+nexus\.services\._contributor_\w+", re.MULTILINE
)


def test_private_author_modules_are_imported_only_by_the_facade() -> None:
    # Spec §3: imports of private author helpers outside the aggregate are
    # forbidden (tests import them directly; this scans nexus/ only).
    offenders = []
    for relative, src in _nexus_sources().items():
        if relative == "services/contributors.py" or relative.startswith("services/_contributor_"):
            continue
        if _PRIVATE_AUTHOR_IMPORT_RE.search(src):
            offenders.append(relative)
    assert offenders == [], f"private author modules imported outside the facade: {offenders}"


def test_replay_helpers_feed_only_user_mutations() -> None:
    # D-43 static half: resource_mutation_replay's lookup/record calls appear
    # only in the two replayable user mutations; automatic lanes never touch
    # resource_mutations.
    tree = ast.parse(_read("services/contributors.py"))
    replay_callers = {
        fn.name
        for fn in ast.walk(tree)
        if isinstance(fn, ast.FunctionDef)
        and any(
            isinstance(node, ast.Name) and node.id in ("lookup_replay", "record_replay")
            for node in ast.walk(fn)
        )
    }
    assert replay_callers == {"_put_media_authors_op", "_ensure_display_name_op"}, (
        f"replay memos may feed only the two user mutations, got {sorted(replay_callers)}"
    )


# The facade's only sanctioned public re-exports: the credit-target union that
# callers need to address the three target kinds (plan S3 "nothing else public").
_SANCTIONED_FACADE_REEXPORTS = frozenset(
    {"CreditTarget", "MediaTarget", "PodcastTarget", "GutenbergTarget"}
)


def test_facade_keeps_private_author_helpers_private() -> None:
    # A plain (un-underscored) import at the facade top would re-export the
    # private write/identity/replay helpers as public module attributes — a
    # second write path that bypasses the fresh-session + retry_serializable
    # discipline. Every import from a _contributor_* module must be bound to an
    # underscored name or be a sanctioned target re-export.
    tree = ast.parse(_read("services/contributors.py"))
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if not (node.module or "").startswith("nexus.services._contributor_"):
            continue
        for alias in node.names:
            bound = alias.asname or alias.name
            if bound.startswith("_") or bound in _SANCTIONED_FACADE_REEXPORTS:
                continue
            offenders.append(f"{node.module}.{alias.name} as {bound}")
    assert offenders == [], f"facade re-exports private author helpers publicly: {offenders}"


def test_no_savepoints_in_author_aggregate() -> None:
    # Spec 2.7: no savepoints/nested transactions anywhere in the aggregate.
    for relative in AUTHOR_AGGREGATE:
        assert "begin_nested" not in _read(relative), f"savepoint in {relative}"


def test_no_explicit_locks_in_author_aggregate() -> None:
    # Spec 2.7/§3: SERIALIZABLE + bounded retry only; no explicit/advisory locks.
    for relative in AUTHOR_AGGREGATE:
        src = _read(relative)
        for marker in ("with_for_update", "pg_advisory"):
            assert marker not in src, f"explicit lock marker {marker!r} in {relative}"
        assert re.search(r"FOR\s+UPDATE\b", src, re.IGNORECASE) is None, f"FOR UPDATE in {relative}"


def test_no_uuid4_in_author_aggregate() -> None:
    # Spec 2.3/AC 35: handle generation is deterministic; a true collision
    # advances the digest ladder or is a defect, never a random fallback.
    # AST-based so prose ("never uuid4()") in docstrings does not trip the gate.
    for relative in AUTHOR_AGGREGATE:
        tree = ast.parse(_read(relative))
        references = [
            node
            for node in ast.walk(tree)
            if (isinstance(node, ast.Name) and node.id == "uuid4")
            or (isinstance(node, ast.Attribute) and node.attr == "uuid4")
            or (
                isinstance(node, ast.ImportFrom)
                and any(alias.name == "uuid4" for alias in node.names)
            )
        ]
        assert references == [], f"uuid4 referenced in {relative}"


def test_raw_credit_sql_only_in_canonical_owners() -> None:
    # Spec §3: raw contributor_credits reads live in the canonical query owner
    # (and the visibility owner backing it); writes are ORM-only in the private
    # credit-writes module. The S9 pending-rewrite allowlist is now empty.
    offenders = sorted(
        relative
        for relative, src in _nexus_sources().items()
        if _RAW_CREDIT_SQL_RE.search(src) and relative not in RAW_CREDIT_SQL_OWNERS
    )
    assert offenders == [], f"raw contributor_credits SQL outside its owners: {offenders}"


def test_credit_row_construction_only_in_credit_writes() -> None:
    # ContributorCredit rows are inserted only by the private credit writer.
    offenders = [
        relative
        for relative, src in _nexus_sources().items()
        if relative.startswith("services/")
        and relative != "services/_contributor_credit_writes.py"
        and "ContributorCredit(" in src
    ]
    assert offenders == [], f"ContributorCredit constructed outside the writer: {offenders}"


def test_identity_rows_constructed_only_in_identity_writer() -> None:
    # Spec §3 bans direct contributor/alias/key DML from adapters/routes, symmetric
    # with the credit ban above. Contributor/ContributorAlias/ContributorExternalId
    # ORM rows are inserted only by the private identity writer; adapters emit typed
    # observations, never ORM rows. (models.py defines the classes and lives outside
    # services/; the facade deletes but never constructs identity rows.)
    identity_ctor_re = re.compile(r"\b(?:Contributor|ContributorAlias|ContributorExternalId)\(")
    offenders = [
        relative
        for relative, src in _nexus_sources().items()
        if relative.startswith("services/")
        and relative != "services/_contributor_identity.py"
        and identity_ctor_re.search(src)
    ]
    assert offenders == [], f"identity row constructed outside the identity writer: {offenders}"


def test_mutation_facades_accept_no_session() -> None:
    # Spec 2.7/D-22: the no-db signature makes the fresh-session rule
    # structurally unmisusable.
    tree = ast.parse(_read("services/contributors.py"))
    seen: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in MUTATION_FACADES:
            seen.add(node.name)
            args = node.args
            names = [arg.arg for arg in args.posonlyargs + args.args + args.kwonlyargs]
            annotations = ast.dump(args)
            assert "db" not in names, f"{node.name} must not accept a session"
            assert "Session" not in annotations, f"{node.name} must not accept a session"
    assert seen == set(MUTATION_FACADES), f"missing mutation facades: {seen}"


def test_facade_reads_no_chat_tables_directly() -> None:
    # Persisted chat context is read only via chat_context_refs (the sole owner).
    src = _read("services/contributors.py")
    for table in (
        "message_retrievals",
        "message_tool_calls",
        "chat_prompt_assemblies",
        "chat_run_events",
    ):
        assert table not in src, f"facade reads chat table {table} directly"


def test_facade_issues_no_resource_edges_dml() -> None:
    # The facade reads resource_edges for orphan gating but never mutates it;
    # graph DML belongs to services/resource_graph.
    src = _read("services/contributors.py")
    for marker in (
        "db.add(ResourceEdge",
        "db.delete(ResourceEdge",
        "INSERT INTO resource_edges",
        "UPDATE resource_edges",
        "DELETE FROM resource_edges",
    ):
        assert marker not in src, f"resource_edges DML in the facade: {marker}"


def test_podcast_visibility_cte_lives_only_in_permissions() -> None:
    # The subscriptions-∪-library_entries visibility CTE has exactly one home.
    offenders = [
        relative
        for relative, src in _nexus_sources().items()
        if relative != "auth/permissions.py"
        and "FROM podcast_subscriptions" in src
        and "UNION" in src
        and "le.podcast_id" in src
    ]
    assert offenders == [], f"inline podcast-visibility CTE outside permissions.py: {offenders}"


# =============================================================================
# S9 final ownership pass (spec §2.7/§3, D-22/D-43): call-site + write-SQL sweeps
# =============================================================================

_SESSION_ARG_NAMES = {"db", "session", "db_session"}

_CREDIT_WRITE_SQL_RE = re.compile(
    r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+contributor_credits\b", re.IGNORECASE
)


def test_no_call_site_passes_a_session_to_a_mutation_facade() -> None:
    # Spec 2.7/D-22: the mutation facades own their fresh sessions; no caller may
    # thread a db/session into them (the no-db signature is checked above; this is
    # the call-site half). AST over nexus/: a session arg is any positional Name or
    # keyword named db/session/db_session.
    offenders: list[str] = []
    for relative, src in _nexus_sources().items():
        for node in ast.walk(ast.parse(src)):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
            if name not in MUTATION_FACADES:
                continue
            passes_session = any(
                isinstance(arg, ast.Name) and arg.id in _SESSION_ARG_NAMES for arg in node.args
            ) or any(kw.arg in _SESSION_ARG_NAMES for kw in node.keywords)
            if passes_session:
                offenders.append(f"{relative}:{node.lineno} {name}")
    assert offenders == [], f"mutation facade called with a session: {offenders}"


def test_credit_write_sql_only_in_credit_writes() -> None:
    # Spec §3: contributor_credits INSERT/UPDATE/DELETE live only in the private
    # ORM writer. (Raw credit READS have their own owner set above; migrations,
    # outside nexus/, keep their own frozen DML.) Complements
    # test_credit_row_construction_only_in_credit_writes (ORM construction).
    offenders = sorted(
        relative
        for relative, src in _nexus_sources().items()
        if _CREDIT_WRITE_SQL_RE.search(src) and relative != "services/_contributor_credit_writes.py"
    )
    assert offenders == [], f"contributor_credits write SQL outside the writer: {offenders}"
