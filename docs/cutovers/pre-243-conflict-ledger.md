# post-bridge safety and conflict audit

## identity and method

- coherent source: `98a8b63bf0e72da5cb7e82ba2a9098716de58c84`.
- bridge merge: `1b2a7a38174a55075df3d3ee258a91dcbfc0d64a`.
- audited post-bridge target: `a1f59a755c91bdc22e77e33c12b93dde829a8e6e`.
- range contains 21 commits, including five merge commits, and modifies exactly 14 aggregate paths.
- baseline comparisons use immutable git objects, never the dirty primary checkout.
- nine paths actually conflicted in the requested inverse merge. all 14 declared paths were reconstructed from the coherent source plus reviewed post-bridge goals. retaining a current-main file wholesale would preserve the bridge rollback: these owners lost 18,486 lines in the bridge comparison.
- initial restoration and semantic post-bridge resolution: `04173fbc`. later forward ports are separate commits.
- no production, image publication, deployment, migration, test, or primary-worktree operation was performed by this audit. work moved to the isolated macbook checkout after the user changed host instructions.

## path resolution ledger

| path | resolution and retained goal |
|---|---|
| `.github/actions/clean-generated-web-build/action.yml` | retain post-bridge new action byte-for-byte: exact ignored runner-owned `.next`, no symlink/mount/foreign target; absence is accepted. |
| `.github/actions/setup-test/action.yml` | restore baseline caddy pin, go 1.25.1, rootless cgroup setup, container detection, and immutable archived offline suite hydration. retain job-owned offline-complete uv cache and exact fresh Python environment plus generated-build cleanup. omit bridge removal of required restored toolchains. |
| `.github/workflows/ci.yml` | restore baseline changed/pr routing, exact invocation artifact claim, cancellation propagation, mandatory evidence upload and result enforcement. retain generated-build retirement after both terminal job paths. separate bridge prior-checkout cleanup patch restores lock-owned cleanup without replacing exact evidence ownership. |
| `apps/android/gradle.properties` | preserve source and add `kotlin.compiler.execution.strategy=in-process`, so no daemon survives the owned Gradle process. |
| `deploy/hetzner/release.py` | restore full candidate/capacity/forward-fix controller and keep the bounded, networkless, read-only candidate settings probe before attempt creation or writer quiescence. inverse merge auto-merged this correctly. |
| `docker/Dockerfile.backend` | restore isolated codex worker dependency stage and agent application; normalize copied Python/API/worker/Oracle/migration sources. extend the post-bridge worker chmod to restored `/app/apps/codex_agent`, which an automatic merge omitted. |
| `docs/local-rules/testing-standards.md` | restore coherent sensitivity, exact evidence, Darwin, cgroup and browser epoch contracts; add the valid later cache/env/build/Kotlin/3,584 MiB/process-retirement requirements. retain the measured reserve and explain that it is admission, not a performance claim. |
| `python/nexus_test_control/runner.py` | restore shared-generation peers and baseline capability topology; retain 3,584 MiB memory admission. retire exact run processes after each browser capability. distinguish provider process liveness from retained fixture objects, retain provider/embedding/generation identities and one browser data epoch, and restart their processes when needed. |
| `python/nexus_test_control/services.py` | preserve baseline cgroup scopes, repository/process birth/owner/ledger identity validation and all resource owners. extract the existing scoped process cleanup for phase retirement, append process logs, and release only the generation peer's exact socket after its process stops; keep fixture state and audits. |
| `python/tests/kernel/nexus_test_control/test_runner.py` | retain baseline proof coverage, adjust recorded admission values, add process-retirement success/failure and Kotlin lifetime proofs using the restored provider identities. preserve peer objects and browser epoch. |
| `python/tests/kernel/nexus_test_control/test_services.py` | retain baseline ownership/cgroup/process coverage. regression starts a real owned process with a real Unix socket, retires and restarts it, and checks process death, socket release, append-only logs and surviving peer ledger/state. relative socket bind preserves the platform pathname limit. |
| `python/tests/kernel/test_ci_pr_recovery.py` | retain exact merge/cancellation/artifact ownership proofs and append valid cache/env/build retirement proofs. includes absent output, exact deletion and symlink rejection. |
| `python/tests/kernel/test_production_release.py` | retain the restored full release suite and auto-merged post-bridge settings-before-quiescence and no-bytecode regressions. |
| `python/tests/testkit/host_release.py` | retain baseline locked fake daemon state and richer release/capacity harness; bytecode suppression was already present. add candidate config validity/probe count and persist failed probe state before the fake command returns. |

## 21 post-bridge commits

| commit | goal and disposition |
|---|---|
| `ba57b35278a360920d5928a178756951727d3c71` | invocation-owned uv cache retaining offline wheels; retained. |
| `b4fb9599307bdb9bdbb20c83cac23625bba4eaa9` | regression for the uv cache contract; retained. |
| `a577829f595fccad825e88417a82782152f75f41` | merge #247; ancestry retained, aggregate goal above. |
| `c56a8affae57c6c8921d2559f7d56fc09b0dd929` | privileged Python does not write bytecode; baseline environment already enforces it, later behavioral test retained. |
| `afbab8152b8703033a392e6171cea04108dfc58c` | fresh locked Python environment with exact safe removal; retained with baseline offline archive hydration. |
| `daa92259b43ecabd1f2febf66abc6ee6b8d44c3a` | merge #248; ancestry retained. |
| `c5eb8567a4434373de941a75b09fc076ceb0980b` | remove old `.next` before setup/admission; retained. |
| `3e01ff0a2d48ae091fe389cb15621e044520896c` | 3,584 MiB admission protects the devbox reserve based on the measured 2,293 MiB peak; retained. |
| `c971c05fb734d6c8a53890710932b8c350077877` | Kotlin compiler shares the Gradle process lifetime; retained. |
| `2a681c2f58d2f92842753ef73d015e77d9654178` | remove generated builds after terminal proof paths; retained. |
| `74a1346e173c38c23184ad3487ad67c20a17e2c8` | absent generated build is valid cleanup input; retained. |
| `5c043b17733b71ad59754015b17bc6acb19f4902` | exact generated tree cleanup boundaries; retained. |
| `051a57b780ef2bd8785e2a2abf37b44e10999d85` | merge #249; ancestry retained. |
| `9e9731e2b854ae28723f6e70bf786dda38dc79b0` | retire browser runtime before subsequent heavy lanes and preserve reusable fixtures/logs; forward-adapted to restored shared-generation peers and socket ownership. |
| `a2ff3fa7b1d280882dad7c35b1b4088a4507a407` | regression respects controller ownership; behavioral process test preserved and adapted. |
| `ac7b844e7c7dd0ea6d17026a875d296fd090d07f` | import ordering; reflected in final imports, no distinct product goal. |
| `b1f26b134d4493f0d51e2b7d067254047ea0d864` | process error formatting; reflected in final code. |
| `05f46ead9b5391446fa23f258f334a945f86c8dc` | merge #251; ancestry retained. |
| `a2b1ac844e324cd4dfc36ceb9cbffef17771f9c8` | runtime image imports remain readable for nonroot runtime uid; retained and expanded to restored codex application. |
| `cc364f2bc9f1ba9c9c5341062747a7a4cf3ba107` | reject invalid candidate settings before writer interruption; retained with restored release controller. |
| `a1f59a755c91bdc22e77e33c12b93dde829a8e6e` | merge #253; ancestry retained. |

## separately reviewable bridge safety ports

- commit `5cb017c2`: bridge `8a67f6f230` storage admission, five files. original minimum of checkout and Docker data-filesystem free space; 8,192 MiB, fail closed on unknown, measured under existing heavy lease. deterministic runner inputs and insufficient-space regression retained. **native Docker Desktop cannot expose its VM filesystem through host `disk_usage`; the authoritative restoration runs use the linux devbox; native macos remains fail-closed.**
- commit `e408cce1`: `dc05cb7`, cleanup only the exact locally pulled candidate digest references; no global pruning.
- commit `9227742e`: `845ab4e`, use engine Buildx for static checking without another persistent daemon/volume.
- commit `73bc6f56`: `3cc2ec6` goal. pin **1.3.14**, matching the restored digest-pinned backend ingest builder; legacy bridge 1.3.10 is not the restored toolchain oracle.
- commit `d076b5e6`: `2b6d932` missing external-suite target safety only; retain the coherent source's stronger archive-based offline hydration.
- commit `6b3087ea`: `64de7964` cleanup with the still-installed owning checkout's `./scripts/test clean` before checkout replacement; includes successful, fresh-runner and foreign-symlink behavior.
- baseline already has lineage-derived locking and holds it through exact run cleanup. commit `b5d4c526` restores linked-worktree reservations. scoped entire-stack retirement is implemented in the runner's existing heavy-lease adapter: cleanup occurs after exact run consumers finish and before the same lease releases, including handled failures/interruption. no reentrant CLI machinery is added.

## later production-release requirements (not executed here)

The restored `deployment.md` is the operator owner; its restored product requirements apply in addition to migration-specific findings from the migration audit.

1. separate authorization for merge, migration, publication, infrastructure settlement and deployment. restoration PR is not a release approval.
2. exact clean `HEAD == origin/main == source_sha`; passing exact-main full CI, immutable backend digest publication and exact staged Vercel artifact. never publish an unverified partial restoration.
3. production-host candidate codex capacity qualification within 72 hours, proving subscription canary, real cgroup memory/headroom/pressure/swap/OOM constraints and unchanged incumbent services. a measured contract breach permanently disqualifies that SHA.
4. any one-time retained-swap infrastructure settlement is separately announced and authorized: exact recorded container IDs only, ordered Postgres/API/interactive/background/Caddy, health and same-ID zero-swap verification after each. never silently include this in candidate qualification.
5. planned no-use window and frozen main through durable release settlement. inventory outstanding `nx_chat_draft.v3:` browser commands, settle incompatible pre-cutover commands under old code, retain their tab/session storage and provider/journal evidence.
6. stop and prove background worker, interactive worker and API stopped. migration 0224 blocks pending/running/retryable or unclassified dead generation work and ambiguous provider effects. dispose explicitly of old fingerprint chat rows while stopped at 0225; 0226 never fabricates admission identities or authorizes resend when a row is absent.
7. controller-owned stopped-writer backup and verification before data mutation, ancestry/schema/config/image/host constraints, bounded migration container, then exact backend and public frontend proof. after data mutation or backend activation, recovery is forward-only; no automatic schema rollback.
8. first reading-capable Android release requires the separate reader publication census/rebuild operation and signed physical-device release proof. the restored runbook's stated publication revision has an independently recorded ticket; migration audit must settle the actual revision before this operation.
9. production smoke is read-only or uses a separately authorized reversible synthetic identity. no production resource was contacted by this audit.

## evidence and tradeoffs

- these are code review and immutable-tree findings, not test receipts. the pr records actual `./scripts/test` outcomes and sensitivity evidence by exact machine and sha.
- memory numbers above are retained historical admission evidence; restored worker memory must be measured afresh before deciding on any provider laziness port.
- preserve valid goals rather than transplant bridge architecture. exact scoped process identity, shared-agent peers and richer release proof stay authoritative.
- retirement restarts peer processes between browser lanes, which adds startup work but preserves reserve and independent audit state. retained peer/socket ownership makes that restart explicit.
- the CI simplification branch is not part of these patches and must be rebuilt separately after restoration.
