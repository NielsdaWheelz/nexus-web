# nexus usage provenance columns have no reader

status: deferred (owner decision) · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web), verified finding F7 · area: nexus history / schema

`nexus_usages.source`, `created_at` and `updated_at` are written on every selection and
never read for behaviour. the web sends `source` (`NexusSource` in
`apps/web/src/lib/nexus/model.ts`) only so the server can store it; `GET /me/nexus-history`
echoes `recent[].source` and `recent[].last_used_at`, and the web reads only `target_href`
and `label_snapshot`. nothing reads the `POST /me/nexus-selections` response body
(`use_count`, `last_used_at`). no reader in python, android, the extension, scripts or sql
outside `python/nexus/services/nexus_history.py`.

impact: one request field, three stored columns and two echoed fields of provenance
telemetry with no reader. dropping the columns deletes stored user data, so the owner
decides.

fix (if accepted): drop `source` from the request, the stored row and the history
response; drop `created_at`/`updated_at` with a migration; shrink the selection response to
what the replay memo needs; regenerate `wire.gen.ts`. the request hash changes with the
request shape, so a Retry that spans the deploy answers 409
`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`, which the client treats as a defect. delete the
`Nexus.SelectionRecord` memos in the same migration.

resolved when: the owner has decided, and either the columns are gone or this ticket is
deleted as "keep".
