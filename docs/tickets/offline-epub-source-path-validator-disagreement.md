status: open
origin: 2026-09-12, reader document map cutover final native review
area: offline epub source identity

`OfflineReaderDocumentVerifier.kt:261` constructs `URI(path)` for the persisted
literal archive path. java uri syntax rejects unescaped spaces and literal `%`
without a hex escape. the python `validate_safe_epub_href_path` and typescript
`safeEpubHrefPath` accept these literal filenames. therefore a valid publisher
path such as `chapter one.xhtml` or `chapter%name.xhtml` can pass publication and
web admission but fail native package admission. this is a static boundary
disagreement; native execution has not yet characterized it.

prerequisite: preserve the current decoded archive-path contract. replace the
native uri parser with the same explicit relative-path checks used by the
typescript decoder; do not decode or normalize the filename. separately retain
the reserved `#`/`?` representation repair ticket.

acceptance: shared accepted reader vectors with literal spaces and `%` survive
python, typescript, and native package verification unchanged; origin, query,
fragment, and traversal rejection remain strict.

implementation: native now checks literal path components, scheme prefix, and
reserved delimiters explicitly. python uses the same checks; its previous
`urlsplit` truthiness check admitted empty `?`/`#` suffixes rejected by both other
decoders. shared vectors and execution remain pending.
