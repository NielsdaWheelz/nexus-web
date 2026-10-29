# framework security release qualification

release scope 6 selects next/eslint-config-next 15.5.28 and sharp 0.35.5 in
`apps/web/package.json` and `apps/web/bun.lock`. the existing two-output
response-header patch remains necessary and is retained without byte changes.
[advisory assessment and contract](../framework-security-update-spec.md) owns
applicability; [api edge](../modules/api-edge.md) owns the serving invariant.

[next 15 maintenance](https://nextjs.org/support-policy) runs through
2027-01-31. the compatible patch choice accepts that limited maintenance
runway; a major upgrade is outside this release scope.

remaining release gates:

- bind qualification to the final integrated source sha and its `/version`;
  a prior branch artifact does not qualify a later release artifact.
- on the normal linux/managed-hosted build, establish the installed sharp/native
  package and libvips versions and a successful allowed local-plate optimizer
  read. a darwin/arm64 package load does not establish linux packaging.
- qualify the matching staged hosted edge: real password login, separate cookie
  effects, canonical redirect and session renewal, gzip `/api/llm-catalog` json,
  and `/api/stream/writing` delivery/cancellation. inspect that artifact's
  generated action and prerender surfaces. a hosted static check alone proves
  none of these runtime observations.

use the normal pr preview if available; otherwise these remain explicit final
integration gates. no new deployment path, ci runtime harness, production probe,
account change or native qualification is implied. remove this issue when the
selected release artifact supplies those observations. local proof belongs in
the pr body and private receipts.
