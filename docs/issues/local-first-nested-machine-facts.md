# expanded resource rows must keep server machine facts

the cutover first rendered an expanded `ResourceOutlineRow` from the local graph only;
the removed `components/resources/ResourceDisclosure.tsx` had shown server facts
(citations, librarian `discovery` / `assistant` links, chat `system` facts,
`document_embed`) under every expanded row.

status: fixed in source, awaiting proof. `components/connections/RemoteConnections.tsx`
is the one server-facts primitive (`useRemoteConnections` + list), filtered by origin on
the server; `ConnectionsSurface` and the row's expanded children both render it beside
`LocalOutline`, separately failable.

resolved when: disposable case "an expanded row keeps its server facts beside its local
links, each failing alone" (`apps/web/.nexus-lab/cases/resource-ui-local-first.spec.ts`)
passes in the lab; then delete this file.
