# publication note check waits for admission

on `b5234285`, the strict operation's note-search request returns504 after1515.8ms,
including1494.7ms waiting for shared admission. it never enters an admitted
snapshot, indexed retrieval or presentation. durable note get/reread proofs pass,
but the existing updated-note searchability gate remains unproved; this is not
evidence of an indexing defect.

private evidence: strict archive `defb1`, correlated api interval
2026-10-25T10:15:29.227229Z–10:15:30.743019Z. the admission holder is unknown.
the publisher's standalone verifier can hold admission, but no recorded join
establishes it as this request's blocker.

resolved when the expected updated-note api read completes under the intended
workload, preserving shared admission and memory limits.
