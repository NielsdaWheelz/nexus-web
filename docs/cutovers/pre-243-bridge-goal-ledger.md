# bridge-goal audit

status: complete source audit; final dispositions reconciled with merged pr #254.
origin: 2026-09-14 restoration session.
baseline: `98a8b63bf0e72da5cb7e82ba2a9098716de58c84`.
bridge merge: `1b2a7a38174a55075df3d3ee258a91dcbfc0d64a`.
scope: all 57 commits in `1b2a7a3^1..1b2a7a3^2`; first-parent patches, dependency changes, substantive test assertions, merge resolutions, and baseline owners were inspected. the initial replacement is characterized by exact tree identity with `7e8fd48244b3b436965037738e05785bb4931be1`.
environment: initial inspection was read-only on the devbox. no remote files were created and no tests or mutations were run by this auditor. after the user's change of instruction, report preparation used local macbook git only.

## dispositions

the evidence column records the original immutable-tree audit. the final column supersedes its testing recommendations after #254. “already present” means the coherent architecture owns the product behavior, not that a legacy implementation was transplanted.

| bridge commit | original goal disposition | original evidence and decision | final disposition after #254 |
|---|---|---|---|
| `01b5b6d5db9c112950987b61b6fc5f2de3a09bff` | obsolete db0215 compatibility | replaced 1,732 paths with the exact 7e8fd482 tree; inverse merge restores coherent 98a8b63bf0. reject the replacement itself. obsolete compatibility work; do not restore legacy graph or proof registry |
| `ca05779041bd85e94751c5f37873b26edebc1e2a` | obsolete db0215 compatibility | legacy provider-runtime pin 6ccf36d→b51c557 plus idle-import proof. restored architecture requires df12d547 and llm-agent-kernel 86504b56. retain the bounded-memory goal; measure restored supervisor/shared-agent owners before any dependency port. obsolete compatibility work; do not restore legacy graph or proof registry |
| `1c2791ae02fe74d3896004d58ec5e549ae42814a` | required forward port | python/uv.lock: pip 26.1.2→26.2.1; baseline still 26.1.2. retain this isolated audited dependency update. audited pip package disappears with #254 pip-audit removal; no runtime dependency downgrade |
| `2b6d932292e15b3d40b7d51792cfe72d556e8b3c` | already present | publisher hermetic workspace script is byte-identical at baseline; setup/workflow self-hosted mechanics must be reconciled through the retained post-bridge workflow owner. do not duplicate the publisher abstraction. publisher isolation retained; archived external test hydration removed |
| `20b7b88df35ec346926230c61bbdd399345d52aa` | obsolete db0215 compatibility | legacy worker-provider-execution-import fault targets deleted llm_profiles.py. replace evidence with restored worker/process measurements; do not restore the legacy provider graph. obsolete compatibility work; do not restore legacy graph or proof registry |
| `1aa855bf96d1b7a49f1f0ac6fcb162a9185a5314` | test-control machinery separate | changes legacy import failure from assert rewriting to an explicit assertion error. no product behavior; do not import an obsolete proof just for its fingerprint. test-control machinery separate; superseded by #254 direct check |
| `0cf8d9267c6795b67b4d159e3ffd565ffd298778` | test-control machinery separate | reports blocked import roots rather than every loaded module. bounded diagnostics are sound; no missing product behavior. test-control machinery separate; superseded by #254 direct check |
| `e4fe6c256b9e8220dc2b779b5319e2b0ff8c6a1c` | required forward port | apps/web/e2e/articleFixture.ts must require ingest_enqueued=true before treating a browser capture as an accepted durable ingest. companion restoration proof for upload diagnostics. test-control machinery separate; fixture removed by #254 |
| `a694008161d272fd1ad4a828e66f7f41a7738365` | required forward port | python/nexus/services/media_source_ingest.py: baseline capture upload exception at line 870 persists failure but emits no browser_article_capture_upload_failed diagnostic. port structured identifiers/error classification through existing logging. retained product capture-failure diagnostic |
| `dc05cb7ac66725432d9aada174f84c8820340fac` | required forward port | backend-images.yml exact validated api/worker digest cleanup after immutable bundle upload, before private workspace deletion. removes only the images this publisher pulled; baseline lacks this cleanup. retained exact publisher image retirement |
| `6c57d423e2c6ca85cb323a8de738eb323ef704b9` | obsolete db0215 compatibility | bridge priority-risk ownership digest merely accepts reduced db0215 portfolio; restore coherent baseline registry and derive any approved restoration additions. obsolete compatibility work; do not restore legacy graph or proof registry |
| `8a67f6f23074835d86aed3f6531c1d12c6416f6b` | required forward port | storage.py + runner heavy admission: require known free space on every owned write filesystem under the existing lineage lock. baseline lacks storage admission; adapt to current runner instead of replacing it. test-control machinery separate; docker test runtime and its storage admission removed |
| `d879b823c477d3b69d477a556066d6542dbdf8de` | test-control machinery separate | records shared buildkit cache growth/exhaustion. preserve docs/tickets/devbox-buildkit-cache-retention.md unless a reviewed owned-cache fix resolves it; free-space admission alone does not. test-control machinery separate; superseded by #254 direct check |
| `f43c249ecb48e3a007141f92910b8dd59e19d80d` | obsolete db0215 compatibility | legacy runtime and tool-safety v3 proof pins to b51c557. restored shared-agent tool-safety and dependency contracts own newer pins. obsolete compatibility work; do not restore legacy graph or proof registry |
| `ec40d76ad4ef4d00b0435e72f580e55ec2efb46c` | already present | baseline test_pinned_llm_tools.py already asserts the query x reaches brave and binds the actual declared provider pin. additional legacy fault/fingerprint is test-control work, not a product port. historical test goal; excluded machinery removed under #254 |
| `299a2b922a9d374ac48d6bcd029eae350eeed61b` | already present | baseline activityRuntime.browser.test.ts:40–49 already pins TEST_NOW_MS and creates deterministic activity runtimes. historical test goal; excluded machinery removed under #254 |
| `ae0c2f4240dc7df493dd0a92628886f6e4d6cfb4` | already present | baseline memory.py already implements darwin probes, floor/ceil separation, consecutive container-failure samples, and truthful process-probe failures. historical test goal; excluded machinery removed under #254 |
| `645c8197057ebe225aa975bdb224ed14d7645d0b` | already present | baseline useChatDraft.ts:47–69 uses external-store recovery/storage/hydration snapshots; restored ChatComposer gates editing/send until restored. preserve current architecture. already present in coherent product architecture; retained |
| `463e0b50719719402a5eda545af4ee127bfef377` | already present | baseline media.py:962 constructs Present[SourceProgress] at the declared media boundary before serialization. already present in coherent product architecture; retained |
| `a06d621f759f6dbf08e2a1190e512324cafee0a2` | already present | baseline test_bounded_media_extraction.py:2250 proves counted/stage progress through returned media DTOs; project warning policy raises UserWarning. retain current proof owner. historical test goal; excluded machinery removed under #254 |
| `1140eb25454d19df99c0225819f908a078f5e667` | test-control machinery separate | removes local external-protocol provisioning for deterministic eval on the legacy graph. restored evals have shared-agent/provider process boundaries; do not carry this routing deletion without proving their current dependencies. test-control machinery separate; superseded by #254 direct check |
| `c3e0069ec31674565749b3accf9d13e9225ded23` | already present | unused present import cleanup is subsumed by restored media.py typed progress constructor. already present in coherent product architecture; retained |
| `92d37ec443d6bc779652f8064b1f46d245a87eef` | already present | baseline progress-wire proof completes exact claimed attempt and removes its local rows at test_bounded_media_extraction.py:2333+, releasing capacity. historical test goal; excluded machinery removed under #254 |
| `1f17317e3f56b692fec2d4821d5eed04d0cc4e51` | required forward port | services.py must reserve every persisted port of other linked worktrees, including currently idle listeners and schema-upgrade allocations; baseline only checks live socket availability. port current RuntimePorts schema and exact ownership checks. test-control machinery separate; allocated test runtime removed |
| `d75eb719150a70eae65de04ecc24871d0f0c371f` | test-control machinery separate | prior/current CI runtime retirement goal is retained by post-bridge route and cleanup owner; do not revive superseded direct-python startup cleanup. test-control machinery separate; superseded by #254 direct check |
| `d7aa39d15befbe595931dfc87c84e814e2ffd934` | test-control machinery separate | adjusts a source-text policy assertion to guarded cleanup indentation. retain current workflow/policy aggregate, not this incidental form. test-control machinery separate; superseded by #254 direct check |
| `3e44aa2dbbfc9c0476d731c135590ccb41380f27` | test-control machinery separate | tracks cleanup invocation cardinality in old policy route model. current retained post-bridge policy must own actual route counts. test-control machinery separate; superseded by #254 direct check |
| `a6c2288032e2604514ad578b9a9d76235cd8b0cb` | test-control machinery separate | format-only changes to legacy CI lifecycle policy/proof. test-control machinery separate; superseded by #254 direct check |
| `c2004ff1b35f4a4a2183bb85d7fdf68e45d1e02f` | test-control machinery separate | repairs exact old cleanup source-text assertion. no independent product behavior. test-control machinery separate; superseded by #254 direct check |
| `62bec5fdba2f0b2ab91d2c92ef7d9726ad971b0f` | already present | baseline runtime.py:659–714 already locks by complete Git lineage across independent clones and linked worktrees, rejecting shallow history. historical test goal; excluded machinery removed under #254 |
| `a7830b73ea4bddc262784401e8e82dd105617f62` | test-control machinery separate | broad CLI invocation lease, pre/post complete-stack cleanup, and thread-local reentrancy. baseline runner already holds lineage lock through run cleanup; retain later exact stale-run recovery/current cleanup under that owner instead of adding a second lifecycle. test-control machinery separate; superseded by #254 direct check |
| `03d66d04bca2629e0188812c5e6239740ae84d22` | test-control machinery separate | records missing host-proof privilege discovered mid-gate. retain unresolved privilege follow-up if root-ownership preflight is not forward-ported; restored tree already contains related host-oracle fixture ticket. test-control machinery separate; superseded by #254 direct check |
| `28773e4be2a65649fc1d08131474dbd8461ad9d9` | test-control machinery separate | bypasses lineage lock for direct-python precheckout cleanup; superseded by 64de7964 and contrary to retained later lock-based recovery. reject bypass. test-control machinery separate; superseded by #254 direct check |
| `9ed2619d559c8c21b7561e0bee87252d7490b015` | test-control machinery separate | batches all sensitivity reds before greens to avoid simultaneous legacy stacks. retain current proof planning; verify exact per-proof stack retirement under the post-bridge cleanup owner instead. test-control machinery separate; superseded by #254 direct check |
| `8f828856c61d931896f8dc14b1679c7714bbe174` | already present | merge of main c4e536d4: note caret/focus/submit behavior and PDF selection cleanup. baseline contains main implementation; bridge merge adapts it to older PDF architecture. already present in coherent product architecture; retained |
| `fa7ba450443562ad708c1f2a3de9a5bd56c5a1cf` | required forward port | expected null highlight creation must retain exact unsaved note and focus, show nonretryable copy/reselect guidance, and avoid a note write; unexpected rejection must still reach defect boundary. baseline generic Error loses editor. retained product draft preservation; browser harness removed |
| `d19ba0d597b8e3e7ffe13bf9419c04e16976a71e` | required forward port | same highlight-failure goal: preserve FeedbackNotice fixed action cardinality, retry+discard only for retryable failures and discard alone for absent target. combine with fa7ba450 as one semantic goal commit. retained strict editor error boundary; browser harness removed |
| `5327993067b17099e48e5855d504778a4f117b34` | test-control machinery separate | policy binds now-superseded direct-python runner recovery; reject that route and retain later locked public route. test-control machinery separate; superseded by #254 direct check |
| `f5ffec12486155604da0bd3d8ad5dfe38614f502` | already present | merge of main 7a646cf5: canonical anchored resource actions and menu ownership. baseline owns those changes already. already present in coherent product architecture; retained |
| `dc1f1d184ae16dbabd65c8d52c9d80db6b4e29c2` | required forward port | resource-action-parity journey must await exact requested route and active media region before using mobile controls; baseline can accidentally target old browse pane. reviewed product goal retained; excluded test apparatus removed |
| `845ab4ecdea8199b8bc6ca23749bc378c7274582` | required forward port | setup-test uses engine-driver Buildx for static Docker checks, avoiding unrelated persistent per-job daemon/volume. preserve through retained setup file; publisher keeps its own build driver. test-control machinery separate; static container build removed |
| `24eec4228d8793c28f89103210b024644ab9217b` | test-control machinery separate | adds concrete cache exhaustion evidence to bridge cache-retention ticket; preserve unresolved evidence. test-control machinery separate; superseded by #254 direct check |
| `5088da31e6af15ad2701df9b2651a131afaa65f7` | test-control machinery separate | fixes violation.detail→violation.message assertion in obsolete direct-cleanup policy proof. test-control machinery separate; superseded by #254 direct check |
| `7d9e4ae9044139e2ec8d406de8de38eb1156e77f` | test-control machinery separate | matches annotated Buildx action pin in source-text proof. retain applicable current setup proof, not obsolete formatting expectations. test-control machinery separate; superseded by #254 direct check |
| `1e544f00e2a030c68775c97c03a89beab73bdf48` | required forward port | same mobile parity goal as dc1f1d: bind mobile banner to exact reader heading and invoke its More control; banner is outside media region. reviewed product goal retained; excluded test apparatus removed |
| `e49321220c0928fd19a76d3f330afe96114bfdb9` | test-control machinery separate | moves heavy-capability unit fixture from real repo to tmp_path. useful local isolation; no product behavior or mandatory architectural port. test-control machinery separate; superseded by #254 direct check |
| `64de7964c932e6d16901a10f66c776dec97dcb5d` | required forward port | precheckout cleanup must use owning checkout public scripts/test clean under lineage exclusion; post-bridge workflow/policy aggregate already preserves this route. retain it while restoring product. reviewed product goal retained; excluded test apparatus removed |
| `dc244bb9108e0310a062cad84c4b2159e5ef4f42` | test-control machinery separate | records recurring engine BuildKit cache growth after changing driver. ticket remains open until cache ownership/retention is resolved. test-control machinery separate; superseded by #254 direct check |
| `d7d3c44d59d6e0b8009c2f554edf88cf29b872fb` | test-control machinery separate | typed root-ownership proof prerequisite and early sudo check; no product change. qualified local execution or truthful not_run is required; keep separate unless current workflow needs the narrow preflight. test-control machinery separate; superseded by #254 direct check |
| `f7857c4afe83fb74ba068990bda6d61274ef07d1` | required forward port | baseline has both central ResourceActionMenu chrome lock and redundant MediaPaneBody leaf lock. registered fault removes leaf only and therefore cannot falsify central behavior. remove duplicate leaf ownership, target fault at central onOpenChange, retain existing behavioral oracle. retained central mobile chrome owner; fault harness removed |
| `d0b813b526aae5d708c4622d7a51b55b7e24e0dd` | test-control machinery separate | defers imports so missing RootOwnershipRequirement reaches behavioral assertion in old-base sensitivity. companion only if that optional preflight is ported. test-control machinery separate; superseded by #254 direct check |
| `4438b1d4b14105c703945a10a4fefd7607648192` | already present | baseline sensitivity.py:574 preserves any explicit ::node before canonicalizing whole-file selections. already present in coherent product architecture; retained |
| `a71234f9c98e9617d0b272c9e7c3794ba6bb5add` | already present | merge of coherent main 98a8b63bf0 into bridge has no first-parent tree delta; it retains ancestry without restoring product contents. already present in coherent product architecture; retained |
| `3cc2ec62c3f1347abc335dbe8bf26311dc16a12b` | required forward port | .bun-version=1.3.10 plus setup-bun version-file and effective-version check; baseline lacks pin file. retain exact toolchain contract referenced by post-bridge setup. retained exact bun 1.3.14 pin, matching restored build |
| `50a79b93b7e147f5f958cc246ee00bee05863142` | test-control machinery separate | assert missing bun pin as an assertion rather than file-read error. preserve proof as companion to retained pin when needed. test-control machinery separate; superseded by #254 direct check |
| `6e6d572c61a7de1ddfb4701be5c6a36cc365053d` | test-control machinery separate | format-only root ownership preflight set comprehension. test-control machinery separate; superseded by #254 direct check |
| `704824e4dac800d35aded33b8b15fe829d53795d` | obsolete db0215 compatibility | imports HighlightLinkedNoteBlock from legacy api module. restored canonical highlightContract owner is correct; reject legacy import. obsolete compatibility work; do not restore legacy graph or proof registry |

## required product and proof ports

- audited pip lock update: `1c2791ae02`.
- browser article failure observability and durable-ingest fixture assertion: `a694008161`, `e4fe6c256b`. use existing redaction/logging boundary; no extra logging framework.
- absent highlight target retains unsaved note: `fa7ba45044` + `d19ba0d597`. one semantic goal; retain restored highlightContract imports. preserve the distinction between expected absent result and unexpected rejected creation.
- mobile parity acts on requested reader: `dc1f1d184a` + `1e544f00e2`. the shared mobile banner is outside the media region.
- mobile chrome fault follows the real owner: `f7857c4afe`. existing central ResourceActionMenu ownership supersedes the redundant page effect. the current baseline fault is demonstrably aimed at the wrong owner by source inspection; run actual fault sensitivity to confirm repair.
- port linked-worktree persisted-port reservation `1f17317e3f` to the restored runtime schema. cleaning a candidate must never inspect a foreign runtime as authority to delete it.

## retained safety and memory decision

retain exact publisher digest retirement, the hermetic publisher workspace, the
restored bun version, candidate settings admission before quiescence, readable
nonroot image sources, and the restored deployment safety boundaries. all test
runtime locks, planning, admission, receipts, sensitivity, and browser process
lifecycle code are removed with their consumers under #254.

do not repin the shared-agent graph to legacy provider-runtime
`b51c55720268c1eb6c99d08447edc2623adf04ab`. retain provider-runtime
`df12d547a675c5bef32d9118b0e8d5354dc96845`, llm-agent-kernel
`86504b5696d495fa5e9019adaa6d3d074d832fa6`, and llm-tools
`9e6d155f3b64f03495911435b7cae8b8d131f9a2`. no final restored worker-memory
qualification is claimed. it remains a separate release prerequisite; the
historical migration run's aggregate memory is not a worker-capacity result.

## separately committed forward ports

| goal | restoration commit | final state |
|---|---|---|
| pip dependency | `571729a6` | package removed with excluded audit tooling |
| browser capture diagnostics | `b8e9b830` | retained |
| durable browser capture fixture | `d4949879` | removed under #254 |
| absent-highlight draft preservation | `98d9f08f`, `0bd5eac1` | product retained; browser proof removed |
| exact mobile reader readiness | `7244ace5` | excluded journey removed |
| central mobile chrome owner | `7c3bb956` | product retained; fault removed |
| filesystem admission | `5cb017c2` | excluded test runtime removed |
| publisher image retirement | `e408cce1` | retained |
| static build driver | `9227742e` | excluded container test build removed |
| bun pin | `73bc6f56` | restored 1.3.14 retained |
| external suite checkout ownership | `d076b5e6` | external suite hydration removed |
| prior checkout recovery | `6b3087ea` | test runtime removed |
| stack teardown | `187b4e72` | test stack removed |
| durable port reservation | `b5d4c526` | test port allocator removed |

these commits remain ancestry. retaining a goal does not require retaining its
obsolete testing implementation. production history deletion and forward-only
recovery remain explicit release tradeoffs; see the migration ledger.
