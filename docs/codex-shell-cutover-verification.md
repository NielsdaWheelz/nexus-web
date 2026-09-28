# codex shell cutover verification

status: staged; release qualification incomplete · observed 2026-09-27

the receipts below attest to the pinned pre-main-integration sources, not the
later merge tree. the integrated source requires its own release qualification.

## pinned cohort

nexus api/worker/host `d6b06991c2b49ac6d5d0b1c9880be7f94d35e7b5`; web
`a504016239b57d8e263812e5ddf694f05b772acc`; llm-calling
`6a7093f799c88c205c8d797bbb8b14c2a9980db1`; llm-tools
`d305da8fb5f5eda89049779c4c4dfa4f1916618c`; llm-agent-kernel
`937434b051d99c3dd10402db23e16d8baf129ebd`; codex cli 0.157.1.
backend and web commits differ only by browser draft and url-seeded workspace
persistence repairs. the isolated linux arm64 stack uses database
`nexus_shell_8e3`, not production.

## observed

- all 15 codex model/effort browser-to-native cells passed on `d6b06991c`
  before the repaired web; exact selection, one terminal and persisted
  usage were read back. this is not an exact-web-`a50401623` matrix.
  browser receipt sha256 `40495277fbd49f5d50dccdaa90fe3bd6a61000797adbea5e14cd1253de0491d8`;
  ledger sha256 `bb6e4d81641dc11e9ec284450d7b5a0a7c55e866bbeeaefdbf94532b6e766848`.
- a representative `gpt-6-sol/medium` codex turn passed on repaired web
  `a50401623`, with matching native selection, usage and one terminal in
  postgres. browser receipt sha256
  `03dba1b675e303336f2c29773045e7bd0163827aad6ed4a22de02ed2e3b25cfc`;
  ledger sha256 `6b282b4896f52def3942cb8543e278d5e37ac6690f0d1479109b7c21044e08e2`.
- all 41 permitted provider cells passed on the pinned backend and repaired
  web: openai 34, gemini 3, deepseek 4. the independent postgres read found
  exact native selections, usage and one completed turn/terminal per run.
  browser receipt sha256 `7feb60fcc5cd8edccf8166951cfab66a64f794c67c71ef145e80b0274815bfbf`;
  ledger sha256 `44c588cc41191c3304733e3321087f9e8f5ba8a7b2223dcfd54029b4f14d371c`.
- a separate openai provider chat called `nexus.search`; postgres shows two
  completed model turns, one settled tool position, consumed continuation and
  one terminal. its result was an empty search, so it proves transport and
  continuation, not factual grounding. browser receipt sha256
  `3230cc401d7dfce7aee6667df96c771951f95303a44b9bf01f64c61e84f304fe`;
  ledger sha256 `d9da33690816992958e777a1b9a00911fc6959ea39968f4c1907994213ecdcf5`.
- the exact pinned provider library passed fresh three-turn tool continuations
  for openai, gemini and deepseek, with ordered tool results carried into the
  final answer. receipt sha256
  `9ad9b3a9aff8ae3f6d63bb2694cbf4faad536008d97dffc5b5a3e03a20af52af`.
- native shell fetched the generated schema, made dependent create/read calls,
  and the browser undid the note. separate runs read outside chat context and
  left one completed position after same-key replay; changed-body replay was
  rejected. model-originated `web.search` returned six results and grounded its
  answer in the first title, url and eight normalized snippet words. the first
  verifier rejected raw html markup in the snippet; the independent ledger
  check passed (sha256 `17bdd2f4376ac4ae3f330118ed9fd5ab5df0bf253963c39860d3a489b81046de`).
- on the repaired web source, six browser journeys passed: typed text and
  retired choice, choice without text, colliding drafts, new-chat reload after
  save, immediate reload, and failed workspace save. the latter two offered
  explicit recovery of text and exact choice while preserving the source copy.
  receipt sha256
  `b9323828912ef8d71636e1b4416628f5f930c0fe6bde0e9d24d2336c37db3ec7`.
- authenticated public ingress returned 404 for both `/agent-api/openapi.json`
  and `/api/agent-api/openapi.json`; direct private api without a bearer returned
  401. the x86_64 worker image `sha256:c8383decb18e874701cc822eca703eab8f24abe4d2a83130b1f1ccfe37ad5f5b`
  passed its bubblewrap health probe as uid 10001. no x86_64 paid turn was run.
- in the isolated arm64 host's actual bubblewrap command, public https and a
  small pypi wheel download succeeded; scratch was writable and removed at
  teardown. credential/control/source paths were absent, and direct database,
  metadata and ipv6-mapped database connections failed. this was a sandbox
  probe without a model turn, not full lifecycle qualification. receipt sha256
  `f73992473d2e58648ad59d131045765006e3550cfe3ab0637fe38d17efa9c97a`.
- a detached child started inside that namespace; normal `ExecServer.stop`
  left zero marked processes and removed scratch. this is not a host-death or
  restart proof. receipt sha256
  `ecd1d07e0afee216498015c6159ec37a1d5f2bc4d9822606fe1e754074fab1ff`.

## unqualified

anthropic's 20 nexus cells remain blocked by the owner's refusal to acknowledge
standard retention. four xai cells have an explicit owner waiver, not a pass.
actual codex auth refresh, the twelve background roles and background
write/list/undo, and remaining lifecycle/denial cases remain open; see the
linked tickets in `docs/outstanding-issues.md`. nonsecret receipts remain;
disposable tracked proof files were removed from the merge target because one
used a retired contract. unfinished journeys need fresh final-source proof.
no production deployment or reset occurred.
on final backend `d6b06991c`, a note dossier produced a cited revision but
ignored a persisted user instruction to create a note. the generation had
`CodexShell` authority and zero tool positions/effects; this is a failed
background write proof, not an api refusal. receipt sha256
`a58ef597917715083370856fb386df142e9f034d846abcd17e9c677ba2756d15`.

url-created visits now incur a workspace-session write. if reload outruns that
write, the user must explicitly choose a saved draft; the source stays intact,
so recovery can leave a duplicate. this favors preserving text and choice over
silently merging distinct chat visits.
