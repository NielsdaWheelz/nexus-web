from __future__ import annotations

import ast
import hashlib

_PYTHON_EXACT_OWNER_DIGEST_DOMAIN = b"nexus-python-exact-proof-source-v1\0"


def _statement_source(source_lines: list[str], statement: ast.stmt) -> str | None:
    end_line = statement.end_lineno
    if end_line is None:
        return None
    decorators = getattr(statement, "decorator_list", ())
    start_line = min((statement.lineno, *(decorator.lineno for decorator in decorators)))
    return "".join(source_lines[start_line - 1 : end_line])


def python_exact_proof_owner(source: str, node: str) -> tuple[str, ...] | None:
    """Return one module test plus all shared and import-time support."""
    module = ast.parse(source)
    owner = tuple(node.split("::"))
    if len(owner) != 1 or not owner[0]:
        return None

    source_lines = source.splitlines(keepends=True)
    retained: list[str] = []
    selected = 0
    for statement in module.body:
        statement_source = _statement_source(source_lines, statement)
        if statement_source is None:
            return None
        if isinstance(
            statement, (ast.FunctionDef, ast.AsyncFunctionDef)
        ) and statement.name.startswith("test_"):
            if owner == (statement.name,):
                retained.append(statement_source)
                selected += 1
            continue
        if isinstance(statement, ast.ClassDef) and statement.name.startswith("Test"):
            continue
        retained.append(statement_source)
    return tuple(retained) if selected == 1 else None


def python_exact_proof_owner_sha256(source: str, node: str) -> str | None:
    """Hash stable source slices, using AST only to select ownership spans."""
    owner = python_exact_proof_owner(source, node)
    if owner is None:
        return None
    digest = hashlib.sha256(_PYTHON_EXACT_OWNER_DIGEST_DOMAIN)
    for statement in owner:
        encoded = statement.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, byteorder="big"))
        digest.update(encoded)
    return digest.hexdigest()
