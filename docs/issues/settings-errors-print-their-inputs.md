# a settings validation error prints its raw inputs, credentials included

status: open · origin: 2026-10-20 migration rehearsal · area: config / logs

problem: `Settings` (`python/nexus/config.py:44`) leaves pydantic's
`hide_input_in_errors` off. when `_validate` (`config.py:154`) raises, the
`ValidationError` text carries `input_value=` the whole environment-sourced settings
dict, cut down to its first and last characters. in the reproduction below it opens
with `nexus_internal_secret` and closes with `database_url`, so the tail of the
database password and its host reach the message; a secret at either end leaks.

impact: any process that fails settings validation writes that text to its log.
the release log could carry it: `0293` enqueued jobs through `nexus.jobs.registry`
(→ `get_settings()`), so a migration process without complete settings failed there.
0293 no longer loads settings, and `./scripts/test` now refuses a migration that
imports `nexus`, so the migrate step cannot reach it again. api, worker, scheduler
and cli startup still can.

evidence: the 0293–0303 rehearsal on 8a67e218a, log
`nexus-web-campaign-artifacts/2026-10-14/rehearsal/r0293-0303/logs/upgrade-0293-1792513811.stderr`
(its `Value error` line, redacted in place to `input_value=<redacted: settings dict>`). a
scratch reproduction with a sentinel `DATABASE_URL` and the three supabase keys unset
prints `input_value={'nexus_internal_secret':...ASSWORD@127.0.0.1:9/db'}`.

proposed fix (one line, at the owner): `hide_input_in_errors=True` in `Settings`'
`SettingsConfigDict`. the same reproduction then ends the message at
`[type=value_error]`, its explanation intact.

resolved when: `Settings()` with a sentinel `DATABASE_URL` and the supabase keys
unset raises a message that contains no part of the sentinel.
