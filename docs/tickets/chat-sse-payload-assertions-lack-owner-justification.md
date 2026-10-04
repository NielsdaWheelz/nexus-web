# chat sse payload assertions lack owner justification

status: open. origin: 2026-10-04 review of pr #495 at `f9c35967`; area: chat public sse ingress.

`apps/web/src/lib/api/sse/events.ts:194–244` narrows unknown transport data to nine generated payload/domain types without `justify-type-assertion`. `docs/rules/overrides.md:25–28` requires that token, the safety invariant and why safer typing is unavailable. `docs/local-rules/typed-wire.md:64–68` forbids duplicate same-deploy decoders but grants no assertion exemption. previous static passes do not satisfy this source rule; the runtime proof remains valid.

the older legacy parser also asserts its guarded shape at `events.ts:144` and redundantly asserts a string after its `typeof` guard at `:170`. retain payload-local assertions so the compiler still checks each named event wrapper. add nine truthful writer/public-projection justifications and one legacy-shape justification; remove the redundant scalar assertion. do not group the wrappers behind a whole-union assertion or add helpers, parsers or schemas. preserve the context/ref conversion, legacy delta, advisory, ids, values, framing and private-audit exclusions.

the separate private preview is `/tmp/nexus-cleanup-20261004-chat-sse-assertion-preview.patch`, sha256 `c596de60875dc164b880f58c71a91c4d3691a701b9a1c75703b5758de923987d`. it adds ten authored/all-source lines and no generated lines; removing its comments and restoring the erased scalar assertion reconstructs the original file exactly. acceptance: all remaining unsafe/narrowing assertions in this decoder have truthful local markers, scalar narrowing compiles, and `./scripts/test` passes. runtime expressions do not change; no worker or live rerun is proposed.
