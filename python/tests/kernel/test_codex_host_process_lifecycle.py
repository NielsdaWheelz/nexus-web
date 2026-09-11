"""Static ownership proof for Codex host process-memory boundaries."""

from __future__ import annotations

import ast
from pathlib import Path


def _module_imports(tree: ast.Module) -> set[str]:
    imports = {
        node.module.split(".")[0] if node.module is not None else ""
        for node in tree.body
        if isinstance(node, ast.ImportFrom)
    }
    imports.update(
        alias.name.split(".")[0]
        for node in tree.body
        if isinstance(node, ast.Import)
        for alias in node.names
    )
    return imports


def test_codex_host_separates_bootstrap_server_and_health_memory_lifetimes() -> None:
    """Risk: bootstrap or health allocations survive into the bounded host."""

    repository = Path(__file__).parents[3]
    main_tree = ast.parse((repository / "apps/codex_agent/main.py").read_text(encoding="utf-8"))
    health_tree = ast.parse((repository / "apps/codex_agent/health.py").read_text(encoding="utf-8"))

    main_imports = _module_imports(main_tree)
    if not main_imports.isdisjoint({"uvicorn", "nexus"}) or any(
        isinstance(node, ast.ImportFrom) and node.module == "apps.codex_agent.host"
        for node in main_tree.body
    ):
        raise AssertionError("Codex bootstrap retained the long-lived server graph")

    exec_function = next(
        node
        for node in main_tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_exec_server_after_auth"
    )
    calls = [node for node in ast.walk(exec_function) if isinstance(node, ast.Call)]
    assert len(calls) == 1
    call = calls[0]
    assert ast.unparse(call.func) == "os.execv"
    assert [ast.unparse(argument) for argument in call.args] == [
        "sys.executable",
        "(sys.executable, '-m', 'apps.codex_agent.main', _SERVE_AFTER_AUTH_ARGUMENT)",
    ]

    bootstrap_function = next(
        node
        for node in main_tree.body
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_authenticated_bootstrap"
    )
    if any(isinstance(node, (ast.Import, ast.ImportFrom)) for node in ast.walk(bootstrap_function)):
        raise AssertionError("Codex bootstrap imported a deferred server dependency")
    if any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_serve_after_authenticated_bootstrap"
        for node in ast.walk(bootstrap_function)
    ):
        raise AssertionError("Codex bootstrap entered the long-lived server phase")

    main_function = next(
        node for node in main_tree.body if isinstance(node, ast.FunctionDef) and node.name == "main"
    )
    unauthenticated_branch = next(node for node in main_function.body if isinstance(node, ast.If))
    unauthenticated_calls = [
        ast.unparse(statement.value)
        for statement in unauthenticated_branch.body
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)
    ]
    if unauthenticated_calls != [
        "asyncio.run(_authenticated_bootstrap())",
        "_exec_server_after_auth()",
    ]:
        raise AssertionError("Codex bootstrap did not cross the exec memory boundary")

    health_contract = repository / "apps/codex_agent/health_contract.py"
    if not health_contract.is_file():
        raise AssertionError("Codex health has no dependency-light shared contract")
    health_contract_tree = ast.parse(health_contract.read_text(encoding="utf-8"))
    health_imports = _module_imports(health_tree) | _module_imports(health_contract_tree)
    if not health_imports.isdisjoint({"asyncio", "httpx", "nexus", "provider_runtime", "pydantic"}):
        raise AssertionError("Codex health retained the application dependency graph")
