# latest model end-to-end qualification incomplete

status: open · origin: 2026-09-25 latest-model cutover · area: generation release proof

## problem and evidence

current gate (2026-09-26): provider catalog v4 reports that pinned Codex
0.157.1 cannot enforce the frozen MCP-only tool set. Nexus now admits Codex
for text-only library calls but marks all 15 Codex chat pairs ineligible;
three tool-backed background jobs and the approved new-chat seed still point
at that route. The historical Codex tool-call receipts below prove transport,
not authority, and do not qualify the final release. The owner is deciding
whether those workloads may move to ProviderApi. Nexus cannot start with an
ineligible background policy; do not weaken that validation for qualification.
The final v4 stack has not been rebuilt or exercised. Temporary proof scripts
remain until the full acceptance contract is met.

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
on the final `75b60bf` worker, one fresh openai chat was canceled while its
paid child was armed. browser, sse, run, parent, child and job agreed on
cancellation; usage was absent and billability remained possible. receipt:
`/tmp/nexus-fullstack-cancel-20260926.md` (sha256
`f0c1d7c0461f44c099b03b10e312a2dfdbfc802fe31a00781b61500c9eacd12c`).
one codex chat completed a model-originated `nexus.search` mcp call with a
settled zero-attempt empty result (receipt `/tmp/nexus-search-empty-restored-20260926.md`,
sha256 `e39c7c4747ac836e404df060e40c6d9d46efe9d9f8e751916f9c58c3094b5c6f`).
one openai api chat settled the same tool through two completed model turns
and a consumed sealed continuation (receipt
`/tmp/nexus-provider-search-continuation-20260926.md`, sha256
`61341c8253164dd8b92608ea71d0fd2651fa9f5e1eb802e6daffe2b68c909222`).
the empty corpus proves transport and continuation, not factual grounding.

on exact nexus `a80087ffb`, a fresh paid openai chat proved the worker crash
window. a separate database read saw the parent, child, usage and
`generation/1=Completed` committed while publication's `UPDATE messages` waited
on an owned row lock. the interactive worker was hard-stopped, the lock was
released, and the restarted worker reclaimed the job only after its 1200-second
lease expired. attempt 2 published the stored answer with one parent, one child
dispatch, unchanged terminal and usage, zero tool effects and one `done`. two
fresh authenticated bff gets matched the persisted answer; two sse reads
replayed the same 323 events with one terminal each. the original runner's
post-settlement browser read failed while task web was down, so its nonzero
exit is retained; the independent read-only session supplied that missing
boundary. receipt: `/tmp/nexus-latest-models-browser/worker-crash-replay-a800-receipt.md`
(sha256 `19bdd3ea05cba3a3c43f4f8592fb5b8fa49b590c6f2a666670acf6bd6bec293a`).
the crash probe first exposed a stale chat job payload that regressed the
completed generation journal to `Prepared` during publication. the fix in
`a80087ffb` passed a disposable migrated-postgres red/green and `./scripts/test`.
this no-tool run proves paid-generation and chat-publication replay, not a tool
effect through the crash window. the later provider pin is not covered by this
exact a800 stack proof.

no successful model-originated `web.search` result is proved: one call had
invalid model arguments; a second reached Brave with an invalid
subscription token and left a billed-once position `Uncertain` while chat
incorrectly completed. the new parent-terminal guard passed 19 real postgres
cases and is committed in `5e4a15f`; a separate cancelled-run dead-letter
guard passed nine migrated-postgres cases and is committed in `75b60bf`.
neither changes the already-completed test run. llm-tools `8d5f488` now
classifies the bounded Brave 422 `SUBSCRIPTION_TOKEN_INVALID` response as
`CredentialRejected`; its final browser/ledger journey remains unrun. see the
separate valid-key web-search ticket. deterministic protocol injection rejected
five forbidden native/delegation event types; it is not a live model attempt.
the 20 anthropic nexus cells, actual codex credential refresh, frozen codex
mcp-only authority, and `web.search` result grounding remain open. the a800
worker replay must be
assessed against the final provider pin; repeat the crash-window journey if that
pin changes the journal, worker replay,
or publication contract. the 41-cell native check used persisted library encoder
metadata and accepted response evidence, not a tls packet capture.
`./scripts/test` is static and cannot qualify them.

## prerequisite and acceptance

settle the owner route decision and prove any newly required provider capability
before changing background policies or the new-chat seed. rebuild the exact
final pinned stack and exercise its catalog, browser, api, worker, ledger and
failure states. run a fresh model-originated tool call with a valid protected search credential
and prove its durable result and answer provenance. obtain explicit owner
acknowledgement for anthropic's standard retention before setting the required
timestamp and running its 20 browser/native cells. exercise actual codex auth
refresh on an independent disposable credential. compare the final provider
pin with the a800 replay contract, then run a representative final-stack turn;
repeat the crash-window proof if the replay contract changed. establish frozen
codex tool authority before qualifying tool-bearing codex cells. keep temporary
live proofs until these cases pass and report xai's owner waiver separately.
