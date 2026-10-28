# chat context runtime availability contract

the specified disabled remove control for absent local writing is implemented,
but its mounted interaction cannot currently be qualified through the real app.
there is no observed reachable removal failure.

`apps/web/src/lib/notes/hooks.ts:8–10` declares a nullable runtime, while
`apps/web/src/lib/authored/provider.tsx:16` returns a nonnull account or throws;
the provider mounts descendants only after its store is ready. consequently,
`apps/web/src/components/chat/ChatContext.tsx:149–152` cannot receive the null
state through that owner. disabled activation, tooltip and description were
reviewed against the shared control, not exercised in a mounted context row.

resolve the owner contract: if mounted runtime absence is supported, expose its
real lifecycle state and qualify disabled activation, accessible explanation
and recovery. if it is impossible by design, make the runtime contract nonnull
and retire the unreachable consumer branches. do not add a test-only provider
or invent a runtime failure solely to satisfy this check.
