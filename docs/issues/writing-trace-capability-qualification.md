# writing trace capability is unqualified

run27 at `e1b0dc396`, lab `20261021-211824-0e63eb114235`, loaded all 10,000
edges, eight mounted retained panes, 200 rows and the formatted 50,000-codepoint
body. before the first measured input, `writing-performance.spec.ts:372` received
an empty `Tracing.getCategories` result. all latency sample counts remain zero;
this establishes an instrumentation failure, not a missed application budget.

qualify the installed chromium/cdp session and actual lossless presentation
events in a small disposable real-browser journey before repeating the full
fixture. preserve exact frame/layer identity, complete-content presentation and
all counts and budgets. resolved when actual desktop and android traces qualify
the required samples; source review or category enumeration alone is insufficient.

run28 at `493e5f3e0`, lab `20261021-215959-c04baf6e2485`, collected 48,665
lossless trace events despite empty category enumeration. the real canonical save,
trusted input and both passive exact-body observations passed. the keyboard decoder
expects `args.event: KeyPressed`; actual chromium 156 emits
`args.event_latency.event_type: KEY_PRESSED`. the writer frame qualified, while the
observer failed the post-body main-frame rule. inspect actual frame/commit lineage
before correcting that rule; do not substitute elapsed dom time for presentation.
the tiny probe failed and cleaned up normally. full latency samples remain zero.
