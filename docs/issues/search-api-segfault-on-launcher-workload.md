# api exits during launcher search

status: open; original fault unattributed. the owner accepts measured stability
on the selected stock-asyncio runtime for release, with residual uncertainty.

private browser213 on raw212/api `b58e76a9` exits139 during the tenth launcher
action. that is consistent with sigsegv; no stack survives to identify the native
fault. the first ten direct requests return200. before the crash, six lexical
requests hit their owned deadline while nine hybrid requests succeed. the tenth
lexical/hybrid pair receives502 after direct completes. repeated cancellation is
an exercised path, not an established cause.

postgres records zero oom events and stops cleanly. docker reports api
`oom_killed:false`; its last sampled peak is336,994,304bytes, but final api cgroup
counters were lost. do not infer the faulting allocator or request from those facts.
all22 full keyword and20 related observations complete before this failure;
their p95 values are1,182.1/2,514.2ms. the launcher has only10/9/9 usable phase
metrics and cannot establish any20-observation p95, including revised budgets.

all owned resources and copied runtime credentials are removed. the failed
receipt remains immutable; the clone is quarantined because post-run metadata
verification did not execute. private evidence:
`.nexus-local/search-qualification/runtime213-client/`, host receipt
`29d4999ff563bf99c37c0e48481adb3e44293762744c4fb1606774ce4f2dc7bd`.

diagnostic214 reproduces on action7 without the preceding full cohort and without
a target504: six keyword/hybrid pairs succeed before the seventh pair gets502.
restored background work remains present. fault capture shows abort first, then
segmentation fault; no allocator error or native assertion precedes them. both
current-thread python stacks stop at the event-loop runner. loaded native modules
do not establish culpability. there is no justified dependency repair yet.

214 fixes crash-log retention: continuous and final api logs preserve the actual
fatal reports; all owned services and credentials retire normally. fresh read-only
metadata agrees before/after and with201. this releases the clone for diagnosis,
not release acceptance or a new full canonical audit.213 stays failed and unchanged.
214 receipt: `1eeea98743fc5a86b05f5e317b51d0b7b7b69c3b6e5e3586d6bf459a3da8c66f`.

debugger219 stops after one action on an unattributed pending background request.
debugger222 omits that idle precondition and completes ten busy actions without a
fault. both change timing and give the debugger/api a combined640mib allowance;
neither establishes stability under the384mib api limit. no native owner is
identified. the debugger launches its own child; fatal signals are caught without
delivery or a core dump. debugger work is stopped.

the bounded224 comparison ran the same ten busy actions once per loop with
`httptools` and the original384/512mib limits. uvloop returned30/30 target200
responses; stock asyncio returned28/30 target200 responses and two owned lexical
timeouts. both api processes stopped normally. this does not identify the native
fault or prove that asyncio prevents it. api launch commands now choose stock
asyncio as a candidate, without changing the http parser or dependencies.
preserve the original failures and historical faster latency verdicts; release
still requires the complete browser cohort against provisional500/2000/4000-ms
warm targets, cold and publication checks. this was the historical requirement;
the owner revised the crash gate below.

current closeout, 2026-10-23: complete browser225 on selected stock asyncio
finishes the fixed22 full-search and20 launcher interactions without a native
crash and passes revised500/2000/4000ms visible warm p95 gates. six independent
launcher lexical requests return504; complete hybrid responses supply usable
keyword delivery. this is observed qualification of that workload/runtime, not
proof of the original fault's cause, repair or prevention. the causal-resolution
criterion remains unresolved as a defect-resolution condition.
cold237's single control measures2191.5/3104.6ms within owner-accepted3000/4000ms
bounds; it is neither a cold percentile nor native-fault diagnosis. static and
all three retained integration checks pass. closed253 has no native crash or oom
and preserves canonical/native state, but fails the single-attempt book gate;
search/merge overlap remained unproven in that historical run. subsequent
controlled qualification establishes a single publication attempt, prompt durable
unrelated edits and a keyword request overlapping observed native merging.
the affected browser/publication verification also passes; none of these
observations explains the original native fault. see
[the release limits](release-search.md).
screen-reader and unrestricted-worker qualification remain explicitly owner-deferred. preserve the original fatal
reports and every historical failure.

owner decision, 2026-10-23: accept the selected runtime's measured stability for
release while retaining this defect. causal attribution is no longer a release
gate. this accepts residual stability uncertainty; it does not establish the
original fault's cause, repair or prevention. resolve this issue only with an
attributed fault and justified repair, preserving the historical fatal reports.

the historical failure images were absent on inspected daemon `ff10…` before
current allowlisted cleanup. absence supplies no crash attribution or repair
claim. source250, verified `f92` backup and retained canonical95 data preserve
rebuild inputs; exact current images must be rebuilt for environment-specific
qualification. current routine verification uses the
[mac docker desktop lab](../local-rules/testing-standards.md); paired production
endpoint/client configuration is deployed and preserved by the search release.
