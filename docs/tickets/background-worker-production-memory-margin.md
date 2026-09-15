# background worker has almost no observed memory margin

status: open · origin: 2026-09-15 ecbe manual observation · area: background memory

## evidence

production ecbe838ede7a3e85ee83d7c76c34c0383f94c43b background container
83cd9b78b3188c2e2ce3460d2f9ff9ee4960cd38ce0ff2aa70c6f73aede4f68e retained
a469659648-byte peak (447.902 mib) under its469762048-byte/448 mib cap by
21:59:55 utc. max/oom/oom-kill/swap counters and restart count remained zero.
this is not an observed oom; it leaves only100 kib between retained peak and
cap. the job responsible has not been isolated. overlapping synapse/metadata
failures do not establish successful representative execution.

private samples: `/tmp/nexus-release-255/production-ecbe838e-cutover-memory.jsonl`
and `production-ecbe838e-after-theme-memory.jsonl`. cgroup lifetime stayed
unchanged; the later lower current charge does not erase the retained peak.

## follow-up and acceptance

attribute supervisor/child allocations during representative jobs and remove
the owning unnecessary retention or bound the operation within the existing
host budget. no resize, reboot or cap increase is authorized by this finding.
record successful representative job completion, retained peak, allocation
composition and event counters with a defensible remaining margin.
