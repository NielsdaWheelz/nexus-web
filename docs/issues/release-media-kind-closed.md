# release closed media kind

`media_kind` is `MediaKind | None`, not `str | None`, on `NamedResourceBodyOut` and
`SourceAttributionOut` (`python/nexus/schemas/resource_items.py`) and on
`CapturedSource` (`python/nexus/schemas/resource_evidence.py`). the wire bytes do not
change, so `WIRE_REVISION` stays and no apk pairs. the apk serves its own web bundle, so
the phone shows the new glyphs and nouns only from its next signed build.

impact: a stored kind outside `MediaKind` now fails validation where it is read. in
the frozen evidence of `message_retrievals`, `messages` and `resource_edges`, it
breaks the citation, quoted-turn and connection reads that hold it, and new replies in
a conversation that quotes it. in `media.kind`, it breaks `source_attributions`, and
so every search hit and citation capture naming that media. `media.kind` has had no
check since 0316, and `docs/rules/database.md:85` keeps it that way: the application
is the only guard.

preflight, before deploy, read-only on production. it must return no rows.

```sql
SELECT DISTINCT store, kind FROM (
  SELECT 'media.kind' AS store, kind FROM media
  UNION ALL SELECT 'message_retrievals', captured_evidence#>>'{source,media_kind}' FROM message_retrievals
  UNION ALL SELECT 'messages', reader_selection_snapshot#>>'{evidence,source,media_kind}' FROM messages
  UNION ALL SELECT 'resource_edges', snapshot#>>'{evidence,source,media_kind}' FROM resource_edges
) stored
WHERE kind <> ALL(ARRAY['web_article', 'epub', 'text_part', 'pdf', 'video', 'podcast_episode']);
```

any hit stops the release. repair it first with a migration that converts or nulls it
and raises on what it cannot. never widen the type.

resolved when the empty result is recorded in the release pr and the deployed api
reads citations, a quoted chat turn and connections without a validation error.
delete this record then.
