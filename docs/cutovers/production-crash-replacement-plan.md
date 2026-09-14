# production crash: replacement plan

status: parked, 2026-09-14; work closed for now, implementation paused.
supersedes execution of [the monolithic spec](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/cutovers/bounded-workspace-implementation.md).
[evidence audit](bounded-workspace-evidence-audit.md) · [preserved work](../archive/bounded-workspace-2026-09-14/README.md).

documentation handoff only: reusable paths below refer to the preserved
implementation, not functionality claimed to exist on main. recheck current-main
contracts before extracting any future change.

## outcome and boundary

supported navigation and reader overlap do not kill the api. an unavailable api
leaves already rendered panes usable and recovers within the affected feature.
committed data and acknowledged progress survive; unsaved work is labelled honestly.

retain next.js, the api, existing jobs/storage, current reader/progress protocols,
and current supported content limits. publication replacement and native migration
are **not crash-fix prerequisites**. this changes the old spec's execution scope;
it does not declare its unfulfilled requirements satisfied.

approval authorizes a sequence, not speculative redesign. later prs start from
then-current main. extract reviewed changes against its interfaces; do not merge
or cherry-pick the monolith wholesale. the preservation branch stays intact.

## incident prs, in order

| pr / outcome and scope | dependencies and reusable changes | acceptance | rollback |
|---|---|---|---|
| 1. reproducible capacity evidence. inventory the current deployed artifact and supported limits; retain exact incident/candidate fixtures, measurements and only necessary harness repairs. | none. reuse `python/tests/capacity/`, existing test-controller container ownership, retained receipts and corpus. | experiment a below is reproducible through `./scripts/test`; source/image/schema/input/config identities and cleanup are retained; baseline failures remain failures. agree numeric latency, memory and retained-growth limits before candidate qualification. | revert harness additions; leave evidence and production unchanged. |
| 2. contain gateway outages. browser/bff error classification and feature-local recovery, including shell-mounted search/history and navigation resolution. | independent of 1. reuse `apps/web/src/lib/api/{client,proxy}.ts`, existing error types, nexus/workspace boundaries and browser proofs. | inject html/non-envelope json 502/503/504 at browser and bff decoders, preserving request ids; then stop/restart the real api through the bff. desktop and mobile-browser navigation preserves healthy panes, restores failed reads, shows truthful save state; raw 502/503/504 are availability, malformed success/owned defects remain defects. no multiplied retries or blind mutation replay. demonstrate the regression before/after. | previous web artifact; no schema change. |
| 3. remove unnecessary provider residency. contract/catalog imports do not initialize unrelated adapters; preserve actual provider dispatch. | 1. reuse upstream provider-boundary work and its explicit dependency pin, plus nexus import-boundary proofs. check whether main already contains it. | cold and warm imports, first provider use and repeated dispatch pass; record cgroup/latency delta. first use must not silently restore every unrelated sdk. no savings claim from cold imports alone. | previous paired dependency manifest/lock and api artifact. |
| 4. bound image delivery allocations. remove process-global image retention; enforce byte/decoder limits and physical response/child cleanup on current endpoints. | 1. reuse `image_proxy.py`, `image_validation.py`, existing isolated decoder/process owner and storage-close proofs. adapt independently of publication routes. | valid existing image corpus, redirects and ssrf rules preserved; serial images do not accumulate; metadata amplification and cancellation respect per-operation byte/process bounds. combined overlap is qualified in 6. red/green known cache and close faults. | previous api artifact with sufficient qualified capacity retained; never restore the known unsafe limit. |
| 5. bound foreground overlap. admit expensive current reads before allocation, retain permits until work actually ends; keep readiness/progress headroom. include and qualify startup configuration for this focused workload; 6 qualifies the combined profile. | 1–4 and a finite reader contract from 1/b. reuse `python/nexus/api/read_admission.py`, existing cancellation scopes and `E_READ_CAPACITY`/503 envelope. reuse speculative-read ownership only if experiment b shows it is required. | admitted work never exceeds measured slots, including disconnects/physical worker completion. overload returns prompt 503/retry-after; ordinary admitted reads, readiness and progress meet agreed latency. malformed/auth errors retain their contracts. | previous api/config pair with qualified reserve; client 2 remains compatible. |
| 6. qualify and deliver the complete fix. select api/worker/host budgets and release the exact combined artifact/config. | 1–5. reuse `python/nexus/config.py`, `deploy/hetzner/docker-compose.yml`, existing release/smoke ownership and capacity receipts. | experiment b and the complete browser outage journey pass on a clean immutable candidate; zero oom kills, unexpected restarts or memory-limit events; bounded retained growth. record artifact/config/schema and read-only post-deploy evidence of the same build. only this closes the incident. | restore the last compatible application/config pair; retain adequate host capacity. qualify the fallback pair too; no schema/data rollback is needed. |

all prs run their required focused proofs through `./scripts/test`; regression
fixes retain observed sensitivity. no blanket reruns or unrelated harness cleanup.
deployment and any host spending require a concrete reviewed artifact/profile;
neither is authorized by this planning change. if no compatible fallback can pass
qualification, stop and review forward recovery before rollout.

## later work, separate approval

these are candidate boundaries, not another authorized migration programme.

| pr / outcome and scope | dependencies and reuse | acceptance | rollback |
|---|---|---|---|
| 7. preserve pending hosted progress across teardown/outage. | incident closed; existing cursor cas and pending-write primitives. reconcile current-main reader repair before extracting code. | interrupted/unacknowledged write, reopen and account switch preserve intent without stale overwrite or false saved acknowledgment. | compatible previous client; preserve pending records and server data. |
| 8. produce publications additively, one format per pr. no consumer switch. | incident closed; experiment c; existing generations, jobs, storage reservations and backfill checkpoints. | maximum supported fixture fits measured worker limits; interruption resumes; locators/selection semantics agree with source; old readers remain usable. | stop producer/backfill; retain original sources and unconsumed artifacts. |
| 9. switch hosted reading, one qualified format per pr. | matching 8; reuse publication routes, pane sessions and format renderers. | continuous reading, find, selection, citations and accessibility preserved; measured browser/api bounds. pdf keeps its existing binary/range contract unless separately justified. | restore old consumer while its endpoints and sources remain available. |
| 10. upgrade native consumption/conversion without deleting installed work. | corresponding publication qualified; experiment d; existing store, verifier, scheduler and progress authority. | originals stay readable offline; verify before activation; interrupted conversion/reopen preserves progress. host/build proofs pass; waived physical evidence is recorded as unverified. | stop activation/rollout and retain originals; after an incompatible local-db change use explicit forward repair, never promise apk downgrade. |
| 11. retire legacy delivery, per consumer/format. | 9/10 and installed-state inventory prove no remaining dependency. reuse existing negotiated capabilities and retirement owners. | no supported reader needs the old path; unresolved downloads/progress have an explicit disposition; replacement sensitivity and release gates pass. | disable new offers before retirement; irreversible cleanup requires its own reviewed migration-forward plan. |

## focused experiments — proposed, not running

**a. what consumes the api envelope?** start with retained exact-image evidence.
repeat only missing or invalidated comparisons: cold/warm imports, serial images,
977-fragment reader, health probe, provider first use. use one changed allocation
owner per comparison; include python/native allocations and whole-cgroup anonymous
and file memory. done when repeated measurements attribute actionable costs and
support prs 3–5; a production leak need not be invented or proved.

**b. what envelope supports the existing product?** pr 1 must establish enforced
finite input/response bounds. if none exist, return a narrow reader-boundary
proposal before qualifying 5–6; neither the incident fixture nor the largest
stored document establishes a supported maximum. admission alone cannot bound
one unbounded read. freeze a finite workload:
current pane limit and active/speculative requests, maximum accepted content,
provider warm state, image validation, readiness and an overlapping worker job.
fix repeat counts, warm-up, observation duration and numeric growth tolerance in
the fixture before candidate comparison; measure cold start and repeated
navigation/close/reopen. record
numeric slots, deadlines, api/worker/host reserves, latency and retained-growth
tolerances before the final run. done when the same clean candidate passes that
matrix with no memory-limit events and the deployed smoke agrees. failure blocks
release. if the existing reader cannot fit an affordable envelope, return one
measured reader-boundary proposal for review; do not lower supported limits or
silently activate the publication rewrite.

**c. can publication preserve difficult content within bounds?** use the retained
maximum-epub failure and table/header/grapheme/figure tickets. one independently
reviewed boundary fixture per unresolved mechanism, then one composed maximum.
done when semantics and measured capacity both pass, or the exact blocking
representation decision is documented. no general table/query framework study.

**d. can native upgrade without losing installed work?** inventory supported
package/db generations, then interrupt conversion/activation and reopen offline.
done when the compatibility/forward-repair matrix has executable evidence for
each supported transition. physical behavior remains unverified under the user's
handset waiver; any later physical-release requirement is decided explicitly.

## trade-offs and adversarial review

- bounded concurrency means explicit busy responses. removing image retention
  costs extra network/validation work; measure latency and upstream request cost.
  extra ram may still be necessary; price the measured profile before selecting it.
- small migrations retain old endpoints and duplicate artifacts temporarily.
  that storage/maintenance cost buys a real rollback. permanent dual stacks are
  not a goal; retirement has its own gate.
- self-review: containment alone leaves the oom; a ram increase alone leaves
  unbounded owners; cold-only import results hide warm cost; old green receipts
  cannot qualify a new combined build. prs 1 and 6 make these distinctions gates.
- self-review: extracting the monolith can import hidden schema/native contracts.
  every pr must name changed interfaces and pass against current-main consumers.
  no publication/native dependency may enter prs 1–6 by convenience. pr 4 proves
  its own operation bound; it cannot depend on pr 5 to pass.
- independent read-only review found three missing gates: an enforced finite
  reader contract, raw intermediary-response regression cases, and usable
  configuration in pr 5 itself. each is now explicit above.
- self-review: “rollback” after destructive migration is fiction. prs 8–10 retain
  originals and defer retirement; incompatible db changes require forward repair.

resume implementation only on an explicit new instruction.
