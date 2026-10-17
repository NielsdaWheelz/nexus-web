# release: resource actions (fetch-on-open menus)

the commit "reauthor resource actions around fetch-on-open menus" ships with the campaign's
one release; it adds no step of its own beyond these.

- **no migration, no env change, no preflight, no owner step.**
- **wire**: breaking for the web only. `POST /resource-items/action-snapshots/resolve` and
  `POST /resource-items/locators/resolve` are gone; `GET /resource-items/{ref}/actions` and
  `GET /resource-items/{ref}` replace them; `ResourceItemOut` loses `route` and
  `capabilities`; `ResourceActivationOut` loses `unresolved_reason`; openables search sends no
  `Server-Timing`. the final combined release uses `X-Nexus-Wire: 2`.
  an open tab from before the deploy fails its menus
  until it reloads. the apk never calls `/resource-items`.
- **post-deploy smoke** (owner or release session): open a media row menu and a page menu
  (one `GET …/actions` each, loading row first); Edit title… lands in the page with the title
  focused; delete a scratch page from the notes index (the row leaves, no navigation); open a
  highlight menu in the reader and Edit highlight…; Add note… focuses the note editor.
