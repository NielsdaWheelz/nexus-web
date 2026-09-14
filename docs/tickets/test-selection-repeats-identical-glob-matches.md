# changed selection repeats identical glob matches

- status: open; local match reuse implemented, proof and timing pending
- origin: 2026-09-14 pr #250, candidate `dd21213bfa`
- area: test-controller selection cost

`selection.py:56-58` matches every indexed route separately;
`_glob_matches` at 248 rebuilds its regex each time. the candidate has 21,762
proof-pattern rows but 702 distinct patterns, across 2,439 changed paths versus
`051a57b780`. repeated matches cannot change the result for one path/pattern pair.

ci run 34896942860's controller pid 606537 was still using one cpu after more
than 13 minutes, with no capability child observed. stack inspection was denied;
this does not establish which frame consumed that time.

reuse each match result within one `SelectionIndex.for_path` invocation, retaining
the original route order and duplicates. no persistent cache or registry change.

acceptance: existing exact path/glob/routing proofs preserve output and rejection
semantics; the actual changed selection completes and retains measured timing.
do not invent a latency threshold or infer a passing gate from source review.
