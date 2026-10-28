# failed web import titles expose url query values

ordinary web admission uses the submitted url as placeholder title, including
query values that can contain signed access parameters. a failed import retains
that title and exposes it in normal title presentation. source-derived; no live
reproduction.

evidence: `python/nexus/services/media_source_ingest.py:161` sets
`title=url[:255]`; `_new_media` persists it. imports projects
`w.title` at `python/nexus/services/imports.py:236`. the extension's existing
`TargetView.host` in `apps/web/src/extension/capture.ts` deliberately avoids
displaying signed queries.

browser recovery's new summaries use safe host/path labels for placeholders.
the broader fix belongs to source admission and existing placeholder conversion,
preserving authored titles and full urls as navigation/request data. do not
strip query values from source identity.

resolved when importing a denied url containing a test access parameter retains
its exact request url while titles, picker labels and error copy omit that value;
existing placeholder rows are handled without rewriting authored titles.
