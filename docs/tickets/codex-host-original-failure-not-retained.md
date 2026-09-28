# codex host does not retain its first failure class

status: open; final native journey unverified
origin: 2026-09-27 current-main reliability audit, `fbd08ba68`
area: codex host diagnostics

`apps/codex_agent/host.py:1070-1095` reduces runtime errors and unexpected
exceptions to terminal kind, stage and safe cause without logging the original
exception class at detection. `python/nexus/services/codex_generation_contract.py:471-495`
rejects `invalid_request` and `runtime_defect` before durable terminal
acceptance. if normalization then fails, the initiating class is unavailable
for repair. the old production `invalid_request` cause was not established.

log bounded original class, safe cause/code, stage, generation/child identity
and pinned native revision at the detecting boundary before normalization.
prove that a later caller-side contract defect retains the correlated first
cause, without prompts, bearer values or arbitrary exception bodies. a log is
diagnostic evidence, not a generation terminal.

the 2026-09-27 candidate records those bounded fields before host terminal
normalization, and a disposable host failure probe passed. a full native-host
to caller contract-defect journey remains unverified on this tree.

pr #412 merged as `27e961be6`. close after the pinned host and caller on one
release sha retain the correlated first safe cause through a real failure,
without logging prompt or bearer content.
