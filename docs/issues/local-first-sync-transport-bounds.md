# authored replication must fit the existing bff

target qualification gap: local commands and the initial full-corpus snapshot
must cross the actual deployment transport without stranding committed writing.

evidence: `deployment.md` places the bff on vercel; its documented function
payload limit is 4.5 mb. the generic api proxy uses the json lane; the existing
stream lane has a 280-second lifetime. a 16 mib authored envelope is unsuitable.

the [specification](../local-first-writing-spec.md) chooses 2 mib encoded atomic
changes, 3 mib total envelopes and a dedicated streaming snapshot route. resolved
when current-data preflight fits these limits and 100,000 realistic edited blocks
provision through the real route within its deadline; interruption cannot publish
a partial corpus. account for base64/wrappers. no silent truncation or post-save
size refusal. source: [vercel limits](https://vercel.com/docs/functions/limitations).
