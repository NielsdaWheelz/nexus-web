# authored replication must fit the existing bff

remaining release gap: preflight the current corpus against the encoded command
limits. the 100,000-note server transport and memory qualification passed.

evidence: `deployment.md` places the bff on vercel; its documented function
payload limit is 4.5 mb. the generic api proxy uses the json lane; the existing
stream lane has a 280-second lifetime. a 16 mib authored envelope is unsuitable.

the [specification](../local-first-writing-spec.md) chooses 2 mib encoded atomic
changes, 3 mib total envelopes and a dedicated streaming snapshot route. resolved
when current-data preflight fits these limits. account for base64/wrappers. no
silent truncation or post-save size refusal. source:
[vercel limits](https://vercel.com/docs/functions/limitations).

at `e2f9a0c30`, canonical lab `20261025-222300-2fe9f6b5281e` streamed
100,000 realistically sized notes, each edited eight times: 219,541,458 bytes
through the actual verified h2 bff in 223.5 seconds, within 280 seconds.
a separate production api plus node 22 process streamed the same snapshot in
181.9 seconds while accepting edits to 50 existing notes, under the unchanged
384 mib/no-swap limit; peak cgroup memory was 224,292,864 bytes, with no oom.
these are separate paths, not a bff-through-capped-api measurement. this arm64
server proof does not establish client provisioning, indexing or responsiveness.
