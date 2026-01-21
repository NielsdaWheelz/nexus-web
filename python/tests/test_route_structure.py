"""Structural tests for route code.

Verifies that routes follow the service/route separation rule:
- Routes may not contain domain logic or raw DB access
- Routes may only import from allowed modules

Per PR-03 spec section 4.2.
"""

import ast
from pathlib import Path

import pytest


def get_routes_dir() -> Path:
    """Get the path to the routes directory."""
    # Navigate from tests/ to nexus/api/routes/
    tests_dir = Path(__file__).parent
    return tests_dir.parent / "nexus" / "api" / "routes"


def get_all_route_files() -> list[Path]:
    """Get all Python files in the routes directory."""
    routes_dir = get_routes_dir()
    if not routes_dir.exists():
        return []
    return [f for f in routes_dir.iterdir() if f.suffix == ".py" and f.name != "__init__.py"]


class TestForbiddenImports:
    """Tests that route files don't import forbidden modules."""

    # Forbidden import patterns (from PR-03 spec section 4.2)
    FORBIDDEN_IMPORT_MODULES = [
        # Direct SQLAlchemy imports (except Session from sqlalchemy.orm)
        "sqlalchemy.sql",
        "sqlalchemy.engine",
        "sqlalchemy.text",
        "sqlalchemy.select",
        "sqlalchemy.insert",
        "sqlalchemy.update",
        "sqlalchemy.delete",
        # App DB imports (except get_db from session)
        "nexus.db.engine",
    ]

    # Forbidden function calls in route code
    FORBIDDEN_CALLS = [
        "db.execute",
        "db.scalar",
        "db.query",
        "session.execute",
        "session.scalar",
        "session.query",
    ]

    # Allowed imports for routes (exhaustive list from spec)
    ALLOWED_MODULES = [
        "fastapi",
        "typing",
        "uuid",
        "sqlalchemy.orm",  # Only for Session type annotation
        "nexus.api.deps",
        "nexus.auth.middleware",
        "nexus.responses",
        "nexus.errors",
        "nexus.schemas",
        "nexus.services",
    ]

    @pytest.fixture
    def route_files(self) -> list[Path]:
        """Get all route files to test."""
        files = get_all_route_files()
        # Ensure we have some files to test
        assert len(files) > 0, "No route files found to test"
        return files

    def test_no_direct_sqlalchemy_imports(self, route_files: list[Path]):
        """Route files must not import SQLAlchemy modules directly (except Session)."""
        for route_file in route_files:
            source = route_file.read_text()
            tree = ast.parse(source)

            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        # Check for forbidden top-level imports
                        if alias.name.startswith("sqlalchemy") and alias.name != "sqlalchemy.orm":
                            pytest.fail(
                                f"{route_file.name}: Forbidden import '{alias.name}'. "
                                "Only 'from sqlalchemy.orm import Session' is allowed."
                            )

                elif isinstance(node, ast.ImportFrom):
                    if node.module:
                        # Allow only Session from sqlalchemy.orm
                        if node.module == "sqlalchemy.orm":
                            for alias in node.names:
                                if alias.name != "Session":
                                    pytest.fail(
                                        f"{route_file.name}: Forbidden import "
                                        f"'from sqlalchemy.orm import {alias.name}'. "
                                        "Only 'from sqlalchemy.orm import Session' is allowed."
                                    )
                        # Forbid all other sqlalchemy imports
                        elif node.module.startswith("sqlalchemy"):
                            pytest.fail(
                                f"{route_file.name}: Forbidden import from '{node.module}'. "
                                "Route files must not import SQLAlchemy modules directly."
                            )

    def test_no_direct_db_imports_except_get_db(self, route_files: list[Path]):
        """Route files must only import get_db from nexus.db."""
        for route_file in route_files:
            source = route_file.read_text()
            tree = ast.parse(source)

            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    # Check nexus.db imports
                    if node.module.startswith("nexus.db"):
                        # Allow nexus.api.deps which re-exports get_db
                        if node.module == "nexus.api.deps":
                            continue

                        # For direct nexus.db.session imports, only allow get_db
                        if node.module == "nexus.db.session":
                            for alias in node.names:
                                if alias.name not in ("get_db",):
                                    pytest.fail(
                                        f"{route_file.name}: Forbidden import "
                                        f"'from {node.module} import {alias.name}'. "
                                        "Only 'get_db' is allowed from nexus.db."
                                    )
                        else:
                            # Any other nexus.db submodule is forbidden
                            pytest.fail(
                                f"{route_file.name}: Forbidden import from '{node.module}'. "
                                "Route files must not import from nexus.db except get_db."
                            )

    def test_no_raw_db_operations_in_routes(self, route_files: list[Path]):
        """Route files must not call db.execute, db.scalar, etc."""
        for route_file in route_files:
            source = route_file.read_text()

            # Simple string check for forbidden patterns
            for pattern in self.FORBIDDEN_CALLS:
                if pattern in source:
                    # Could be a false positive, do AST check
                    tree = ast.parse(source)
                    for node in ast.walk(tree):
                        if isinstance(node, ast.Call):
                            # Check for attribute calls like db.execute
                            if isinstance(node.func, ast.Attribute):
                                attr_name = node.func.attr
                                if attr_name in ("execute", "scalar", "query"):
                                    # Get the object name if available
                                    if isinstance(node.func.value, ast.Name):
                                        obj_name = node.func.value.id
                                        if obj_name in ("db", "session"):
                                            pytest.fail(
                                                f"{route_file.name}: Forbidden call "
                                                f"'{obj_name}.{attr_name}()'. "
                                                "Route files must not perform raw DB operations."
                                            )

    def test_routes_use_service_functions(self, route_files: list[Path]):
        """Route files should import from services modules."""
        # This is a soft check - we just verify the pattern exists
        # At least the libraries.py file should import services
        libraries_route = get_routes_dir() / "libraries.py"
        if libraries_route.exists():
            source = libraries_route.read_text()
            assert "nexus.services" in source, "libraries.py should import from nexus.services"


class TestRouteFileStructure:
    """Tests for overall route file structure."""

    def test_all_routes_have_router(self):
        """All route files must define a 'router' object."""
        route_files = get_all_route_files()

        for route_file in route_files:
            source = route_file.read_text()
            tree = ast.parse(source)

            # Look for "router = APIRouter()" assignment
            has_router = False
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign):
                    for target in node.targets:
                        if isinstance(target, ast.Name) and target.id == "router":
                            has_router = True
                            break

            assert has_router, f"{route_file.name} must define a 'router' object"

    def test_route_handlers_return_dict_or_response(self):
        """Route handlers should return dict (for success_response) or Response."""
        route_files = get_all_route_files()

        for route_file in route_files:
            source = route_file.read_text()
            tree = ast.parse(source)

            for node in ast.walk(tree):
                # Find function definitions decorated with @router.xxx
                if isinstance(node, ast.FunctionDef):
                    is_route_handler = False
                    for decorator in node.decorator_list:
                        if isinstance(decorator, ast.Call):
                            if isinstance(decorator.func, ast.Attribute):
                                if isinstance(decorator.func.value, ast.Name):
                                    if decorator.func.value.id == "router":
                                        is_route_handler = True
                                        break

                    if is_route_handler:
                        # Route handlers should have a return type annotation
                        if node.returns:
                            # Accept dict, Response, or Any
                            if isinstance(node.returns, ast.Name):
                                assert node.returns.id in ("dict", "Response"), (
                                    f"{route_file.name}:{node.name} should return dict or Response"
                                )
