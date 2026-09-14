# browse query corruption still needs its sensitivity replay

- status: open
- origin: 2026-09-14 bounded-workspace fault registry reconciliation
- area: pinned tool contract / provider request identity

the duplicate `browse-provider-query-round-trip-bypass` registration claimed
the same canonical proof as `llm-tools-legacy-browse-owner-bypass`; policy
correctly rejected it. remove that duplicate and its obsolete patch, preserving
the original canonical fault and every query assertion in
`python/tests/llm_tools_contract/test_pinned_llm_tools.py`.

the distinct query witness is still needed: at the current request constructor
in `python/nexus/services/browse/brave.py`, change `query=query.query` to
`query=f"{query.query} altered"`. the reviewed auxiliary is
`/tmp/fault-owner-reconciliation/browse-query-auxiliary.patch`, sha256
`5e2d217da233f9d174f4c886cf2c213d605a0d647ee23d31e788b473dd3b4dd6`.

acceptance: an owned paved auxiliary run observes the existing named query
assertion with that mutation, then passes with the original source. restore
source before committing; do not add an alias or a second canonical fault.
