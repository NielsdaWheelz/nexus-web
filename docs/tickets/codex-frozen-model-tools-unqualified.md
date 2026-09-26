# codex frozen model tools are unqualified

status: open  
origin: 2026-09-25 chat reliability implementation  
area: codex provider boundary

the provider runtime chat pin (`7008b669`, based directly on `97fbac7`, `src/provider_runtime/agent_runtime/codex_sdk.py:2088-2102`) rejects codex disabled built-ins unless the filesystem is read-only, network is disabled, and mcp servers are absent. this cannot provide the networked mcp authority required by frozen model-tool plans. codex `0.144.4` has no independently proven boundary that both enforces the exact frozen plan and permits its required transport. `apps/codex_agent/host.py:453-457` now rejects tool-bearing admissions before slot reservation; `python/nexus/services/codex_generation_operations.py:55` lowers only no-tool sessions. the host catalog declares `supports_frozen_mcp_tools=false` (`python/nexus/services/codex_generation_contract.py:116`). tool-bearing codex chat cannot be advertised as available. fixed background policies that require codex tools remain unsupported and block the combined release (`docs/chat-reliability-plan.md:104-105`).

first qualify an exact provider-runtime and native codex revision with positive and negative effect proofs: declared tools execute only under the frozen grant, undeclared tools and unauthorized egress cause no side effect, no-tool turns remain offline, and strict-output-plus-tools works as one combination. separately qualify each fixed background policy that requires tools. then expose the qualified combination in the host catalog and admission contract, update the egress policy and runbook together, and prove the production chat route end to end. a source-level feature flag or isolated provider option is insufficient evidence.

resolved when the exact pinned native revision rejects undeclared tools and unauthorized egress before side effects, admits declared tools under the frozen grant, preserves no-tool isolation, passes live tool-bearing chat acceptance without retry ambiguity, and all fixed background policies required by the release have their own passing effect proof.
