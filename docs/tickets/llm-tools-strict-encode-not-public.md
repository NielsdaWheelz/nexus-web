# codex tool dispatch re-encodes input through a private llm-tools function

status: open · origin: 2026-10-10 generation rewrite (design R1, coordinator R4) · area: generation / codex tools

under the kernel's transient native mode the dispatch lineage carries no raw
arguments, while `llm_tools.ToolExecutor` executes raw JSON. the codex adapter
(`python/nexus/services/generation/codex.py`, `_Ports.dispatch`) therefore
re-encodes the kernel's validated input with `llm_tools.schema.strict_encode`,
which `llm_tools/__init__.py` does not export. it is pinned with the llm-tools
rev (`73056dfb`), so an internal rename breaks the codex tool path at the next
pin bump rather than at import.

prerequisite: an owner decision in llm-tools or llm-agent-kernel.

proposed fix: export `strict_encode` from llm-tools, or add the raw validated
arguments to `NativeDispatchLineage` in the kernel, then import the public name.

acceptance: nexus imports no private llm-tools module for codex dispatch.
