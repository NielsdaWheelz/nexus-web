# `couldn’t fetch the page` names a page for files and feeds

status: open · origin: 2026-11-02 import content sheet (slice 2), open point 12 · area: imports / copy

orchestrator ruling 2 gives `E_SOURCE_FETCH_FAILED` the reason `couldn’t fetch
the page` (`apps/web/src/lib/imports/copy.ts:200`). the code is safe_fetch's
catch-all (`python/nexus/services/net/safe_fetch.py:166-177`), raised for web
articles (`python/nexus/services/web_article.py:466`) and also for remote pdf
and epub files (`python/nexus/services/remote_file.py:86`), gutenberg and
podcast feeds, which fetch through `safe_get` (`safe_fetch.py:186`).

impact: a remote pdf link whose fetch fails reads `couldn’t read this ·
couldn’t fetch the page`, which names the wrong thing. the pane's reason says
the same.

resolved when: the reason is true for every fetch the code covers (say,
`couldn’t fetch it`), or the server names a file's and a feed's failed fetch
apart, which the import spec makes a non-goal.
