# library list latency

canonical library entry reads took about 2.1–2.3 seconds per 100-row page
against the disposable catalog fixture (2,597 media, 77 libraries). repeated
pagination therefore made the comprehensive phone oracle impractical. the
complete catalog export itself took about 547 ms on this fixture.

evidence: qualification worktree lab `20261023-155201-8d2beb12e3cf`,
`api.log`, 2026-10-23 23:03:30–23:03:45 utc: repeated
`GET /libraries/db6a86c4-9818-4ad0-9703-d0deae39d378/entries`, all 200,
`duration_ms` 2074–2249. concurrent labs were running; this is an observed
latency, not an established query-plan defect or production measurement.

profile the existing library-entry and summary queries on a comparable fixture;
separate database, per-item projection and contention costs. resolved when the
cause is established and repeated canonical page reads meet the documented
interactive budget without weakening visibility, counts or ordering.
