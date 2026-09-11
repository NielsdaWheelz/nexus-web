# The Imports summary counts a row its own page read would reject

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain P (OI-024 fix), 2026-09-09
**Area:** `python/nexus/services/imports.py` (`_item`, `_state`,
`read_import_summary`)

## What is wrong

Every Imports defect check is now per row, raised where a `RowMapping` becomes
an `ImportItem`: the foreign queue operation and the duplicate exact reindex job
in `_item`, the `failed` media content index added beside them, and
`assume_safe_failure_code` inside `_state`.

`read_import_summary` materializes no row. It counts `classification` over the
same CTE and returns the badge, so a viewer whose backlog contains a state no
owner transition produces still gets a summary computed from that row, and the
defect surfaces only when a read materializes it. A row that classifies
`Complete` is materialized by the History view alone, so the attention and
progress views a reader lands on stay silent about it.

Until this phase the `failed` index case was the exception: it classified as
`InvariantDefect` and `_require_no_invariant_defect` counted that variant
set-wise, in the summary read as well. Moving the check to ingress made it
precise — every `failed` media index is now rejected, not only one beside a
missing dead job — and narrowed where it is looked for.

## Prerequisites

None. The impossible-row predicates are already expressed over the `imports`
CTE (`index_status`, `source_job_kind`/`source_job_exact`,
`exact_index_job_count` are all selected into it).

## Proposed fix

Give the summary read the same rejection: one `count(*) FILTER (...)` over the
impossible-row predicates beside `needs_attention_count`/`active_count`, raising
the same `AssertionError` (`justify-defect`) before the counts are returned —
or state explicitly, in the module docstring, that the summary is a count of
classifications and that defect detection belongs to the reads that render rows.

## Acceptance

A media whose content index reports `failed`, whose attempt names a foreign
queue operation, or whose current revision has two exact reindex jobs is
rejected by every Imports read that observes it, or the summary's silence is a
stated property with a named owner.
