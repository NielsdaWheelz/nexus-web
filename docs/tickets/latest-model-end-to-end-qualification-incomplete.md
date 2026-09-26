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
another 41 api browser/bff/api/db/worker cells passed on nexus `5e4a15f`:
openai 34, gemini 3, deepseek 4. every run gave a correct answer and matched
its frozen selection, native model/reasoning fragment, usage, labels, and one
terminal in a read-only postgres check; no tool effects. the interim catalog
omitted anthropic pending its explicit retention acknowledgement. browser
receipt: `/tmp/nexus-latest-models-browser/api-41-receipt.jsonl` (sha256
`32e29bd778fede2b89d33226634c714618045e0466714c5405470bcd0997d2ed`);
native/db receipt: `/tmp/nexus-api-41-native-receipt.md` (sha256
`4cf59b3bde65b9faea2964fec97003eba3fb26878c03dca37765f50d5ff54d4e`).
the linux host denied direct internet and app-db routes. across the matrix its
cgroup peak was 200,302,592 / 469,762,048 bytes and 40 / 64 processes, with
zero memory events or oom kills. the egress sidecar stayed below its limits.
these are cumulative container peaks, not per-cell measurements.
fresh direct-uds cancellation and native process-death/restart passed; host
admission replay passed before dispatch. receipt:
`/tmp/nexus-codex-boundary-20260926-receipt.md` (sha256
`157c44a63bcd9f96943eaa60554bf5e8721c1e8f016ec90b896713f265a7c39c`).

no successful model-originated nexus tool result is proved: one `web.search`
call had invalid model arguments; a second reached Brave with an invalid
subscription token and left a billed-once position `Uncertain` while chat
incorrectly completed. the new parent-terminal guard passed 19 real postgres
cases and is committed in `5e4a15f`; a separate cancelled-run dead-letter
guard passed nine migrated-postgres cases and is committed in `75b60bf`.
neither changes the already-completed test run. see the separate web-search
ticket. deterministic protocol injection rejected five forbidden native/
delegation event types; it is not a live model attempt. the 20 anthropic nexus
cells, actual codex
credential refresh, durable chat cancellation/reopened-work without duplicate
paid calls or effects, and successful model-originated nexus tool result remain
open. direct-uds cancellation and host admission replay do not prove those
durable chat boundaries. the 41-cell native check used persisted library
encoder metadata and accepted response evidence, not a tls packet capture.
`./scripts/test` is static and cannot qualify them.

## prerequisite and acceptance

run a fresh model-originated tool call with a valid protected search credential
and prove its durable result and answer provenance. obtain explicit owner
acknowledgement for anthropic's standard retention before setting the required
timestamp and running its 20 browser/native cells. exercise actual codex auth
refresh on an independent disposable credential and durable chat cancellation/
replay without duplicate paid calls or effects. keep temporary live proofs
until these cases pass and report xai's owner waiver separately.
