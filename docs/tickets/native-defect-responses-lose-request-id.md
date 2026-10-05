# native defect responses lose request id

status: open · origin: 2026-10-04 cleanup/linear-02 live qualification · area: native error egress

unhandled defects bypass request middleware's response stamping, then reach the
generic handler after logging context is cleared. the generic body loses its
request ID; the documented all-response correlation contract is incomplete.
clients accept an optional ID, so error routing remains correct, but correlating
an unexpected failure with its server log becomes harder.

unchanged owner evidence at `557aed14f1d88bdb2b1bc9856944ce433e38f115`:
`middleware/request_id.py:58–72,93–99` stamps only successful `call_next` return;
`responses.py:95–103,144–169` obtains the ID from cleared context;
`app.py:362–364` incorrectly claims exception-handler output always carries it.
real task-DB fatal/exhaustion controls on source `7d8573e650802a669dd9206bedf4c6a5c8cc2cb0fd4a9c941d5959634e98a742`
returned `E_INTERNAL` bodies without `request_id` in
`/tmp/nexus-linear-02-20261004/candidate-v2-native-receipt.json`; the old modeled
enqueue error had it. native response headers were not retained; their omission
is source-qualified, not a live header observation. no production failure is claimed.

prerequisite: use the existing `request.state.request_id` at the native exception
egress owner, preserving generic messages and defect propagation. no source-error masking.

acceptance: a real controlled unhandled failure returns the same correlated ID
in its native error body/header and failed-request log; modeled and auth errors
remain unchanged.
