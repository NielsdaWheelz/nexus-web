# prepared chat cancellation requires an unbound mcp authority

status: local fix; native no-effect proof pending · origin: 2026-09-25 chat reliability planning · area: generation cancellation

`chat_run_worker.py:311-314` finalizes an undispatched cancellation directly
only when no generation step exists. a prepared codex/tool step continues to
the generation owner. `llm_execution.py:604-605` invokes `before_terminal`
before checking that no child was dispatched. the callback is
`CodexGenerationToolBinding.wait_until_idle`, which raises when no authority
was bound (`agent_tools_mcp.py:487-493`).

a legitimate cancellation before dispatch can therefore defect because it
requires a resource that should never have been created. source evidence only;
no production cancellation was attempted.

settle a proven undispatched prepared generation through its existing
generation-owner helper before creating transport or a tool binding. retain
the strict bound-authority check for dispatched work; do not make it silently
accept missing authority. preserve run/job lock ordering and exact journal
identity.

acceptance: both missing-step and prepared-step cancellation produce a truthful
cancelled run with zero host admission, native session or tool effects; a
dispatched uncertain step still requires reconciliation rather than this path.
