"""Hard-cut residue proof for metadata-owned Codex generation dispatch."""

import ast
from pathlib import Path


def test_all_metadata_enqueues_use_the_canonical_dispatch_owner() -> None:
    """Risk: a producer bypasses the strict capacity-wait payload and retry budget."""
    nexus_root = Path(__file__).parents[2] / "nexus"
    direct_enqueuers: list[str] = []
    for path in nexus_root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        if any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"enqueue_job", "enqueue_unique_job"}
            and any(
                keyword.arg == "kind"
                and isinstance(keyword.value, ast.Constant)
                and keyword.value.value == "enrich_metadata"
                for keyword in node.keywords
            )
            for node in ast.walk(tree)
        ):
            direct_enqueuers.append(path.relative_to(nexus_root).as_posix())

    assert direct_enqueuers == ["services/metadata_dispatch.py"]
