# catalog refresh blocks api reads

`Catalog.read()` awaits the codex refresh before composing any route
(`python/nexus/services/generation/catalog.py:151`); `fetch_codex_catalog()` has
a 120-second bound (`_FETCH_SECONDS`). a present, unresponsive host can therefore
delay otherwise configured provider-api catalog reads. a missing socket fails
immediately. this is source evidence, not an observed stalled-host run.
the web proxy's 30-second deadline (`apps/web/src/lib/api/proxy.ts:226`) can expire
before that refresh finishes, so a browser need not receive the composed rows.

the provider-catalog repair removes the absent-host composition failure but
retains refresh timing. choose a bounded catalog-response contract and separate
source refresh ownership if latency isolation becomes required. prove an actual
unresponsive codex host cannot hold available api choices beyond that bound,
without stale models becoming selectable or substituting a selection.
