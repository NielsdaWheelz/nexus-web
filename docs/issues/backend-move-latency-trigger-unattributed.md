# the hosting move's latency trigger remains unattributed

the owner reported faster ordinary reads on the old vps. surveyed sources
`833eb09a7` and `d05d69bd1` have identical lectern, shared-summary, permission,
pool and session code. the database role and restored database changed; their
causal contribution was not isolated.

on `d05d69bd1`, 69 captured checkout refusals took 5.002–5.008 s; lectern reads
took 11.4–15.5 s. later profiling located pathological capture matching and
metadata expansion. the repairs demonstrated equal facts and removed the
observed refusal cascade in the final journey. they do not explain why the
former host ran the old code faster.

private evidence: `~/.local/state/nexus-lectern-latency-20261116/` and the read
repair prs. resolve only from comparable retained plans, statistics, roles and
runtime conditions. do not restart the retained old vps solely for attribution;
that investigation is outside this bounded repair.
