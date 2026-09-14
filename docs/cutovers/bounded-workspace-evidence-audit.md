# bounded workspace: evidence audit at pause

status: audited 2026-09-14; work closed for now, implementation paused.
source: `8f2e78c86d53808af8545f4c8d96c9429aa23a49`, `codex/bounded-workspace`.
[replacement plan](production-crash-replacement-plan.md) · [preservation inventory](../archive/bounded-workspace-2026-09-14/README.md).

this audit describes the preserved implementation branch, not current main.
[pr #250](https://github.com/NielsdaWheelz/nexus-web/pull/250) is closed as
superseded; this documentation handoff transfers no implementation.

## verified findings and their limits

| finding | evidence | what it does not establish |
|---|---|---|
| production api exhausted its 320 mib container limit six times. the last kill immediately preceded the reported contributor/navigation 502s. | [incident ticket](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/tickets/second-tab-production-api-restarts.md): exact image, kernel kill times, container identity and caddy requests. | host exhaustion, a particular leak, or the allocation responsible for each kill. the 303 mib process sample was warm, not a startup baseline. |
| raw gateway failure can become a workspace-wide defect. | [gateway ticket](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/tickets/second-tab-gateway-outage-classified-as-workspace-defect.md): browser/bff classification and shell-mounted search; [council diagnosis](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/cutovers/second-tab-crash-council-review.md). | title length as this incident's cause. navigation without a new pane contradicts that explanation. |
| imports, whole-reader materialization and resident images consume concrete resources. | [imports](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/tickets/second-tab-eager-provider-sdk-imports.md), [reader response](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/tickets/second-tab-reader-content-response-budget.md), [image cache](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/docs/tickets/second-tab-image-proxy-api-memory-budget.md). | a complete allocation profile or the savings of the final candidate. |
| exact-image reader overlap reaches the cap. | runtime receipt `116374034d1e2ed5`: 977 fragments; idle 259,670,016 bytes; one/two/four-read peaks 289,906,688 / 316,047,360 / 335,544,320; 48 memory-limit events. | this stage returned 200 without an oom kill; it did not reproduce the complete incident. |
| retained images can exhaust that image's budget. | `254fb4ec1c47dcfc`: six serial 10,447,363-byte synthetic images succeed; seventh loses connection; exit 137, one oom kill. | those synthetic images were present in production. |
| early candidate limits were insufficient; later partial passes are provisional. | runtime dossier: `bd1dc4955ce312e3` kills the api with two images/two readers; `0103cec1174b644e` passes narrower admission on a dirty candidate; later provider-warmed trials cover only their recorded workloads. | a qualified replacement limit, stable final working set or a complete release pass. |
| maximum publication preparation remains unqualified. | `790372c5d74b0ca6` at `fe6e19db5e`: epub worker peak 470,482,944 against 469,762,048-byte limit; 1,026 limit events; overall fail. | dense tables, figures and grapheme boundaries were not qualified by that unbroken-ascii fixture. later archive-retirement changes were unmeasured. |
| current source is preserved, not release-qualified. | `8f2e78c86d`; preview builds at `8f2e78c86d` and previous `2f37025d74` succeeded. `b45be17460a6b9cc` passed policy/static and 209 kernel cases before a doctor-fixture failure. the fixture fix at `8f2e78c86d` was not rerun. | preview build, selected passes and source review are not combined capacity/native/production acceptance. |

receipt ids resolve through the [committed index](https://github.com/NielsdaWheelz/nexus-web/blob/d8d2851b0243c40a3868b313b33422efbc785459/testdata/evidence/bounded-workspace-receipts.json)
and archived artifact links. original verdicts remain intact: 685 receipts,
417 pass / 264 fail / 4 not-run. a passing case inside a failed run does not
change its verdict. registration, digest pinning and patch applicability do not
establish observed fault sensitivity.

## decisions, assumptions and unresolved questions

**accepted direction retained:** keep the stack and existing authority boundaries;
contain availability failures locally; bound expensive allocation/concurrency;
preserve acknowledged work and original sources. implementation/reviewer fixes
are retained for reuse, not automatically approved for production.

**accepted execution instruction, now controlling:** stop implementation; preserve
without merging/discarding; replace the monolithic delivery plan; prioritize a
measured complete crash fix. publication/native requirements are parked, not met.
the physical-handset waiver is an explicit user decision; it never meant native
behavior passed. host/build/release evidence remains separate.

**assumptions to test:** a modest envelope can support current reader contracts;
provider-boundary and image-ownership changes remain useful against current main;
retained fixtures represent the supported maximum after the current contract is
inventoried. none of these is a measured conclusion or authority to reduce limits.

**unresolved:** enforced finite reader bounds; final api/worker/host budgets and price; allocation contributions
under combined warm workload; retained-growth and latency bounds; current-main
reuse/dependencies; difficult publication representations and installed native
upgrade/rollback behavior. these map to experiments a–d in the replacement plan.
reader-cursor durability and search timeout remain independent tickets, not proven
causes of the production kills.

## document disposition

the paths below refer to the frozen implementation archive, not this branch.

| documents | interpretation after this audit |
|---|---|
| `second-tab-crash-council-review.md` | historical production investigation; corrected oom diagnosis retained. its “no implementation” refers to its date. |
| `workspace-architecture-from-first-principles.md` | proposed architecture/philosophy; no measured saving or approved incident prerequisite. |
| `bounded-workspace-implementation.md` | superseded execution plan; retain requirements as historical design candidates. `<qualified>` values are unresolved, not defaults. |
| `bounded-workspace-{progress,client-progress,runtime-progress,publication-progress}.md` | chronological source and run dossiers. early “no commit”/“in progress” text is historical; current pause/source above controls. |
| `bounded-workspace-adversarial-review.md`, its trade-offs file, and `bounded-workspace-registry-review.md` | historical reviewer findings and dispositions. “no pr”, “uncommitted”, missing-receipt inventories and old pins are dated checkpoints. later reconciliation does not retroactively qualify their runtime claims. |
| `docs/architecture.md`, module docs and test rules | contracts of the preserved source; not evidence that production implements or satisfies them. future small prs update only their actual changed contracts. |
| incident/migration tickets and `docs/outstanding-issues.md` | open-work register remains authoritative. no unresolved item is closed merely because implementation exists or its migration is deferred. |

## stop and preservation evidence

coding agents are interrupted or completed. local controller pid 875002 was
interrupted while waiting for the shared lock, before pytest; no test verdict
was produced. owned ci run [34902212871](https://github.com/NielsdaWheelz/nexus-web/actions/runs/34902212871)
finished cancelled; runtime and generated-build cleanup succeeded. artifact upload
was skipped; the workflow status/log are archived instead of inventing a receipt.
foreign runs and resources were untouched. no new product tests or experiments
were started for this audit.

all implementation and claude fixes in the delivery branch are preserved at the
source above. useful drafts, exact receipt bodies, available artifact bytes and
historical worktree deltas are archived with hashes. another 502 uncited run
summaries and their available referenced files are preserved separately. those deltas are inactive
preservation material, not a new merge or delivery candidate.

independent plan review was read-only. its three findings (finite reader bounds,
raw gateway-response coverage, and admission startup configuration) were applied
to the replacement plan; it found no additional evidence-audit presentation blocker.
