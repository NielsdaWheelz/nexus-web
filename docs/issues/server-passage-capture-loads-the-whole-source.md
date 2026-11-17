# a server passage capture loads every passage on its source

found by source review on 2026-11-12 at `125f1ab87`; still present at
`6fc320a75`. no runtime duration or production failure was measured here.

`authored.server_command` loads all `authored_passages` whose `source_ref` matches a
`capture_passage` intent, with no bound
(`python/nexus/services/authored/__init__.py:720-735`), and sends them to the helper.
the helper's input is capped at 12 MiB and exits 3 past it
(`node/authored/helper.ts:181-185`, `python/nexus/services/authored/helper.py:64-65`).

linking a search result to a heavily highlighted book therefore loads every
passage on that book. exceeding the helper input cap maps to `E_INTERNAL`; this
is a source-derived failure path, not an observed incident. only passages sharing
the captured key are needed to resolve its binding.

resolved when the load is bounded to the captured keys, or measured as harmless on
the largest source.
