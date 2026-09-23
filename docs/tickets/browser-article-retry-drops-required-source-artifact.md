# browser article retry drops a required input artifact

status: open · origin: 2026-09-23 firefox v1 review · area: browser article retry

`python/nexus/services/media_source_ingest.py:644` clones source payload through
`source_attempt_artifacts.py:21-27`, which unconditionally removes
`source_storage_path`. the browser adapter requires that field and raises
`Missing browser article source markup artifact.` when absent
(`media_source_adapters.py:553-555`). retry admission checks only `storage_path`
(`media_source_ingest.py:1506-1517`), so it can admit a retry doomed to fail even
when both original source blobs exist. source-confirmed; no live retry was run.

fix: preserve immutable browser input artifacts when cloning retries; distinguish
them from generated per-attempt outputs. validate every required input before
admitting a retry and preserve its reference for storage ownership/cleanup.

acceptance: a browser article that failed processing retries successfully from
its two original inputs without another browser capture; missing input is
reported at admission; generated outputs keep their intended retry lifecycle.
