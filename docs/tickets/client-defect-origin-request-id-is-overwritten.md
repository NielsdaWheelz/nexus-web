# client defect origin request id is overwritten in logs

status: local fix; browser ingest pending · origin: 2026-09-25 chat reliability planning · area: diagnostic correlation

`python/nexus/api/routes/telemetry.py:47-50` expands the browser report,
including its `request_id` presence value, into the structured log event.
`python/nexus/logging.py:53-54` then replaces that key with the telemetry
request's own middleware correlation id. the original failed request identity
is therefore lost from the logged report. evidence is source inspection;
no production telemetry was submitted.

keep both identities with distinct names at the telemetry logging boundary:
the normal envelope `request_id` and `origin_request_id` for the browser's
reported failed request. do not change global middleware correlation or add
message/error payloads to logs.

acceptance: a report carrying a known origin request id produces a structured
log with both that id and the different ingestion request id. admission/read
phase, command and run identity remain available for the same occurrence.
