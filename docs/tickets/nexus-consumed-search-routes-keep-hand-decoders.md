# the search routes the nexus consumes keep hand decoders

status: open · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web) · area: typed wire / search / openables

the launcher rewrite typed the two routes it owns (`GET /me/nexus-history`,
`POST /me/nexus-selections`). the two it reads are still decoded by hand:
`GET /search` in `apps/web/src/lib/search/searchApi.ts` (`SearchContractDefect`) and
`POST /resource-items/openables/search` in `apps/web/src/lib/resources/openableResources.ts`
(`ResourceOpenablesContractDefect`). `useNexusFind.ts` throws both defect classes into the
workspace boundary. per [typed-wire](../local-rules/typed-wire.md) the owning slice types
its routes; the Nexus does not own these.

impact: two hand decoders and two defect classes that the generated wire would replace.

prerequisites: the search and openables slices' rewrites.

fix: give both routes response models, regenerate `wire.gen.ts`, replace the decoders with
`ApiJson` types, and drop the two defect classes from `useNexusFind.ts`.

resolved when: `rg "SearchContractDefect|ResourceOpenablesContractDefect" apps/web/src`
finds nothing.
