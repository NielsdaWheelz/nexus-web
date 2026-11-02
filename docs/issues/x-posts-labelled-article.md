# x posts and mail are called articles

problem: a saved post, thread or email is `web_article`, so `mediaKindLabel` calls it
`article` and its link is announced `article: ...`. the kind cannot say otherwise, and
`MediaSummaryOut` has no provider.

impact: a false noun in accessible names, metadata and pane details on every x capture
and every emailed item. the glyph stays honest as a scroll; only the word lies.

evidence: `apps/web/src/lib/media/kind.ts:9`; `python/nexus/schemas/media_summary.py:43`
carries `media_kind` and `x_article_content` but no `provider`. `provider` reaches only
`MediaOut` (`schemas/media.py:94`), read by `HostedContents.tsx:77`. `_rows` in
`services/media.py:112-169` already selects `provider`, so no query changes. mail is
`web_article` with `provider=email` (`email_ingest_service.py:116-118`).

proposed fix: ride the wire 18 bump in playback lane 3. add one nullable provenance
fact to `MediaSummaryOut`, and name `post` where it is `x` and `x_article_content` is
null, and a mail noun where it is `email`. saved offline catalogs read it as absent until
rebuilt.

resolved when a saved post or email is announced and labelled as what it is on every
surface that holds a summary.
