# bounded service output can lose the primary assertion

- status: open; exact failed testcase verdict unavailable
- origin: 2026-09-14 bounded-workspace deadline proof
- area: test controller / retained failure evidence

web proof run `7b9fcecb0a209f5f` at `f075c680ed` failed the actual
`test_sync_read_deadline_retains_its_transaction_and_permit_until_worker_returns`
case. its retained `service-1.log` begins midway through a captured middleware
trace and ends with the expected deadline RuntimeError plus the generic pytest
failed-case list. the primary pytest assertion and traceback were discarded.
`summary.json` records only the capability failure. the run contains no junit
or other structured testcase result; all retained artifacts were inspected.

this is insufficient to identify the first actionable failure or claim the
intended regression assertion was observed. increasing the diagnostic tail
alone does not establish a bound that preserves primary evidence.

preserve a bounded structured testcase failure alongside the existing log tail,
using the current service execution/artifact owner. do not change the product
proof oracle to manufacture an expected fingerprint.

acceptance: this same failed service case retains its actual exception type,
assertion message and owned frame even when captured application logging
exceeds the log-tail bound. setup failures remain distinct from assertions;
retention remains bounded.

reviewed implementation now retains real pytest phase/type/message/frame in
a bounded marker record, with redaction before encoding and strict incomplete
evidence classification. the same failed deadline case and reporter sensitivity
remain unrun on the combined candidate. do not close this ticket from source
review alone.

focused run `c7f4c2b64f39176f` at `0d3b2164aea65bf06f5948b31ecb1e59e58e1f11`
reached the reporter privacy proof after selected python static checks passed.
structured records redact correctly, but pytest's terminal-width summary retains
`local-"sec...` from the artificial canary. the complete secret is already lost
before parent redaction. the correction discards that truncated duplicate line's
message and node; the structured record remains authoritative. a node can itself
contain the summary delimiter, so retaining a guessed node prefix is unsafe.
the original thirteen cases and a parameter-id case must pass before acceptance.

all fourteen reporter cases pass within `b45be17460a6b9cc` at `2f37025d74`.
this includes the original privacy regression from `c7f4c2b64f39176f`.
the combined run retains its actual later doctor-fixture assertion and source
frame. the original held-thread service case and full reporter BASE witness
remain pending; the enclosing run is not green.
