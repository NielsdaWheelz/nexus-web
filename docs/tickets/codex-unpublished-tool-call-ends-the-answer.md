# codex: a call to an unpublished tool ends the answer as policy_violation

status: open; blocked outside nexus (provider-runtime + llm-agent-kernel) · origin: 2026-10-10 model tools rewrite (coordinator R5, harness T4e) · area: chat tool runtime / codex

spec invariant 3 says a call naming a tool outside the frozen plan never runs,
leaves no record, answers `ToolUnavailable` and lets the answer continue. on the
provider route `services/tools/run.py` `run_tool` does exactly that. on codex it
cannot: the codex binary itself answers the model `unsupported call: <name>`
(`strings codex_cli_bin/bin/codex`), then

- provider-runtime (`agent_runtime/codex_sdk.py` ~1238-1254, pin `d9550d9c`) maps the
  raw `function_call` to an undeclared name to `AgentToolUse` and sets
  `authority_seen`; under strict containment (`builtin_tools == "disabled"`,
  `_strict_native_containment`) `_turn_terminal` raises `ProtocolDefect("turn
  completed after forbidden Codex native authority activity")`;
- llm-agent-kernel `native.py:477-480` raises `ProviderContainmentViolation` on any
  `AgentToolUse`, which nexus maps to `policy_violation`.

harness T4e (member -> `memory__search`, owner -> `nexus__delete__everything`):
both runs end `error|policy_violation`; a background metadata research naming an
ungranted write fails its job the same way. a kernel-only fix (tolerate the raw
`function_call` proposal) was tried and reverted: provider-runtime's terminal
check then ends the run `defect` instead, which is worse.

prerequisite: an owner decision that a model's call to an unpublished function,
which codex refuses itself and runs nothing for, is a model error and not
authority activity; then one change in provider-runtime (do not mark a raw
`function_call` proposal as authority activity, or mark it as a refused proposal)
and one in the kernel (do not raise on it), released together, then the nexus pin.

acceptance: harness T4e passes (codex's own refusal reaches the model, no
`tool_calls` row, both answers complete; the member's call never reaches the
memory server); native shell/file/MCP activity still ends the turn.
