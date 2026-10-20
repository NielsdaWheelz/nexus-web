# late menu actions can change the click target

problem: a contextual menu grows after its asynchronous resource actions arrive.
a native-coordinate click chosen from its earlier layout can hit another action.
this is a live verification concern; an adapter coordinate race remains possible.

impact: the intended edit command may instead remove a connection.

the connection-actions cutover removes asynchronous resource verbs from edge and
context menus entirely. that removes the mixed-subject arrangement described
below. resource-root menus still load their resource actions and source-owner
label asynchronously; native-pointer geometry there remains a separate concern.

evidence: isolated reader sidebar campaign on baseline `bebedeae3` plus sidebar
changes, 2026-10-19. an initial menu snapshot had `open`, `edit note on link`,
`open in new pane`, `focus this branch`, `remove link`. a cua locator click on
`edit note on link` produced a successful `DELETE /resource-graph/links/{id}`.
the disposable link was restored through the create command. waiting for a
second snapshot showed four additional resource actions; selecting the same
edit label then correctly opened the `Link note` editor. api request timestamps
were 23:32:40 utc for the deletion; no user data was involved.

reproduce: open an unanchored reader link's action menu near the bottom of its
scrollport, then select edit while resource actions are loading. distinguish
ordinary pointer behavior from the cua adapter's coordinate dispatch.

resolve: prove the target cannot change during pointer selection, either by
stable menu geometry/settled admission or by correcting the adapter if native
pointer reproduction excludes the product. owner: `ContextualActionMenu`.
