# latest model end-to-end qualification incomplete

status: open · origin: 2026-09-25 latest-model cutover · area: generation release proof

## problem and evidence

the provider passed 61 of 65 api cells; four xai cells are owner-waived, not
passes. five live three-turn api continuation journeys and all 15 codex
model/effort cells passed through the provider runtime. pinned codex 0.157.1
also completed model-originated https mcp calls in text and strict-json modes.
provider receipt: `/tmp/codex15_receipt_9350.jsonl` (sha256
`12ea945866dc67dc8cd40b5556e0605fc4d9436acc309df93960cb463773dc1a`).

all 15 codex browser/bff/api/db/interactive-worker journeys passed with a
nonempty sse terminal, exact persisted selection/labels and native dispatch,
one succeeded model turn, and usage. the matrix used api `00ba5948`, worker
`2668185a` and host `00ba5948`; subsequent final `0c48d6f2` api/worker images
passed no-key blocked and with-key selectable catalog checks. matrix receipt:
`/tmp/nexus-codex-15-browser-receipt.md` (sha256
`09eed8c597dd27a393caa92b7e2ccd70c677a3886c7e090969c4e49e008d19c1`).
the linux host denied direct internet and app-db routes. across the matrix its
cgroup peak was 200,302,592 / 469,762,048 bytes and 40 / 64 processes, with
zero memory events or oom kills. the egress sidecar stayed below its limits.
these are cumulative container peaks, not per-cell measurements.

no successful model-originated nexus tool result is proved: one `web.search`
call had invalid model arguments; a second reached Brave with an invalid
subscription token and left a billed-once position `Uncertain` while chat
incorrectly completed. see the separate web-search ticket. deterministic
protocol injection rejected five forbidden native/delegation event types; it
is not a live model attempt. actual codex credential refresh, cancellation,
process death and durable reopened-work/no-duplicate-effect proof remain open.
`./scripts/test` is static and cannot qualify them.

## prerequisite and acceptance

run a fresh model-originated tool call with a valid protected search credential
and prove its durable result and answer provenance. prevent a generation
terminal over an unsettled tool position; qualify that guard with a red/green
ledger proof. exercise cancellation, process death, auth refresh on an
independent disposable credential, and replay without duplicate paid calls or
effects. keep temporary live proofs until these cases pass and report xai's
owner waiver separately.
