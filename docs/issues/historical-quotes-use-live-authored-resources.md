# historical quotes use live authored resources

problem: an owned highlight or note can replace captured message/citation evidence
with its current local content and navigation. sent highlights also lose captured
prefix/suffix and author attribution. editing the source can therefore change what
an old quotation appears to say or where it opens.

evidence: source audit at `0f7d6ffa65a1a97ae714b1e1a5571c2b119ead96`,
2026-10-28; browser reproduction not run.

- `python/nexus/services/chat/quotes.py:93-99` projects captured evidence with the
  sent message's quote target. `python/nexus/services/resource_items/evidence.py:386-393`
  replaces preview/label/activation while retaining current `authored_by_viewer`.
- `apps/web/src/components/resources/ResourceOutlineRow.tsx:129-140` routes owned
  resources to local reads before considering `historical`. its `AuthoredRow`
  at `:199-229` uses current content/source/href; `historical` only disables editing.
- affected historical callers include `components/chat/QuotedPassage.tsx:66`,
  `components/ui/ReaderCitation.tsx:22` and
  `components/connections/RemoteConnections.tsx:63-66` (web paths relative to
  `apps/web/src`). this violates `docs/modules/chat.md:321-322`.

fix: supplied historical evidence owns displayed content, attribution and exact
activation. prevent local/live replacement at the shared historical dispatch
boundary; preserve local authority for ordinary authored resources. a passive
quotation presenter must consume the supplied evidence directly.

resolved when: send a highlight quote and publish a citation to an owned note;
change their live contents and the highlight's extent/colour, then reopen the
message, citation preview and citation connection. each retained captured item
must keep its saved words/context/attribution and occurrence target; current
resource views must show the edits. unavailable sources/locations must retain
the backend's disclosure and availability decisions. these journeys require a
real disposable application and a citation-producing run. composer preview
revision drift is separately tracked in `quote-preview-opens-newer-highlight.md`.
