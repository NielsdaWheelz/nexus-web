# public epub assets bypass image admission

- status: open
- origin: 2026-09-14 bounded-workspace stream composition audit at `dd21213bfa`
- area: public resource sharing / foreground memory

`python/nexus/services/public_resource_sharing.py:472-483` accepts assets up to
25 mib and materializes them through `read_object_checked`. the public asset
route at `python/nexus/api/routes/public_resource_shares.py:115-141` uses the
ordinary router and a complete bytes response. concurrent reads therefore
bypass the existing image admission pool. this is a source finding, not evidence
that public sharing caused the reported workspace crash.

prerequisite: the reviewed explicit storage-response close owner. route this
asset endpoint through existing image admission and bounded source streaming;
preserve token/handle masking, allowed types, size authority and public headers.
keep lightweight public bootstrap outside this pool. reuse existing mechanisms.

acceptance: real public asset transfer is bounded, a held read/close retains its
permit, excess image work gets the existing retryable refusal, bootstrap remains
responsive, and unchanged privacy/header/bytes oracles pass. qualify overlap at
the existing accepted asset maximum before claiming its memory profile.
