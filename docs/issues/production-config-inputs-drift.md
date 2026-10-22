# production configuration inputs drift

on 2026-10-22 the private `deploy/env/env-prod*` inputs differed from the active
`/etc/nexus/current.env`. the local set lacks `NEXUS_HANDLE_KEY`, changes
`DEEPGRAM_API_KEY` and `GENERATION_API_PROVIDERS`, and retains retired keys.
publishing these inputs could replace working credentials/provider settings.
the release preserves the active host config; its auth issuer, audiences,
internal secret and public origins agree with the staged web config.

duplicate declarations and the stale local internal secret were corrected with
private backups, but that does not establish the remaining inputs as current.
no values belong in this record. reconcile the private publisher inputs against
the intended active configuration, remove retired keys, then validate a complete
publication diff. resolved when the inputs reproduce the intended host config
without unintended credential or provider changes.
