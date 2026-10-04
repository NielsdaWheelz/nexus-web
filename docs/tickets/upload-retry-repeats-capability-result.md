# upload retry repeats the capability result

status: open. origin: 2026-10-04 source audit; area: media upload retry. priority: p3.

`python/nexus/services/media_upload_sessions.py:417-507` carries the fresh and memoized retry result through a private `_AdmittedRetry` tuple as well as `_Capability`. both carry the same generation and expiry facts. this is repeated representation, not an observed upload failure. the durable memo, ownership checks and retry fences remain necessary.

prerequisite: qualify current fresh/replay capability bytes and expiry against one owned retry fixture. acceptance: use the existing capability result on both paths, delete the redundant private result and tuple, and verify the same accepted/replayed response fields, generation/expiry, admission refusal and durable memo behavior. no new storage or client protocol is needed.
