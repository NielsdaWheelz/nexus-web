# non-palette passage links assume their source survives

full search and raw outline/resource links still format a captured passage’s `source_ref` without local source-liveness proof. a captured passage survives deletion of its authored note source, so those links can point to a removed note even though the retained excerpt is readable.

evidence: `localResourceHref` in `apps/web/src/lib/resources/localResource.ts` formats the source ref; full `useLocalSearch` and raw outline callers supply that route. `node/authored/src/queries.ts` deliberately retains note-source passages in all-scope search, even when the source visibility is false. ordinary resource reads and `activation_ref: null` do not prove source availability.

palette exact refs and the at-most-eight-row preview now resolve their local sources and share the proven destination between row and item. full-search prefixes can exceed the existing resolve limit of 100; do not extend that fix with an unbounded read or a second subscription framework. repair source admission at the shared query owner for these remaining consumers.

resolved when a live note-source passage opens correctly, deleting that same source disables its primary in full search and outline references, and the retained excerpt remains readable. preserve selected-reading and x-capture routes and local authored authority.
